import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { IntentRecord } from '../intents/intent.types';

export interface WorkflowStatus {
  id: string;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
  txHash?: string;
  blockNumber?: number;
  errorMessage?: string;
}

@Injectable()
export class KeeperHubService {
  private readonly logger = new Logger(KeeperHubService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly workflowId: string;

  constructor(private readonly config: ConfigService) {
    this.apiUrl = (this.config.get<string>('KEEPERHUB_API_URL') ?? 'https://app.keeperhub.com').replace(/\/$/, '');
    this.apiKey = this.config.get<string>('KEEPERHUB_API_KEY') ?? '';
    this.workflowId = this.config.get<string>('KEEPERHUB_WORKFLOW_ID') ?? '';
  }

  async submitWorkflow(intent: IntentRecord, baseFeeGwei: number): Promise<string> {
    const baseFeeWei = Math.round(baseFeeGwei * 1e9);
    const payload = this.buildExecutePayload(intent, baseFeeWei);
    const url = `${this.apiUrl}/api/workflows/${this.workflowId}/execute`;

    try {
      const { data } = await axios.post<{ id: string; executionId?: string }>(
        url,
        payload,
        { headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' }, timeout: 15_000 }
      );
      return data.executionId ?? data.id;
    } catch (err) {
      if (err instanceof AxiosError) {
        this.logger.error(`KeeperHub POST ${url} → ${err.response?.status}: ${JSON.stringify(err.response?.data)}`);
      }
      throw err;
    }
  }

  async getWorkflowStatus(executionId: string): Promise<WorkflowStatus> {
    const url = `${this.apiUrl}/api/workflows/${this.workflowId}/executions/${executionId}`;
    try {
      const { data } = await axios.get<WorkflowStatus>(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        timeout: 10_000
      });
      return data;
    } catch (err) {
      if (err instanceof AxiosError) {
        this.logger.error(`KeeperHub GET ${url} → ${err.response?.status}: ${JSON.stringify(err.response?.data)}`);
      }
      throw err;
    }
  }

  private buildExecutePayload(intent: IntentRecord, baseFeeWei: number): object {
    const isSend = intent.parsed.type === 'send';
    return {
      recipient: intent.parsed.recipient ?? '',
      amount: String(intent.parsed.amount),
      chain: intent.parsed.chain ?? 'sepolia',
      ...(isSend ? {} : {
        tokenIn: intent.parsed.fromToken,
        tokenOut: intent.parsed.toToken,
        slippage: intent.parsed.slippageBps / 10_000
      }),
      wallet: intent.wallet,
      maxGasUSD: intent.parsed.maxFeeUsd,
      deadline: intent.parsed.deadlineIso,
      maxBaseFeeWei: baseFeeWei
    };
  }
}
