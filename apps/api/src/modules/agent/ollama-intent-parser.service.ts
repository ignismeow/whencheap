import { Injectable, Logger } from '@nestjs/common';
import { ParsedIntent, parsedIntentSchema } from './parsed-intent.schema';
import { ZgInferenceService } from '../intents/zg-inference.service';

export type IntentInferenceProvider = '0G' | 'Groq' | 'Regex';

export interface IntentParseResult {
  parsed: ParsedIntent;
  providerUsed: IntentInferenceProvider;
}

@Injectable()
export class OllamaIntentParserService {
  private readonly logger = new Logger(OllamaIntentParserService.name);

  constructor(private readonly zgInference: ZgInferenceService) {}

  async parse(input: string, _wallet: string): Promise<IntentParseResult> {
    try {
      const raw = await this.zgInference.parseIntent(input);
      const parsed = parsedIntentSchema.parse(this.normalizeParsedJson(raw, input));
      return { parsed, providerUsed: this.zgInference.currentProvider };
    } catch (error) {
      this.logger.warn(`Inference parse failed; using fallback parser: ${String(error)}`);
      return { parsed: this.fallbackParse(input), providerUsed: 'Regex' };
    }
  }

  private normalizeParsedJson(value: unknown, input: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const parsed = { ...value } as Record<string, unknown>;
    const lower = input.toLowerCase();
    const explicitChain = this.extractChain(lower);
    const explicitDeadline = this.extractExplicitDeadline(lower);
    const explicitAmount = this.extractExactAmount(input);
    const explicitMaxFeeUsd = this.extractMaxFeeUsd(input);
    const explicitTokenPair = this.extractTokenPair(lower);
    const explicitRecipient = input.match(/0x[a-fA-F0-9]{40}|\b[a-z0-9-]+\.eth\b/i)?.[0];
    const isExplicitSend = /\bsend\b/i.test(input);
    const isExplicitSwap = /\bswap\b|\bexchange\b|\btrade\b/i.test(input);

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

    if (explicitAmount) {
      parsed.amount = explicitAmount;
    }
    if (typeof parsed.amount === 'number') {
      parsed.amount = String(parsed.amount);
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

    if (typeof parsed.deadlineIso === 'string' && parsed.deadlineIso.startsWith('PT')) {
      const durationMatch = parsed.deadlineIso.match(/^PT(\d+)(M|H)$/i);
      if (durationMatch) {
        const amount = Number(durationMatch[1]);
        const minutes = durationMatch[2].toUpperCase() === 'H' ? amount * 60 : amount;
        parsed.deadlineIso = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      }
    }

    if (typeof parsed.deadlineMinutes === 'number' && Number.isFinite(parsed.deadlineMinutes)) {
      parsed.deadlineIso = new Date(Date.now() + parsed.deadlineMinutes * 60 * 1000).toISOString();
      delete parsed.deadlineMinutes;
    }

    if (explicitDeadline) {
      const parsedDeadlineMs =
        typeof parsed.deadlineIso === 'string' ? new Date(parsed.deadlineIso).getTime() : Number.NaN;
      const explicitDeadlineMs = explicitDeadline.getTime();
      const skewMs = Math.abs(parsedDeadlineMs - explicitDeadlineMs);

      if (!Number.isFinite(parsedDeadlineMs) || skewMs > 2 * 60 * 1000) {
        parsed.deadlineIso = explicitDeadline.toISOString();
      }
    }

    return parsed;
  }

  private fallbackParse(input: string): ParsedIntent {
    const lower = input.toLowerCase();
    let type: 'send' | 'swap';
    if (/\bsend\b/i.test(input)) {
      type = 'send';
    } else if (/\bswap\b|\bexchange\b|\btrade\b/i.test(input)) {
      type = 'swap';
    } else {
      type = 'swap';
    }
    const isSend = type === 'send';
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
    const explicitDeadline = this.extractExplicitDeadline(input);
    if (explicitDeadline) {
      return explicitDeadline;
    }

    return new Date(Date.now() + 6 * 60 * 60 * 1000);
  }

  private extractExplicitDeadline(input: string): Date | null {
    const durationMatch =
      input.match(
        /in\s+(?:the\s+)?next\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(minute|minutes|min|hour|hours|hr)/i,
      ) ??
      input.match(
        /in\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(minute|minutes|min|hour|hours|hr)/i,
      ) ??
      input.match(
        /within\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(minute|minutes|min|hour|hours|hr)/i,
      );

    if (durationMatch) {
      const amount = this.numberWordToNumber(durationMatch[1]);
      const unit = durationMatch[2].toLowerCase();
      const minutes = unit.startsWith('h') ? amount * 60 : amount;
      return new Date(Date.now() + minutes * 60 * 1000);
    }

    return null;
  }

  private extractRepeatCount(input: string): number {
    if (/\btwice\b/.test(input)) return 2;
    if (/\bthrice\b/.test(input)) return 3;

    const explicitCount = input.match(
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:times|x)\b/,
    )?.[1];

    return explicitCount ? this.numberWordToNumber(explicitCount) : 1;
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
}
