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

export interface IntentRecord {
  id: string;
  wallet: string;
  rawInput: string;
  parsed: ParsedIntent;
  status: IntentStatus;
  keeperHubWorkflowId?: string;
  txHash?: string;
  createdAt: string;
  updatedAt: string;
  audit: AuditEvent[];
}
