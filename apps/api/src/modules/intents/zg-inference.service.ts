import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export type InferenceProvider = '0G' | 'Groq' | 'Regex';

@Injectable()
export class ZgInferenceService implements OnModuleInit {
  private readonly logger = new Logger(ZgInferenceService.name);
  private zgClient: OpenAI | null = null;
  private groqClient: OpenAI | null = null;
  private activeProvider: InferenceProvider = 'Regex';
  private lastProviderUsed: InferenceProvider = 'Regex';

  private readonly INTENT_SYSTEM_PROMPT = `You are an intent parser for a crypto transaction agent.
Extract transaction details from user input and return ONLY valid JSON. No explanation, no markdown.

CRITICAL RULES:
- amount: extract the EXACT number typed. "0.001 ETH" -> 0.001. NEVER round or change it.
- maxFeeUsd: extract from "under $X" or "gas under $X" -> X as number. "under $1" -> 1
- deadlineMinutes: extract from "in next X minutes" or "within X minutes" -> X as number
- chain: "sepolia" -> "sepolia", "mainnet"/"ethereum" -> "mainnet", not mentioned -> "mainnet"
- type: "send" if recipient address present, "swap" if toToken present
- toToken: token symbol after "to" -> USDC, DAI, USDT, WETH, ETH
- fromToken: "ETH" unless user explicitly says otherwise
- recipient: only if user provides 0x address or ENS name, otherwise null

Return ONLY this JSON, nothing else:
{
  "type": "send" | "swap",
  "amount": number,
  "fromToken": string,
  "toToken": string | null,
  "recipient": string | null,
  "maxFeeUsd": number,
  "deadlineMinutes": number | null,
  "chain": "sepolia" | "mainnet"
}`;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.initialize0G();
    this.initializeGroq();
  }

  private async initialize0G(): Promise<void> {
    try {
      const apiKey = this.config.get<string>('ZG_API_KEY');
      const baseUrl =
        this.config.get<string>('ZG_BASE_URL') ?? 'https://router-api.testnet.0g.ai/v1';

      if (!apiKey) {
        this.logger.warn('ZG_API_KEY not set — 0G unavailable');
        return;
      }

      this.zgClient = new OpenAI({
        baseURL: baseUrl,
        apiKey,
      });

      await this.zgClient.chat.completions.create({
        model: this.config.get<string>('ZG_MODEL') ?? 'qwen/qwen-2.5-7b-instruct',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      });

      this.activeProvider = '0G';
      this.logger.log('0G Router inference initialized successfully');
    } catch (err) {
      this.logger.warn(`0G init failed: ${String(err)} — falling back to Groq`);
      this.zgClient = null;
    }
  }

  private initializeGroq(): void {
    const groqKey = this.config.get<string>('GROQ_API_KEY');
    if (!groqKey) {
      this.logger.warn('GROQ_API_KEY not set — Groq fallback unavailable');
      return;
    }

    this.groqClient = new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: groqKey,
    });

    if (this.activeProvider === 'Regex') {
      this.activeProvider = 'Groq';
    }

    this.logger.log('Groq fallback initialized');
  }

  async parseIntent(rawInput: string): Promise<Record<string, unknown>> {
    if (this.zgClient) {
      try {
        const result = await this.callInference(
          this.zgClient,
          'qwen/qwen-2.5-7b-instruct',
          rawInput,
          '0G',
        );
        this.lastProviderUsed = '0G';
        return result;
      } catch (err) {
        this.logger.warn(`0G inference failed: ${String(err)} — trying Groq fallback`);
      }
    }

    if (this.groqClient) {
      try {
        const result = await this.callInference(
          this.groqClient,
          'llama-3.3-70b-versatile',
          rawInput,
          'Groq',
        );
        this.lastProviderUsed = 'Groq';
        return result;
      } catch (err) {
        this.logger.warn(`Groq inference failed: ${String(err)}`);
      }
    }

    this.logger.warn('All inference providers failed — using regex fallback');
    this.lastProviderUsed = 'Regex';
    return this.regexFallback(rawInput);
  }

  private async callInference(
    client: OpenAI,
    model: string,
    rawInput: string,
    providerName: string,
  ): Promise<Record<string, unknown>> {
    const resolvedModel =
      providerName === '0G' ? (this.config.get<string>('ZG_MODEL') ?? model) : model;

    const completion = await client.chat.completions.create({
      model: resolvedModel,
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: 'system', content: this.INTENT_SYSTEM_PROMPT },
        { role: 'user', content: rawInput },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    if (!parsed.amount || Number(parsed.amount) <= 0) {
      throw new Error(`Invalid amount: ${parsed.amount}`);
    }
    if (!parsed.type) {
      throw new Error('Could not determine intent type');
    }

    this.logger.log(`[${providerName}] Parsed: ${JSON.stringify(parsed)}`);
    return parsed;
  }

  private regexFallback(input: string): Record<string, unknown> {
    const amount = input.match(/(\d+\.?\d*)\s*(ETH|DAI|USDC|USDT|WETH)/i);
    const maxFee = input.match(/under\s*\$(\d+\.?\d*)/i);
    const toToken = input.match(/\bto\s+(USDC|DAI|USDT|WETH|ETH)\b/i);
    const recipient = input.match(/(0x[a-fA-F0-9]{40})/);
    const deadline =
      input.match(/next\s+(\d+)\s+minutes/i) ??
      input.match(/within\s+(\d+)\s+minutes/i) ??
      input.match(/in\s+(\d+)\s+minutes/i);
    const chain = input.match(/\b(sepolia|mainnet|ethereum)\b/i);

    const fromToken = amount?.[2]?.toUpperCase() ?? 'ETH';
    const type = recipient ? 'send' : 'swap';

    return {
      type,
      amount: parseFloat(amount?.[1] ?? '0'),
      fromToken,
      toToken: toToken?.[1]?.toUpperCase() ?? (type === 'swap' ? 'USDC' : null),
      recipient: recipient?.[1] ?? null,
      maxFeeUsd: parseFloat(maxFee?.[1] ?? '2'),
      deadlineMinutes: deadline ? parseInt(deadline[1], 10) : null,
      chain:
        chain?.[1]?.toLowerCase() === 'ethereum'
          ? 'mainnet'
          : (chain?.[1]?.toLowerCase() ?? 'mainnet'),
    };
  }

  get currentProvider(): InferenceProvider {
    return this.lastProviderUsed ?? this.activeProvider;
  }

  get isZgActive(): boolean {
    return this.activeProvider === '0G';
  }
}
