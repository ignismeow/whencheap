import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { OllamaIntentParser } from '../agent/ollama-intent-parser.service';
import { GasOracleService } from '../gas/gas-oracle.service';
import { KeeperHubService } from '../keeperhub/keeperhub.service';
import { SessionSignerService } from '../session/session-signer.service';
import { CreateIntentDto } from './dto/create-intent.dto';
import { IntentStatus } from './intent-status';
import { AuditEvent, IntentRecord } from './intent.types';

@Injectable()
export class IntentsService {
  private readonly logger = new Logger(IntentsService.name);
  private readonly intents = new Map<string, IntentRecord>();

  constructor(
    private readonly parser: OllamaIntentParser,
    private readonly gas: GasOracleService,
    private readonly keeperHub: KeeperHubService,
    private readonly sessionSigner: SessionSignerService
  ) {}

  async create(dto: CreateIntentDto): Promise<IntentRecord> {
    const parsed = await this.parser.parse(dto.input, dto.wallet);
    const now = new Date().toISOString();
    const id = randomUUID();
    const intent: IntentRecord = {
      id,
      wallet: dto.wallet,
      rawInput: dto.input,
      parsed,
      status: IntentStatus.PendingIntent,
      createdAt: now,
      updatedAt: now,
      audit: []
    };

    this.addAudit(intent, 'INTENT_CREATED', 'Intent accepted and parsed.', { parsed });
    this.intents.set(id, intent);
    return intent;
  }

