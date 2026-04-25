import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ParsedIntent, parsedIntentSchema } from './parsed-intent.schema';

@Injectable()
export class OllamaIntentParser {
  private readonly logger = new Logger(OllamaIntentParser.name);

  constructor(private readonly config: ConfigService) {}

  async parse(input: string, wallet: string): Promise<ParsedIntent> {
    const baseUrl = this.config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
    const model = this.config.get<string>('OLLAMA_MODEL') ?? 'llama3.1';
    const timeoutMs = Number(this.config.get<string>('OLLAMA_TIMEOUT_MS') ?? 60000);

    try {
      const response = await axios.post(
        `${baseUrl.replace(/\/$/, '')}/api/generate`,
        {
          model,
          stream: false,
          format: 'json',
          prompt: this.buildPrompt(input, wallet)
        },
        { timeout: timeoutMs }
      );

      const rawContent = this.extractGeneratedContent(response.data);
      const cleaned = typeof rawContent === 'string' ? this.stripThinking(rawContent) : rawContent;
      const parsedJson = typeof cleaned === 'string' ? this.parseJsonContent(cleaned) : cleaned;
      return parsedIntentSchema.parse(parsedJson);
    } catch (error) {
      this.logger.warn(`Ollama parse failed; using fallback parser: ${String(error)}`);
      return this.fallbackParse(input);
    }
  }

  private buildPrompt(input: string, wallet: string): string {
    return [
      'You parse natural language Ethereum transaction intents for WhenCheap.',
      'Return only valid compact JSON with keys: type, fromToken, toToken, recipient, amount, maxFeeUsd, deadlineIso, chain, slippageBps, repeatCount, notes.',
      'type must be swap or send. For send intents, put the destination in recipient and omit toToken.',
      'For swap intents, omit recipient unless the user explicitly provides one.',
      'Use ISO datetime for deadlineIso.',
      'Use chain sepolia unless the user explicitly names another chain.',
      'maxFeeUsd and slippageBps must be numbers. amount must be a string.',
      'Use slippageBps 50 when slippage is unknown.',
      'Omit optional unknown fields instead of returning null.',
      'If a field is unknown, choose a conservative default and explain in notes.',
      'Intent payload:',
      JSON.stringify({
        wallet,
        nowIso: new Date().toISOString(),
        input
      })
    ].join('\n');
  }

  private extractGeneratedContent(data: unknown): unknown {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const body = data as Record<string, unknown>;
    const message = body.message && typeof body.message === 'object'
      ? body.message as Record<string, unknown>
      : undefined;

    // qwen3.5:35b with format:json puts the JSON in `thinking` and leaves `response` empty.
    // Prefer a non-empty response/content, then fall back to thinking as the answer.
    const primary = (body.response as string) || (message?.content as string);
    if (primary) return primary;

    return (body.thinking as string) || (message?.thinking as string);
  }

  private stripThinking(content: string): string {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  private parseJsonContent(content: string): unknown {
    try {
      return this.normalizeParsedJson(JSON.parse(content));
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error('Ollama response did not contain JSON');
      }
      return this.normalizeParsedJson(JSON.parse(match[0]));
    }
  }

  private normalizeParsedJson(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const parsed = { ...value } as Record<string, unknown>;
    for (const key of ['recipient', 'toToken', 'repeatCount', 'notes']) {
      if (parsed[key] === null) {
        delete parsed[key];
      }
    }
    // Zod .default() only fires on undefined — replace null numerics with their schema defaults
    if (parsed.slippageBps === null) parsed.slippageBps = 50;
    if (parsed.maxFeeUsd === null) parsed.maxFeeUsd = 1;

    if (parsed.chain === 'ethereum') {
      parsed.chain = 'sepolia';
    }

    return parsed;
  }

  private fallbackParse(input: string): ParsedIntent {
    const lower = input.toLowerCase();
    const isSend = /\bsend\b/.test(lower);
    const amount = lower.match(/\b(\d+(?:\.\d+)?)\s*(?:sepolia\s+)?(?:eth|weth|usdc|usdt|dai)\b/)?.[1]
      ?? lower.match(/(\d+(?:\.\d+)?)/)?.[1]
      ?? '0';
    const maxFeeUsd = Number(lower.match(/\$ ?(\d+(?:\.\d+)?)/)?.[1] ?? 1);
    const deadline = this.extractDeadline(lower);
    const repeatCount = Number(lower.match(/\b(\d+)\s*(?:times|x)\b/)?.[1] ?? 1);
    const recipient = input.match(/0x[a-fA-F0-9]{40}/)?.[0];

    const tokenPair = lower.match(/\b(eth|weth|usdc|usdt|dai)\s+(?:to|for|into)\s+(eth|weth|usdc|usdt|dai)\b/);
    const explicitToken = lower.match(/\b(?:sepolia\s+)?(eth|weth|usdc|usdt|dai)\b/)?.[1];
    const fromToken = tokenPair?.[1]?.toUpperCase() ?? explicitToken?.toUpperCase() ?? 'ETH';
    const toToken = tokenPair?.[2]?.toUpperCase() ?? 'USDC';

    const parsed = {
      type: isSend ? 'send' : 'swap',
      fromToken,
      ...(isSend ? { recipient } : { toToken }),
      amount,
      maxFeeUsd,
      deadlineIso: deadline.toISOString(),
      chain: 'sepolia',
      slippageBps: 50,
      repeatCount: repeatCount > 1 ? repeatCount : undefined,
      notes: isSend && !recipient
        ? 'Fallback parser used and no recipient address was found.'
        : 'Fallback parser used because Ollama was unavailable or returned invalid JSON.'
    };

    return parsedIntentSchema.parse(parsed);
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
      ten: 10
    };
    return words[value] ?? Number(value);
  }
}
