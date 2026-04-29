import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ParsedIntent, parsedIntentSchema } from './parsed-intent.schema';

export type IntentInferenceProvider = '0g' | 'ollama' | 'fallback';

export interface IntentParseResult {
  parsed: ParsedIntent;
  providerUsed: IntentInferenceProvider;
}

interface OpenAiChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

@Injectable()
export class OllamaIntentParserService {
  private readonly logger = new Logger(OllamaIntentParserService.name);
  private zeroGModelId: string | null = null;

  constructor(private readonly config: ConfigService) {}

  async parse(input: string, wallet: string): Promise<IntentParseResult> {
    const zeroGToken = this.config.get<string>('ZG_BEARER_TOKEN') ?? '';

    if (zeroGToken) {
      try {
        const parsed = await this.parseWithZeroG(input, wallet, zeroGToken);
        return { parsed, providerUsed: '0g' };
      } catch (error) {
        this.logger.warn(`0G parse failed; falling back to Ollama: ${String(error)}`);
      }
    }

    try {
      const parsed = await this.parseWithOllama(input, wallet);
      return { parsed, providerUsed: 'ollama' };
    } catch (error) {
      this.logger.warn(`Ollama parse failed; using fallback parser: ${String(error)}`);
      return { parsed: this.fallbackParse(input), providerUsed: 'fallback' };
    }
  }

  private async parseWithZeroG(
    input: string,
    wallet: string,
    bearerToken: string,
  ): Promise<ParsedIntent> {
    const baseUrl = (this.config.get<string>('ZG_PROVIDER_URL') ?? 'https://api.0g.ai/v1').replace(/\/$/, '');
    const timeoutMs = Number(this.config.get<string>('GEMINI_TIMEOUT_MS') ?? 30000);
    const model = await this.resolveZeroGModel(baseUrl, bearerToken);

    const response = await axios.post<OpenAiChatCompletionResponse>(
      `${baseUrl}/chat/completions`,
      {
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: this.buildPrompt(input, wallet),
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
      },
    );

    const content = response.data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('0G response did not include a JSON message');
    }