  list(): IntentRecord[] {
    return [...this.intents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): IntentRecord {
    const intent = this.intents.get(id);
    if (!intent) throw new NotFoundException(`Intent ${id} not found`);
    return intent;
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async evaluatePendingIntents() {
    const pending = [...this.intents.values()].filter(i => i.status === IntentStatus.PendingIntent);
    if (pending.length === 0) return;

    for (const intent of pending) {
      if (new Date(intent.parsed.deadlineIso).getTime() < Date.now()) {
        this.transition(intent, IntentStatus.DeadlineExceeded, 'Intent deadline has passed before submission.');
        continue;
      }

      let costUsd: number, baseFeeGwei: number;
      try {
        ({ costUsd, baseFeeGwei } = await this.gas.estimateTxCostUsd(intent.parsed.type as 'send' | 'swap'));
      } catch {
        this.addAudit(intent, 'GAS_CHECK_SKIPPED', 'Gas oracle unavailable; will retry next cycle.');
        continue;
      }

      const limit = intent.parsed.maxFeeUsd;
      if (costUsd > limit) {
        this.addAudit(
          intent,
          'GAS_CHECK_FAILED',
          `Base fee: ${baseFeeGwei.toFixed(3)} gwei. Est. cost: $${costUsd.toFixed(4)}. Exceeds $${limit} limit. Waiting for cheaper gas.`,
          { baseFeeGwei, costUsd, limitUsd: limit }
        );
        continue;
      }

      this.addAudit(
        intent,
        'GAS_CHECK_PASSED',
        `Base fee: ${baseFeeGwei.toFixed(3)} gwei. Est. cost: $${costUsd.toFixed(4)}. Under $${limit} limit.`,
        { baseFeeGwei, costUsd, limitUsd: limit }
      );

      // Verify session limits on-chain before committing to execution
      const feeWei = this.sessionSigner.estimateFeeWei(baseFeeGwei, intent.parsed.type as 'send' | 'swap');
      const sessionOk = await this.sessionSigner.canExecuteSession(intent.wallet, feeWei);
      if (!sessionOk) {
        this.addAudit(
          intent,
          'SESSION_INVALID',
          'Session expired or estimated fee exceeds session limits. User must re-authorize.'
        );
        this.transition(intent, IntentStatus.NeedsReauthorization, 'Session limits exceeded or session expired.');
        continue;
      }
      this.addAudit(intent, 'SESSION_CHECK_PASSED', 'Session valid and within limits. Proceeding to execution.');

      // Prefer direct execution (agent wallet) — fall back to KeeperHub if not configured
      if (this.sessionSigner.agentAddress) {
        await this.executeDirectly(intent, baseFeeGwei);
      } else {
        await this.submitToKeeperHub(intent, baseFeeGwei);
      }
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async pollSubmittedIntents() {
    const submitted = [...this.intents.values()].filter(
      i => i.status === IntentStatus.Submitted || i.status === IntentStatus.Confirming
    );

    for (const intent of submitted) {
      if (intent.txHash) {
        await this.pollDirectTx(intent);
      } else if (intent.keeperHubWorkflowId) {
        try {
          const wf = await this.keeperHub.getWorkflowStatus(intent.keeperHubWorkflowId);
          this.applyWorkflowStatus(intent, wf);
        } catch (err) {
          this.logger.warn(`KeeperHub poll failed for intent ${intent.id}: ${String(err)}`);
        }
      }
    }
  }

  private async executeDirectly(intent: IntentRecord, baseFeeGwei: number) {
    try {
      const txHash = await this.sessionSigner.broadcastIntent(intent, baseFeeGwei);
      intent.txHash = txHash;
      this.transition(
        intent,
        IntentStatus.Submitted,
        `Transaction broadcast by agent ${this.sessionSigner.agentAddress}. Hash: ${txHash}.`,
        { txHash, agentAddress: this.sessionSigner.agentAddress }
      );
    } catch (err) {
      this.logger.warn(`Direct execution failed for intent ${intent.id}: ${String(err)}`);
      this.addAudit(intent, 'EXECUTION_FAILED', `Broadcast failed: ${String(err)}. Will retry next gas check.`);
    }
  }

  private async pollDirectTx(intent: IntentRecord) {
    try {
      const receipt = await this.sessionSigner.provider.getTransactionReceipt(intent.txHash!);
      if (!receipt) {
        if (intent.status !== IntentStatus.Confirming) {
          this.transition(intent, IntentStatus.Confirming, 'Transaction in mempool, awaiting confirmation.', { txHash: intent.txHash });
        }
        return;
      }
      if (receipt.status === 1) {
        this.transition(intent, IntentStatus.Finalized, `Confirmed in block ${receipt.blockNumber}.`, {
          txHash: intent.txHash,
          blockNumber: receipt.blockNumber
        });
      } else {
        this.transition(intent, IntentStatus.Stuck, 'Transaction reverted on-chain.', { txHash: intent.txHash });
      }
    } catch (err) {
      this.logger.warn(`Receipt poll failed for intent ${intent.id}: ${String(err)}`);
    }
  }

  private async submitToKeeperHub(intent: IntentRecord, baseFeeGwei: number) {
    try {
      const workflowId = await this.keeperHub.submitWorkflow(intent, baseFeeGwei);
      intent.keeperHubWorkflowId = workflowId;
      this.transition(intent, IntentStatus.Submitted, `KeeperHub workflow triggered: ${workflowId}.`, { workflowId });
    } catch (err) {
      this.logger.warn(`KeeperHub submission failed for intent ${intent.id}: ${String(err)}`);
      this.addAudit(intent, 'SUBMISSION_FAILED', `KeeperHub unavailable: ${String(err)}. Will retry next gas check.`);
    }
  }

  private applyWorkflowStatus(intent: IntentRecord, wf: Awaited<ReturnType<KeeperHubService['getWorkflowStatus']>>) {
    switch (wf.status) {
      case 'executing':
        if (intent.status !== IntentStatus.Confirming) {
          this.transition(intent, IntentStatus.Confirming, 'Transaction in mempool, awaiting confirmation.', { txHash: wf.txHash });
        }
        break;
      case 'completed':
        this.transition(intent, IntentStatus.Finalized, `Transaction confirmed in block ${wf.blockNumber ?? 'unknown'}.`, { txHash: wf.txHash, blockNumber: wf.blockNumber });
        break;
      case 'failed':
        this.transition(intent, IntentStatus.Stuck, `KeeperHub execution failed: ${wf.errorMessage ?? 'unknown error'}.`);
        break;
      case 'cancelled':
        this.transition(intent, IntentStatus.Cancelled, 'KeeperHub workflow was cancelled.');
        break;
    }
  }

  private transition(intent: IntentRecord, status: IntentStatus, message: string, metadata?: Record<string, unknown>) {
    intent.status = status;
    intent.updatedAt = new Date().toISOString();
    this.addAudit(intent, 'STATUS_CHANGED', message, { status, ...metadata });
  }

  private addAudit(intent: IntentRecord, type: string, message: string, metadata?: Record<string, unknown>) {
    const event: AuditEvent = {
      id: randomUUID(),
      intentId: intent.id,
      at: new Date().toISOString(),
      type,
      message,
      metadata
    };
    intent.audit.unshift(event);
    intent.updatedAt = event.at;
  }
}
