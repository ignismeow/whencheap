import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { In, Repository } from 'typeorm';
import { OllamaIntentParserService } from '../agent/ollama-intent-parser.service';
import { ParsedIntent } from '../agent/parsed-intent.schema';
import { GasOracleService } from '../gas/gas-oracle.service';
import { KeeperHubService } from '../keeperhub/keeperhub.service';
import { WhenCheapWallet } from '../session/wallet.entity';
import { SessionSignerService } from '../session/session-signer.service';
import { UserEntity } from '../user/user.entity';
import { AuditEventEntity } from './audit-event.entity';
import { CreateIntentDto } from './dto/create-intent.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { ManagedSessionDto } from './dto/managed-session.dto';
import { RegisterWalletDto } from './dto/register-wallet.dto';
import { TestEip7702Dto } from './dto/test-eip7702.dto';
import { ExecutionEntity } from './execution.entity';
import { IntentEntity } from './intent.entity';
import { IntentStatus } from './intent-status';
import { AuditEvent, ExecutionRecord, IntentRecord } from './intent.types';

@Injectable()
export class IntentsService implements OnModuleInit {
  private readonly logger = new Logger(IntentsService.name);
  private readonly intents = new Map<string, IntentRecord>();
  private readonly agentFallbackEnabled: boolean;

