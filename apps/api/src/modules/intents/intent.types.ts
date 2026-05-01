import { ParsedIntent } from '../agent/parsed-intent.schema';
import { IntentStatus } from './intent-status';

export interface AuditEvent {
  id: string;
  intentId: string;
  at: string;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionRecord {
  id: string;
  executionNumber: number;
  txHash: string;
  blockNumber?: number | null;
  status: string;
  gasPaidWei: string;
  confirmedAt?: string | null;
  createdAt: string;
}

export interface IntentRecord {
  id: string;
  wallet: string;
  rawInput: string;
  parsed: ParsedIntent;
  requestedExecutions: number;
  completedExecutions: number;
  remainingExecutions: number;
  status: IntentStatus;
  retryCount?: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  keeperHubWorkflowId?: string;
  txHash?: string;
  blockNumber?: number | null;
  inferenceProvider?: string | null;
  createdAt: string;
  updatedAt: string;
  audit: AuditEvent[];
  executions?: ExecutionRecord[];
}
