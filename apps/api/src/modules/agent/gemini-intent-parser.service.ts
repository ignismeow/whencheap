import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ParsedIntent, parsedIntentSchema } from './parsed-intent.schema';

@Injectable()
export class GeminiIntentParser {
  private readonly logger = new Logger(GeminiIntentParser.name);

  constructor(private readonly config: ConfigService) {}

  async parse(input: string, wallet: string): Promise<ParsedIntent> {
    const apiKey = this.config.get<string>('GEMINI_API_KEY') ?? '';
    const apiUrl = this.config.get<string>('GEMINI_API_URL') ?? 'https://generativelanguage.googleapis.com/v1beta';
    const model = this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash';
    const timeoutMs = Number(this.config.get<string>('GEMINI_TIMEOUT_MS') ?? 30000);

    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not set; using fallback parser.');
      return this.fallbackParse(input);
    }

    try {
      const response = await axios.post(
        `${apiUrl.replace(/\/$/, '')}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          contents: [
            {
              role: 'user',
              parts: [{ text: this.buildPrompt(input, wallet) }]
            }
          ],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json'
          }
        },
        { timeout: timeoutMs }
      );

      const rawContent = this.extractGeneratedContent(response.data);
      const cleaned = typeof rawContent === 'string' ? this.stripThinking(rawContent) : rawContent;
      const parsedJson = typeof cleaned === 'string' ? this.parseJsonContent(cleaned) : cleaned;
      return parsedIntentSchema.parse(parsedJson);
    } catch (error) {
      this.logger.warn(`Gemini parse failed; using fallback parser: ${String(error)}`);
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
      'CRITICAL PARSING RULES:',
      'amount: extract the exact number the user typed. "0.001 ETH" = 0.001, not 10 and not 1.',
      'maxFeeUsd: extract from "when gas is under $X". "under $1" = 1, "under $2" = 2.',
      'If user says "in next 30 minutes" or "in 30 minutes", set the deadline to now plus exactly that duration.',
      'recipient: only set it if the user explicitly provides an address or ENS name.',
      'chain: if the user says sepolia or testnet use sepolia. If no chain is mentioned, swaps default to ethereum and sends default to sepolia.',
      'type: use send when the user explicitly says send and provides a recipient. Use swap when the user names an output token.',
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

    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const firstCandidate = candidates[0] && typeof candidates[0] === 'object'
      ? candidates[0] as Record<string, unknown>
      : undefined;
    const content = firstCandidate?.content && typeof firstCandidate.content === 'object'
      ? firstCandidate.content as Record<string, unknown>
      : undefined;
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const firstPart = parts[0] && typeof parts[0] === 'object'
      ? parts[0] as Record<string, unknown>
      : undefined;
    if (typeof firstPart?.text === 'string') {
      return firstPart.text;
    }

    // Also support simple local/mock payloads in tests.
    const primary = (body.response as string) || (message?.content as string);
    if (primary) return primary;

    return (body.thinking as string) || (message?.thinking as string);
  }

  private stripThinking(content: string): string {
    return content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  private parseJsonContent(content: string): unknown {
    try {
      return this.normalizeParsedJson(JSON.parse(content), content);
    } catch {
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) {
        throw new Error('Gemini response did not contain JSON');
      }
      return this.normalizeParsedJson(JSON.parse(match[0]), content);
    }
  }

  private normalizeParsedJson(value: unknown, input = ''): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const parsed = { ...value } as Record<string, unknown>;
    const lower = input.toLowerCase();
    const explicitChain = this.extractChain(lower);
    const explicitDeadline = this.extractDeadline(lower);
    const explicitAmount = this.extractExactAmount(input);
    const explicitMaxFeeUsd = this.extractMaxFeeUsd(input);
    const explicitTokenPair = this.extractTokenPair(lower);
    const explicitRecipient = input.match(/0x[a-fA-F0-9]{40}|\b[a-z0-9-]+\.eth\b/i)?.[0];
    const isExplicitSend = /\bsend\b/i.test(input);
    const isExplicitSwap = /\bswap\b|\bexchange\b|\btrade\b/i.test(input);

    for (const key of ['recipient', 'toToken', 'repeatCount', 'notes']) {
      if (parsed[key] === null) {
        delete parsed[key];
      }
    }
    // Zod .default() only fires on undefined — replace null numerics with their schema defaults
    if (parsed.slippageBps === null) parsed.slippageBps = 50;
    if (parsed.maxFeeUsd === null) parsed.maxFeeUsd = 1;

    if (parsed.chain === null) delete parsed.chain;
    if (typeof parsed.chain !== 'string' || !parsed.chain.trim()) {
      parsed.chain = parsed.type === 'swap' ? 'ethereum' : 'sepolia';
    }

    if (explicitAmount) {
      parsed.amount = explicitAmount;
    }
    if (explicitMaxFeeUsd !== null) {
      parsed.maxFeeUsd = explicitMaxFeeUsd;
    }
    if (explicitTokenPair) {
      parsed.fromToken = explicitTokenPair.fromToken;
      if (explicitTokenPair.toToken) {
        parsed.toToken = explicitTokenPair.toToken;
      }
    }

    if (isExplicitSend && !isExplicitSwap) {
      parsed.type = 'send';
      if (explicitRecipient) {
        parsed.recipient = explicitRecipient;
      }
      delete parsed.toToken;
    } else if (isExplicitSwap) {
      parsed.type = 'swap';
    }

    if (explicitChain) {
      parsed.chain = explicitChain;
    }

    if (explicitDeadline) {
      parsed.deadlineIso = explicitDeadline.toISOString();
    }

    return parsed;
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
      chain: explicitChain ?? (isSend ? 'sepolia' : 'ethereum'),
      slippageBps: 50,
      repeatCount: repeatCount > 1 ? repeatCount : undefined,
      notes: isSend && !recipient
        ? 'Fallback parser used and no recipient address was found.'
        : 'Fallback parser used because Gemini was unavailable or returned invalid JSON.'
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
      ten: 10
    };
    return words[value] ?? Number(value);
  }

  private extractChain(input: string): string | null {
    if (/\b(sepolia|testnet)\b/.test(input)) return 'sepolia';
    if (/\b(ethereum|mainnet| on eth\b| eth chain)\b/.test(input)) return 'ethereum';
    return null;
  }

  private extractExactAmount(input: string): string | null {
    return (
      input.match(/\b(?:send|swap)\s+([0-9]*\.?[0-9]+)/i)?.[1] ??
      input.match(/\b([0-9]*\.?[0-9]+)\s*(?:eth|weth|usdc|usdt|dai)\b/i)?.[1] ??
      null
    );
  }

  private extractMaxFeeUsd(input: string): number | null {
    const value = input.match(/\b(?:when\s+gas\s+is\s+under|under)\s*\$ ?([0-9]*\.?[0-9]+)/i)?.[1];
    return value ? Number(value) : null;
  }

  private extractTokenPair(input: string): { fromToken: string; toToken?: string } | null {
    const tokenPair = input.match(/\b(eth|weth|usdc|usdt|dai)\s+(?:to|for|into)\s+(eth|weth|usdc|usdt|dai)\b/i);
    if (tokenPair) {
      return {
        fromToken: tokenPair[1].toUpperCase(),
        toToken: tokenPair[2].toUpperCase(),
      };
    }

    const explicitToken = input.match(/\b(?:send|swap)\s+[0-9]*\.?[0-9]+\s+([a-zA-Z]+)/i)?.[1];
    return explicitToken ? { fromToken: explicitToken.toUpperCase() } : null;
  }
}