  constructor(
    private readonly parser: OllamaIntentParserService,
    private readonly gas: GasOracleService,
    private readonly keeperHub: KeeperHubService,
    private readonly sessionSigner: SessionSignerService,
    private readonly config: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(WhenCheapWallet)
    private readonly walletRepository: Repository<WhenCheapWallet>,
    @InjectRepository(IntentEntity)
    private readonly intentRepository: Repository<IntentEntity>,
    @InjectRepository(ExecutionEntity)
    private readonly executionRepository: Repository<ExecutionEntity>,
    @InjectRepository(AuditEventEntity)
    private readonly auditRepository: Repository<AuditEventEntity>,
  ) {
    const raw = this.config.get<string>('ALLOW_AGENT_FUNDED_FALLBACK') ?? 'false';
    this.agentFallbackEnabled = raw.toLowerCase() === 'true';

    if (this.agentFallbackEnabled) {
      this.logger.warn(
        'ALLOW_AGENT_FUNDED_FALLBACK is enabled. ' +
          'Execution priority: EIP-7702 relay first, direct agent-funded fallback second. ' +
          'Ensure AGENT_WALLET_PK is set and funded.',
      );
    } else {
      this.logger.log(
        'ALLOW_AGENT_FUNDED_FALLBACK is disabled (default). ' +
          'Execution priority: EIP-7702 relay first, then NEEDS_AUTHORIZATION audit.',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    const persistedActive = await this.intentRepository.find({
      where: {
        status: In([
          IntentStatus.PendingIntent,
          IntentStatus.Submitted,
          IntentStatus.Confirming,
        ]),
      },
      relations: ['auditEvents', 'executions'],
      order: { createdAt: 'DESC' },
    });

    for (const entity of persistedActive) {
      const intent = this.mapEntityToRecord(entity);
      this.intents.set(intent.id, intent);
    }

    if (persistedActive.length > 0) {
      this.logger.log(`Loaded ${persistedActive.length} active intent(s) from PostgreSQL.`);
    }
  }

  async create(dto: CreateIntentDto): Promise<IntentRecord> {
    const { parsed: rawParsed, providerUsed } = await this.parser.parse(dto.input, dto.wallet);
    const parsed = await this.resolveEnsRecipient(rawParsed);
    const now = new Date().toISOString();
    const id = randomUUID();
    const requestedExecutions = Math.max(parsed.repeatCount ?? 1, 1);
    const userId = await this.resolveUserIdByWallet(dto.wallet);

    const intent: IntentRecord = {
      id,
      wallet: dto.wallet,
      rawInput: dto.input,
      parsed,
      requestedExecutions,
      completedExecutions: 0,
      remainingExecutions: requestedExecutions,
      status: IntentStatus.PendingIntent,
      createdAt: now,
      updatedAt: now,
      txHash: undefined,
      blockNumber: null,
      inferenceProvider: providerUsed,
      audit: [],
      executions: [],
    };

    await this.intentRepository.save(
      this.intentRepository.create({
        id,
        userId,
        walletAddress: dto.wallet.toLowerCase(),
        rawInput: dto.input,
        status: IntentStatus.PendingIntent,
        parsed: parsed as Record<string, unknown>,
        txHash: null,
        blockNumber: null,
        inferenceProvider: providerUsed,
        repeatCount: requestedExecutions,
        repeatCompleted: 0,
        deadline: parsed.deadlineIso ? new Date(parsed.deadlineIso) : null,
      }),
    );

    await this.addAudit(intent, 'INTENT_CREATED', 'Intent accepted and parsed.', {
      parsed,
      requestedExecutions,
      inferenceProvider: providerUsed,
    });

    this.intents.set(id, intent);
    return intent;
  }

  async storeAuthorization(userAddress: string, authorization: unknown): Promise<void> {
    await this.sessionSigner.storeAuthorization(userAddress, authorization);
  }

  async registerWallet(dto: RegisterWalletDto) {
    return await this.sessionSigner.registerWallet(dto);
  }

  async authenticateWithGoogle(dto: GoogleAuthDto) {
    return await this.sessionSigner.authenticateWithGoogle(dto);
  }

  authorizeManagedWalletSession(dto: ManagedSessionDto) {
    return this.sessionSigner.authorizeManagedWalletSession(dto);
  }

  revokeManagedWalletSession(userAddress: string) {
    return this.sessionSigner.revokeManagedWalletSession(userAddress);
  }

  async list(): Promise<IntentRecord[]> {
    const persisted = await this.intentRepository.find({
      relations: ['auditEvents', 'executions'],
      order: { createdAt: 'DESC' },
    });
    return persisted.map((entity) => this.mapEntityToRecord(entity));
  }

  async get(id: string): Promise<IntentRecord> {
    const cached = this.intents.get(id);
    if (cached) {
      return cached;
    }

    const persisted = await this.intentRepository.findOne({
      where: { id },
      relations: ['auditEvents', 'executions'],
    });
    if (!persisted) {
      throw new NotFoundException(`Intent ${id} not found`);
    }

    return this.mapEntityToRecord(persisted);
  }

  async resolveRecipientName(name: string): Promise<string | null> {
    return this.sessionSigner.resolveName(name);
  }

  async testEip7702(dto: TestEip7702Dto) {
    return this.sessionSigner.testEip7702UserWalletExecution(dto);
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async evaluatePendingIntents() {
    const pending = [...this.intents.values()].filter(
      (i) => i.status === IntentStatus.PendingIntent,
    );
    if (pending.length === 0) return;

    for (const intent of pending) {
      if (new Date(intent.parsed.deadlineIso).getTime() < Date.now()) {
        await this.transition(
          intent,
          IntentStatus.DeadlineExceeded,
          'Intent deadline has passed before submission.',
        );
        continue;
      }

      let costUsd: number;
      let baseFeeGwei: number;
      try {
        ({ costUsd, baseFeeGwei } = await this.gas.estimateTxCostUsd(
          intent.parsed.type as 'send' | 'swap',
        ));
      } catch {
        await this.addAudit(
          intent,
          'GAS_CHECK_SKIPPED',
          'Gas oracle unavailable; will retry next cycle.',
        );
        continue;
      }

      const limit = intent.parsed.maxFeeUsd;
      if (costUsd > limit) {
        await this.addAudit(
          intent,
          'GAS_CHECK_FAILED',
          `Base fee: ${baseFeeGwei.toFixed(3)} gwei. ` +
            `Est. cost: $${costUsd.toFixed(4)}. ` +
            `Exceeds $${limit} limit. Waiting for cheaper gas.`,
          { baseFeeGwei, costUsd, limitUsd: limit },
        );
        continue;
      }

      await this.addAudit(
        intent,
        'GAS_CHECK_PASSED',
        `Base fee: ${baseFeeGwei.toFixed(3)} gwei. ` +
          `Est. cost: $${costUsd.toFixed(4)}. Under $${limit} limit.`,
        { baseFeeGwei, costUsd, limitUsd: limit },
      );

      const feeWei = this.sessionSigner.estimateFeeWei(
        baseFeeGwei,
        intent.parsed.type as 'send' | 'swap',
      );
      const sessionOk = await this.sessionSigner.canExecuteSession(intent.wallet, feeWei);
      if (!sessionOk) {
        await this.addAudit(
          intent,
          'SESSION_INVALID',
          'Session expired or estimated fee exceeds session limits. User must re-authorize.',
        );
        await this.transition(
          intent,
          IntentStatus.NeedsReauthorization,
          'Session limits exceeded or session expired.',
        );
        continue;
      }

      await this.addAudit(
        intent,
        'SESSION_CHECK_PASSED',
        'Session valid and within limits. Proceeding to execution.',
      );

      const registeredWallet = await this.sessionSigner.getRegisteredWallet(intent.wallet);
      const authorization = await this.sessionSigner.getAuthorization(intent.wallet);

      if (registeredWallet) {
        await this.executeWithUserWallet(intent, registeredWallet, authorization, baseFeeGwei);
      } else if (authorization && this.sessionSigner.isOnChainSessionMarker(authorization)) {
        await this.addAudit(
          intent,
          'ON_CHAIN_SESSION_EXECUTION',
          'Using on-chain session marker to execute from the agent wallet with session limit enforcement.',
          { authorization },
        );
        await this.executeSessionBacked(intent, baseFeeGwei);
      } else if (authorization) {
        await this.executeEIP7702(intent, authorization, baseFeeGwei);
      } else if (this.agentFallbackEnabled) {
        await this.addAudit(
          intent,
          'AGENT_FALLBACK_USED',
          'No EIP-7702 authorization stored. Executing directly from agent wallet because ALLOW_AGENT_FUNDED_FALLBACK=true.',
        );
        await this.executeDirectly(intent, baseFeeGwei);
      } else {
        await this.addAudit(
          intent,
          'NEEDS_AUTHORIZATION',
          'No EIP-7702 authorization stored. User must authorize session with EIP-7702 compatible wallet (Rabby, MetaMask Flask).',
        );
      }
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async pollSubmittedIntents() {
    const submitted = [...this.intents.values()].filter(
      (i) => i.status === IntentStatus.Submitted || i.status === IntentStatus.Confirming,
    );

    for (const intent of submitted) {
      if (intent.txHash) {
        await this.pollDirectTx(intent);
      }
    }
  }

  private async executeDirectly(intent: IntentRecord, baseFeeGwei: number) {
    try {
      const txHash = await this.sessionSigner.broadcastIntent(intent, baseFeeGwei);
      intent.txHash = txHash;
      await this.transition(
        intent,
        IntentStatus.Submitted,
        `Agent-funded fallback transaction broadcast. Hash: ${txHash}.`,
        {
          txHash,
          agentAddress: this.sessionSigner.agentAddress,
          senderModel: 'agent-funded-fallback',
        },
      );
      await this.logKeeperHubExecution(intent);
    } catch (err) {
      this.logger.warn(`Direct execution failed for intent ${intent.id}: ${String(err)}`);
      await this.addAudit(
        intent,
        'EXECUTION_FAILED',
        `Broadcast failed: ${String(err)}. Will retry next gas check.`,
      );
    }
  }

  private async executeEIP7702(
    intent: IntentRecord,
    authorization: unknown,
    baseFeeGwei: number,
  ) {
    try {
      await this.addAudit(
        intent,
        'EIP7702_EXECUTION',
        'Attempting EIP-7702 agent-self-delegation execution.',
        { userWallet: intent.wallet, authorization },
      );
      await this.addAudit(
        intent,
        'EIP7702_AGENT_SELF_DELEGATION',
        'EIP-7702 agent-self-delegation: agent wallet delegated to WhenCheapSession contract for this execution.',
        { agentWallet: this.sessionSigner.agentAddress },
      );

      const txHash = await this.sessionSigner.broadcastEIP7702Intent(intent, authorization);
      intent.txHash = txHash;
      await this.transition(
        intent,
        IntentStatus.Submitted,
        `EIP-7702 authorization-list transaction broadcast. Hash: ${txHash}.`,
        {
          txHash,
          senderModel: 'eip7702-agent-self-delegation',
          userWallet: intent.wallet,
          agentWallet: this.sessionSigner.agentAddress,
        },
      );
      await this.logKeeperHubExecution(intent);
    } catch (err) {
      this.logger.warn(`EIP-7702 execution failed for intent ${intent.id}: ${String(err)}`);
      await this.addAudit(intent, 'EIP7702_FAILED', `EIP-7702 failed: ${String(err)}.`);
      if (this.agentFallbackEnabled) {
        await this.addAudit(
          intent,
          'AGENT_FALLBACK_USED',
          'EIP-7702 relay failed. Executing directly from agent wallet because ALLOW_AGENT_FUNDED_FALLBACK=true.',
        );
        await this.executeDirectly(intent, baseFeeGwei);
        return;
      }
      await this.addAudit(
        intent,
        'NEEDS_AUTHORIZATION',
        'EIP-7702 relay failed and agent-funded fallback is disabled. User must re-authorize with EIP-7702 compatible wallet.',
      );
    }
  }

  private async executeWithUserWallet(
    intent: IntentRecord,
    encryptedKeyData: string,
    authorization: unknown,
    baseFeeGwei: number,
  ) {
    try {
      await this.addAudit(
        intent,
        'USER_WALLET_EXECUTION',
        'Using encrypted WhenCheap wallet to relay a true user-wallet-as-sender EIP-7702 transaction.',
        { userWallet: intent.wallet },
      );
      const txHash = await this.sessionSigner.broadcastWithUserWallet(intent, encryptedKeyData);
      intent.txHash = txHash;
      await this.transition(
        intent,
        IntentStatus.Submitted,
        `User-wallet EIP-7702 transaction broadcast. Hash: ${txHash}.`,
        {
          txHash,
          senderModel: 'eip7702-user-wallet-relayed',
          userWallet: intent.wallet,
          agentWallet: this.sessionSigner.agentAddress,
        },
      );
      await this.logKeeperHubExecution(intent);
    } catch (err) {
      this.logger.warn(
        `User-wallet EIP-7702 execution failed for intent ${intent.id}: ${String(err)}`,
      );
      await this.addAudit(
        intent,
        'USER_WALLET_EXECUTION_FAILED',
        `Encrypted-wallet EIP-7702 failed: ${String(err)}.`,
      );

      if (authorization && this.sessionSigner.isOnChainSessionMarker(authorization)) {
        await this.addAudit(
          intent,
          'USER_WALLET_FALLBACK',
          'Falling back to on-chain session execution after encrypted-wallet EIP-7702 failure.',
        );
        await this.executeSessionBacked(intent, baseFeeGwei);
        return;
      }

      if (authorization) {
        await this.addAudit(
          intent,
          'USER_WALLET_FALLBACK',
          'Falling back to stored EIP-7702 authorization after encrypted-wallet execution failure.',
        );
        await this.executeEIP7702(intent, authorization, baseFeeGwei);
        return;
      }

      if (this.agentFallbackEnabled) {
        await this.addAudit(
          intent,
          'AGENT_FALLBACK_USED',
          'Encrypted-wallet EIP-7702 failed. Executing directly from agent wallet because ALLOW_AGENT_FUNDED_FALLBACK=true.',
        );
        await this.executeDirectly(intent, baseFeeGwei);
        return;
      }

      await this.addAudit(
        intent,
        'NEEDS_AUTHORIZATION',
        'Encrypted-wallet EIP-7702 failed and no alternate execution path is available.',
      );
    }
  }

  private async executeSessionBacked(intent: IntentRecord, baseFeeGwei: number) {
    try {
      const txHash = await this.sessionSigner.broadcastSessionBackedIntent(intent, baseFeeGwei);
      intent.txHash = txHash;
      await this.transition(
        intent,
        IntentStatus.Submitted,
        `On-chain-session-backed agent transaction broadcast. Hash: ${txHash}.`,
        {
          txHash,
          agentAddress: this.sessionSigner.agentAddress,
          senderModel: 'on-chain-session-agent-funded',
        },
      );
      await this.logKeeperHubExecution(intent);
    } catch (err) {
      this.logger.warn(`On-chain-session execution failed for intent ${intent.id}: ${String(err)}`);
      await this.addAudit(
        intent,
        'EXECUTION_FAILED',
        `On-chain-session-backed broadcast failed: ${String(err)}. Will retry next gas check.`,
      );
    }
  }

  private async pollDirectTx(intent: IntentRecord) {
    try {
      const receipt = await this.sessionSigner.provider.getTransactionReceipt(intent.txHash!);
      if (!receipt) {
        if (intent.status !== IntentStatus.Confirming) {
          await this.transition(
            intent,
            IntentStatus.Confirming,
            'Transaction in mempool, awaiting confirmation.',
            { txHash: intent.txHash },
          );
        }
        return;
      }

      const gasPrice = receipt.gasPrice ?? 0n;
      const feePaid = receipt.gasUsed * gasPrice;
      const currentTxHash = intent.txHash!;
      intent.blockNumber = receipt.blockNumber;

      await this.recordExecution(
        intent,
        currentTxHash,
        receipt.blockNumber,
        receipt.status === 1 ? 'CONFIRMED' : 'REVERTED',
        feePaid.toString(),
      );

      if (receipt.status === 1) {
        try {
          const spendTxHash = await this.sessionSigner.recordSpend(intent.wallet, feePaid);
          if (spendTxHash) {
            await this.addAudit(
              intent,
              'SESSION_SPEND_RECORDED',
              `Session spend recorded. Tx: ${spendTxHash}`,
              { spendTxHash, feePaidWei: feePaid.toString() },
            );
          }
        } catch (err) {
          await this.addAudit(
            intent,
            'SESSION_SPEND_RECORD_FAILED',
            `Could not record session spend: ${String(err)}`,
          );
        }

        intent.completedExecutions += 1;
        intent.remainingExecutions = Math.max(
          intent.requestedExecutions - intent.completedExecutions,
          0,
        );

        const deadlineAt = new Date(intent.parsed.deadlineIso).getTime();
        const canRepeat = intent.remainingExecutions > 0 && deadlineAt > Date.now();

        if (canRepeat) {
          await this.addAudit(
            intent,
            'REPEAT_EXECUTION_RESCHEDULED',
            `Execution ${intent.completedExecutions} confirmed in block ${receipt.blockNumber}. ${intent.remainingExecutions} execution(s) remaining before deadline.`,
            {
              txHash: currentTxHash,
              blockNumber: receipt.blockNumber,
              completedExecutions: intent.completedExecutions,
              remainingExecutions: intent.remainingExecutions,
            },
          );
          intent.txHash = undefined;
          await this.transition(
            intent,
            IntentStatus.PendingIntent,
            `Execution ${intent.completedExecutions}/${intent.requestedExecutions} confirmed. Re-queued for the next gas window.`,
            {
              completedExecutions: intent.completedExecutions,
              remainingExecutions: intent.remainingExecutions,
            },
          );
          return;
        }

        const finalizedMessage =
          intent.remainingExecutions > 0
            ? `Confirmed in block ${receipt.blockNumber}. Deadline reached before all repeats could execute; completed ${intent.completedExecutions}/${intent.requestedExecutions}.`
            : `Confirmed in block ${receipt.blockNumber}. Completed ${intent.completedExecutions}/${intent.requestedExecutions} execution(s).`;

        await this.transition(intent, IntentStatus.Finalized, finalizedMessage, {
          txHash: currentTxHash,
          blockNumber: receipt.blockNumber,
          completedExecutions: intent.completedExecutions,
          remainingExecutions: intent.remainingExecutions,
        });
        this.intents.delete(intent.id);
      } else {
        await this.transition(intent, IntentStatus.Stuck, 'Transaction reverted on-chain.', {
          txHash: currentTxHash,
          blockNumber: receipt.blockNumber,
        });
        this.intents.delete(intent.id);
      }
    } catch (err) {
      this.logger.warn(`Receipt poll failed for intent ${intent.id}: ${String(err)}`);
    }
  }

  private async transition(
    intent: IntentRecord,
    status: IntentStatus,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    intent.status = status;
    intent.updatedAt = new Date().toISOString();
    await this.persistIntent(intent);
    await this.addAudit(intent, 'STATUS_CHANGED', message, { status, ...metadata });
  }

  private async addAudit(
    intent: IntentRecord,
    type: string,
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    const event: AuditEvent = {
      id: randomUUID(),
      intentId: intent.id,
      at: new Date().toISOString(),
      type,
      message,
      metadata,
    };
    intent.audit.unshift(event);
    intent.updatedAt = event.at;
    await this.persistIntent(intent);
    await this.auditRepository.save(
      this.auditRepository.create({
        id: event.id,
        intentId: intent.id,
        eventType: type,
        message,
        metadata: metadata ?? null,
        createdAt: new Date(event.at),
      }),
    );
  }

  private async resolveEnsRecipient(parsed: ParsedIntent): Promise<ParsedIntent> {
    const recipient = parsed.recipient?.trim();
    if (!recipient || !recipient.toLowerCase().endsWith('.eth')) {
      return parsed;
    }

    const resolved = await this.sessionSigner.resolveName(recipient);
    if (!resolved) {
      return {
        ...parsed,
        notes: this.appendNote(parsed.notes, `ENS lookup failed for ${recipient}.`),
      };
    }

    return {
      ...parsed,
      resolvedRecipient: resolved,
      notes: this.appendNote(parsed.notes, `${recipient} resolved to ${resolved}.`),
    };
  }

  private appendNote(existing: string | undefined, note: string): string {
    return existing ? `${existing} ${note}` : note;
  }

  private async logKeeperHubExecution(intent: IntentRecord): Promise<void> {
    try {
      const workflowId = await this.keeperHub.createWorkflow(intent);
      intent.keeperHubWorkflowId = workflowId;
      await this.addAudit(
        intent,
        'KEEPERHUB_AUDIT_LOGGED',
        `Execution logged to KeeperHub via MCP workflow ${workflowId}.`,
        { workflowId, txHash: intent.txHash },
      );
    } catch (error) {
      await this.addAudit(
        intent,
        'KEEPERHUB_AUDIT_FAILED',
        `KeeperHub MCP audit logging failed: ${String(error)}`,
      );
    }
  }

  private async resolveUserIdByWallet(walletAddress: string): Promise<string | null> {
    const wallet = await this.walletRepository
      .createQueryBuilder('wallet')
      .where('LOWER(wallet.walletAddress) = LOWER(:walletAddress)', { walletAddress })
      .getOne();

    if (wallet?.userId) {
      return wallet.userId;
    }

    const user = await this.userRepository.findOne({
      where: { identifier: walletAddress.toLowerCase() },
    });
    return user?.id ?? null;
  }

  private async persistIntent(intent: IntentRecord): Promise<void> {
    const userId = await this.resolveUserIdByWallet(intent.wallet);
    await this.intentRepository.save(
      this.intentRepository.create({
        id: intent.id,
        userId,
        walletAddress: intent.wallet.toLowerCase(),
        rawInput: intent.rawInput,
        status: intent.status,
        parsed: intent.parsed as Record<string, unknown>,
        txHash: intent.txHash ?? null,
        blockNumber: intent.blockNumber ?? null,
        inferenceProvider: intent.inferenceProvider ?? null,
        repeatCount: intent.requestedExecutions,
        repeatCompleted: intent.completedExecutions,
        deadline: intent.parsed.deadlineIso ? new Date(intent.parsed.deadlineIso) : null,
        createdAt: new Date(intent.createdAt),
        updatedAt: new Date(intent.updatedAt),
      }),
    );
  }

  private async recordExecution(
    intent: IntentRecord,
    txHash: string,
    blockNumber: number,
    status: string,
    gasPaidWei: string,
  ): Promise<void> {
    const existing = await this.executionRepository.findOne({ where: { txHash } });
    const executionEntity = this.executionRepository.create({
      id: existing?.id,
      intentId: intent.id,
      executionNumber: intent.completedExecutions + 1,
      txHash,
      blockNumber,
      status,
      gasPaidWei,
      confirmedAt: new Date(),
      createdAt: existing?.createdAt,
    });

    await this.executionRepository.save(executionEntity);

    const executionRecord: ExecutionRecord = {
      id: executionEntity.id,
      executionNumber: executionEntity.executionNumber,
      txHash,
      blockNumber,
      status,
      gasPaidWei,
      confirmedAt: executionEntity.confirmedAt?.toISOString() ?? null,
      createdAt: executionEntity.createdAt?.toISOString() ?? new Date().toISOString(),
    };

    intent.executions = [...(intent.executions ?? []), executionRecord];
    await this.persistIntent(intent);
  }

  private mapEntityToRecord(entity: IntentEntity): IntentRecord {
    const audit = [...(entity.auditEvents ?? [])]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((event) => ({
        id: event.id,
        intentId: entity.id,
        at: event.createdAt.toISOString(),
        type: event.eventType,
        message: event.message,
        metadata: event.metadata ?? undefined,
      }));

    const executions = [...(entity.executions ?? [])]
      .sort((a, b) => a.executionNumber - b.executionNumber)
      .map((execution) => ({
        id: execution.id,
        executionNumber: execution.executionNumber,
        txHash: execution.txHash,
        blockNumber: execution.blockNumber,
        status: execution.status,
        gasPaidWei: execution.gasPaidWei,
        confirmedAt: execution.confirmedAt?.toISOString() ?? null,
        createdAt: execution.createdAt.toISOString(),
      }));

    const requestedExecutions = Math.max(entity.repeatCount ?? 1, 1);
    const completedExecutions = entity.repeatCompleted ?? 0;

    return {
      id: entity.id,
      wallet: entity.walletAddress,
      rawInput: entity.rawInput,
      parsed: entity.parsed as ParsedIntent,
      requestedExecutions,
      completedExecutions,
      remainingExecutions: Math.max(requestedExecutions - completedExecutions, 0),
      status: entity.status as IntentStatus,
      txHash: entity.txHash ?? undefined,
      blockNumber: entity.blockNumber,
      inferenceProvider: entity.inferenceProvider,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      audit,
      executions,
    };
  }
}
