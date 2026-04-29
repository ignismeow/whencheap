import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { IntentRecord } from '../intents/intent.types';

interface KeeperHubWorkflowResponse {
  id?: string;
  workflowId?: string;
  workflow_id?: string;
  data?: {
    id?: string;
    workflowId?: string;
    workflow_id?: string;
  };
}

@Injectable()
export class KeeperHubService {
  private readonly logger = new Logger(KeeperHubService.name);

  constructor(private readonly config: ConfigService) {}

  async createWorkflow(intent: IntentRecord): Promise<string | null> {
    const apiKey = this.config.get<string>('KEEPERHUB_API_KEY') ?? '';
    if (!apiKey) {
      this.logger.warn('KEEPERHUB_API_KEY not set; KeeperHub audit logging disabled');
      return null;
    }

    try {
      const response = await axios.post<KeeperHubWorkflowResponse>(
        'https://app.keeperhub.com/api/workflows',
        {
          name: `WhenCheap ${intent.parsed.type} audit ${intent.id.slice(0, 8)}`,
          description: `Audit log for intent ${intent.id} from wallet ${intent.wallet}`,
          status: intent.status,
          txHash: intent.txHash ?? null,
          walletAddress: intent.wallet,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      return (
        response.data.id ??
        response.data.workflowId ??
        response.data.workflow_id ??
        response.data.data?.id ??
        response.data.data?.workflowId ??
        response.data.data?.workflow_id ??
        null
      );
    } catch (error) {
      this.logger.warn(`KeeperHub audit logging failed: ${String(error)}`);
      return null;
    }
  }
}
