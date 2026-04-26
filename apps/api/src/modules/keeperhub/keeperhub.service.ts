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

export class KeeperHubRequestError extends Error {
  constructor(
    message: string,
    readonly details: {
      status?: number;
      method: 'GET' | 'POST';
      url: string;
      retryable: boolean;
      responsePreview?: string;
    }
  ) {
    super(message);
    this.name = 'KeeperHubRequestError';
  }
}

export class KeeperHubUnavailableError extends KeeperHubRequestError {
  constructor(message: string, details: KeeperHubRequestError['details']) {
    super(message, details);
    this.name = 'KeeperHubUnavailableError';
  }
}

@Injectable()
export class KeeperHubService {
  private readonly logger = new Logger(KeeperHubService.name);
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly submitPath: string;
  private readonly statusPath: string;

  constructor(private readonly config: ConfigService) {
    this.apiUrl = (this.config.get<string>('KEEPERHUB_API_URL') ?? 'https://app.keeperhub.com').replace(/\/$/, '');
    this.apiKey = this.config.get<string>('KEEPERHUB_API_KEY') ?? '';
    this.submitPath = this.config.get<string>('KEEPERHUB_SUBMIT_PATH') ?? '/api/execute/transfer';
    this.statusPath = this.config.get<string>('KEEPERHUB_STATUS_PATH') ?? '/api/execute/{executionId}/status';
  }

  isUnavailableError(err: unknown): boolean {
    return err instanceof KeeperHubUnavailableError;
  }

  describeError(err: unknown): string {
    if (err instanceof KeeperHubRequestError) return err.message;
    return String(err);
  }

  // Direct Execution API. The path is configurable because KeeperHub routes can
  // differ between workflow and direct execution setups.
  async submitWorkflow(intent: IntentRecord, _baseFeeGwei: number): Promise<string> {
    const url = this.buildUrl(this.submitPath, intent);

    const payload = {
      network:          this.resolveNetwork(intent.parsed.chain ?? 'sepolia'),
      recipientAddress: intent.parsed.recipient ?? '',
      amount:           String(intent.parsed.amount),
      gasLimitMultiplier: '1.2'
    };

    try {
      const { data } = await axios.post<{ executionId: string; status: string }>(
        url,
        payload,
        {
          headers: {
            'X-API-Key':     this.apiKey,   // ← correct header
            'Content-Type':  'application/json'
          },
          timeout: 15_000
        }
      );

      this.logger.log(`KeeperHub direct execution submitted: ${data.executionId} status: ${data.status}`);
      return data.executionId;

    } catch (err) {
      throw this.toKeeperHubError(err, 'POST', url);
    }
  }

  async getWorkflowStatus(executionId: string): Promise<WorkflowStatus> {
    const url = this.buildUrl(this.statusPath, undefined, executionId);

    try {
      const { data } = await axios.get<{
        executionId: string;
        status: string;
        transactionHash?: string;
        transactionLink?: string;
        error?: string;
      }>(url, {
        headers: { 'X-API-Key': this.apiKey },
        timeout: 10_000
      });

      // Map KeeperHub status to our internal WorkflowStatus shape
      return {
        id:           data.executionId,
        status:       this.mapStatus(data.status),
        txHash:       data.transactionHash,
        errorMessage: data.error ?? undefined
      };

    } catch (err) {
      throw this.toKeeperHubError(err, 'GET', url);
    }
  }

  private buildUrl(pathTemplate: string, intent?: IntentRecord, executionId?: string): string {
    const workflowId = this.config.get<string>('KEEPERHUB_WORKFLOW_ID') ?? '';
    const path = pathTemplate
      .replace('{workflowId}', encodeURIComponent(workflowId))
      .replace('{executionId}', encodeURIComponent(executionId ?? ''))
      .replace('{chain}', encodeURIComponent(intent?.parsed.chain ?? 'sepolia'));

    if (/^https?:\/\//i.test(path)) return path;
    return `${this.apiUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private toKeeperHubError(err: unknown, method: 'GET' | 'POST', url: string): KeeperHubRequestError {
    if (!(err instanceof AxiosError)) {
      return new KeeperHubUnavailableError(`KeeperHub ${method} failed: ${String(err)}`, {
        method,
        url,
        retryable: true
      });
    }

    const status = err.response?.status;
    const retryable = !status || status === 408 || status === 429 || status >= 500;
    const responsePreview = this.previewResponse(err.response?.data);
    const message = status
      ? `KeeperHub ${method} ${url} returned ${status}. ${this.hintForStatus(status)}`
      : `KeeperHub ${method} ${url} failed before an HTTP response: ${err.message}.`;

    this.logger.error(
      `${message}${responsePreview ? ` Response preview: ${responsePreview}` : ''}`
    );

    const details = {
      status,
      method,
      url,
      retryable,
      responsePreview
    };

    if (status === 401 || status === 403 || status === 404) {
      return new KeeperHubUnavailableError(message, details);
    }

    return new KeeperHubRequestError(message, details);
  }

  private previewResponse(data: unknown): string | undefined {
    if (data === undefined || data === null) return undefined;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return text.replace(/\s+/g, ' ').slice(0, 240);
  }

  private hintForStatus(status: number): string {
    if (status === 401 || status === 403) return 'Check KEEPERHUB_API_KEY and account permissions.';
    if (status === 404) return 'The configured KeeperHub endpoint was not found; check KEEPERHUB_API_URL and KEEPERHUB_SUBMIT_PATH.';
    if (status === 429) return 'Rate limited; retrying later may work.';
    if (status >= 500) return 'KeeperHub returned a server error; retrying later may work.';
    return 'Check KeeperHub request configuration.';
  }

  private resolveNetwork(chain: string): string {
    const map: Record<string, string> = {
      sepolia:  'sepolia',
      ethereum: 'ethereum',
      mainnet:  'ethereum',
      base:     'base',
      arbitrum: 'arbitrum',
      polygon:  'polygon'
    };
    return map[chain.toLowerCase()] ?? 'sepolia';
  }

  private mapStatus(raw: string): WorkflowStatus['status'] {
    switch (raw) {
      case 'completed': return 'completed';
      case 'failed':    return 'failed';
      case 'cancelled': return 'cancelled';
      case 'running':   return 'executing';
      default:          return 'pending';
    }
  }
}