    return parsedIntentSchema.parse(this.parseJsonContent(content));
  }

  private async parseWithOllama(input: string, wallet: string): Promise<ParsedIntent> {
    const baseUrl = (this.config.get<string>('OLLAMA_BASE_URL') ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    const model = this.config.get<string>('OLLAMA_MODEL') ?? 'llama3.1:8b';
    const timeoutMs = Number(this.config.get<string>('GEMINI_TIMEOUT_MS') ?? 30000);

    const response = await axios.post<{ response?: string }>(
      `${baseUrl}/api/generate`,
      {
        model,
        prompt: this.buildPrompt(input, wallet),
        stream: false,
        format: 'json',
        options: {
          temperature: 0,
        },
      },
      { timeout: timeoutMs },
    );

    const content = response.data.response;
    if (!content) {
      throw new Error('Ollama response did not include JSON output');
    }

    return parsedIntentSchema.parse(this.parseJsonContent(content));
  }

  private buildPrompt(input: string, wallet: string): string {
    return [
      'You parse natural language Ethereum transaction intents for WhenCheap.',
      'Return only valid compact JSON with keys: type, fromToken, toToken, recipient, amount, maxFeeUsd, deadlineIso, chain, slippageBps, repeatCount, notes.',
      'type must be swap or send.',
      'For send intents, put the destination in recipient and omit toToken.',
      'For swap intents, omit recipient unless the user explicitly provides one.',
      'recipient may be a 0x address or an ENS name like vitalik.eth.',
      'Use ISO datetime for deadlineIso.',
      "For swap intents, default chain to 'ethereum' unless the user explicitly says 'sepolia' or 'testnet'.",
      "For send intents, default chain to 'sepolia'.",
      'maxFeeUsd and slippageBps must be numbers. amount must be a string.',
      'Use slippageBps 50 when slippage is unknown.',
      'Omit optional unknown fields instead of returning null.',
      'If a field is unknown, choose a conservative default and explain in notes.',
      'Intent payload:',
      JSON.stringify({
        wallet,
        nowIso: new Date().toISOString(),
        input,
      }),
    ].join('\n');
  }

  private parseJsonContent(content: string): unknown {
    try {
      return this.normalizeParsedJson(JSON.parse(this.stripThinking(content)));
    } catch {
      const match = this.stripThinking(content).match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error('Model response did not contain JSON');
      }
      return this.normalizeParsedJson(JSON.parse(match[0]));
    }
  }

  private normalizeParsedJson(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const parsed = { ...value } as Record<string, unknown>;
    for (const key of ['recipient', 'resolvedRecipient', 'toToken', 'repeatCount', 'notes']) {
      if (parsed[key] === null) {
        delete parsed[key];
      }
    }
    if (parsed.slippageBps === null) parsed.slippageBps = 50;
    if (parsed.maxFeeUsd === null) parsed.maxFeeUsd = 1;
    if (parsed.chain === null) delete parsed.chain;
    if (typeof parsed.chain !== 'string' || !parsed.chain.trim()) {
      parsed.chain = parsed.type === 'swap' ? 'ethereum' : 'sepolia';
    }
    return parsed;
  }

  private stripThinking(content: string): string {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  private fallbackParse(input: string): ParsedIntent {
    const lower = input.toLowerCase();
    const isSend = /\bsend\b/.test(lower);
    const explicitChain = this.extractChain(lower);
    const amount = lower.match(/\b(\d+(?:\.\d+)?)\s*(?:sepolia\s+)?(?:eth|weth|usdc|usdt|dai)\b/)?.[1]
      ?? lower.match(/(\d+(?:\.\d+)?)/)?.[1]
      ?? '0';
    const maxFeeUsd = Number(lower.match(/\$ ?(\d+(?:\.\d+)?)/)?.[1] ?? 1);
    const deadline = this.extractDeadline(lower);
    const repeatCount = this.extractRepeatCount(lower);
    const recipient = input.match(/0x[a-fA-F0-9]{40}|\b[a-z0-9-]+\.eth\b/i)?.[0];
    const tokenPair = lower.match(/\b(eth|weth|usdc|usdt|dai)\s+(?:to|for|into)\s+(eth|weth|usdc|usdt|dai)\b/);
    const explicitToken = lower.match(/\b(?:sepolia\s+)?(eth|weth|usdc|usdt|dai)\b/)?.[1];
    const fromToken = tokenPair?.[1]?.toUpperCase() ?? explicitToken?.toUpperCase() ?? 'ETH';
    const toToken = tokenPair?.[2]?.toUpperCase() ?? 'USDC';
    const type = isSend ? 'send' : 'swap';
    const chain = explicitChain ?? (type === 'swap' ? 'ethereum' : 'sepolia');

    return parsedIntentSchema.parse({
      type,
      fromToken,
      ...(isSend ? { recipient } : { toToken }),
      amount,
      maxFeeUsd,
      deadlineIso: deadline.toISOString(),
      chain,
      slippageBps: 50,
      repeatCount: repeatCount > 1 ? repeatCount : undefined,
      notes:
        isSend && !recipient
          ? 'Fallback parser used and no recipient address or ENS name was found.'
          : 'Fallback parser used because the configured inference provider was unavailable.',
    });
  }

  private extractDeadline(input: string): Date {
    const minuteMatch = input.match(/\b(?:next|in|within)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+minutes?\b/);
    if (minuteMatch) {
      return new Date(Date.now() + this.numberWordToNumber(minuteMatch[1]) * 60 * 1000);
    }

    const hourMatch = input.match(/\b(?:next|in|within)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+hours?\b/);
    if (hourMatch) {
      return new Date(Date.now() + this.numberWordToNumber(hourMatch[1]) * 60 * 60 * 1000);
    }

    return new Date(Date.now() + 6 * 60 * 60 * 1000);
  }

  private extractRepeatCount(input: string): number {
    if (/\btwice\b/.test(input)) return 2;
    if (/\bthrice\b/.test(input)) return 3;

    const explicitCount = input.match(
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:times|x)\b/,
    )?.[1];

    return explicitCount ? this.numberWordToNumber(explicitCount) : 1;
  }

  private numberWordToNumber(value: string): number {
    const words: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    return words[value] ?? Number(value);
  }

  private extractChain(input: string): string | null {
    if (/\b(sepolia|testnet)\b/.test(input)) return 'sepolia';
    if (/\b(ethereum|mainnet| on eth\b| eth chain)\b/.test(input)) return 'ethereum';
    return null;
  }

  private async resolveZeroGModel(baseUrl: string, bearerToken: string): Promise<string> {
    if (this.zeroGModelId) {
      return this.zeroGModelId;
    }

    const configuredModel = this.config.get<string>('ZG_MODEL');
    if (configuredModel) {
      this.zeroGModelId = configuredModel;
      return configuredModel;
    }

    const response = await axios.get<{ data?: Array<{ id?: string }> }>(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${bearerToken}`,
      },
      timeout: 10_000,
    });

    const model = response.data.data?.find((entry) => entry.id)?.id;
    if (!model) {
      throw new Error('0G /models did not return any model ids');
    }

    this.zeroGModelId = model;
    return model;
  }
}
