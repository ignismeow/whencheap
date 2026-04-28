import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { IntentRecord } from '../intents/intent.types';

interface KeeperHubToolResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type?: string; text?: string }>;
}

@Injectable()
export class KeeperHubService implements OnModuleDestroy {
  private readonly logger = new Logger(KeeperHubService.name);
  private clientPromise: Promise<Client | null> | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.clientPromise) return;

    try {
      const client = await this.clientPromise;
      await client?.close();
    } catch (error) {
      this.logger.warn(`KeeperHub MCP client close failed: ${String(error)}`);
    }
  }

  async createWorkflow(intent: IntentRecord): Promise<string> {
    const client = await this.getClient();
    if (!client) {
      throw new Error('KeeperHub MCP client is not configured');
    }

    const result = (await client.callTool({
      name: 'create_workflow',
      arguments: {
        name: `WhenCheap ${intent.parsed.type} audit ${intent.id.slice(0, 8)}`,
        trigger: 'manual',
        steps: [
          {
            action: 'system.log',
            input: {
              source: 'whencheap',
              intentId: intent.id,
              wallet: intent.wallet,
              rawInput: intent.rawInput,
              parsed: intent.parsed,
              txHash: intent.txHash,
              network: intent.parsed.chain,
              status: intent.status,
              createdAt: intent.createdAt,
              updatedAt: intent.updatedAt,
            },
          },
        ],
      },
    })) as KeeperHubToolResult;

    const structuredId = result.structuredContent?.workflow_id;
    if (typeof structuredId === 'string' && structuredId.length > 0) {
      return structuredId;
    }

    const text = result.content?.map((entry) => entry.text).filter(Boolean).join(' ') ?? '';
    const match = text.match(/\b(wf_[A-Za-z0-9_-]+)\b/);
    if (match) {
      return match[1];
    }

    throw new Error('KeeperHub create_workflow did not return a workflow id');
  }

  private async getClient(): Promise<Client | null> {
    if (!this.clientPromise) {
      this.clientPromise = this.connectClient();
    }

    return this.clientPromise;
  }

  private async connectClient(): Promise<Client | null> {
    const apiKey = this.config.get<string>('KEEPERHUB_API_KEY') ?? '';
    const command = this.config.get<string>('KEEPERHUB_MCP_COMMAND') ?? 'npx';
    const args = this.parseArgs(
      this.config.get<string>('KEEPERHUB_MCP_ARGS') ?? '-y keeperhub-mcp',
    );

    if (!apiKey) {
      this.logger.warn('KEEPERHUB_API_KEY not set; KeeperHub MCP audit logging disabled');
      return null;
    }

    const client = new Client({
      name: 'whencheap-api',
      version: '0.1.0',
    });

    const transport = new StdioClientTransport({
      command,
      args,
      env: {
        ...process.env,
        KEEPERHUB_API_KEY: apiKey,
      },
    });

    await client.connect(transport);
    this.logger.log(`Connected to KeeperHub MCP via stdio using command "${command}"`);
    return client;
  }

  private parseArgs(raw: string): string[] {
    const matches = raw.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
    return matches.map((part) => part.replace(/^"|"$/g, ''));
  }
}
