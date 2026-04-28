import { z } from 'zod';

export const parsedIntentSchema = z.object({
  type: z.enum(['swap', 'send']).default('swap'),
  fromToken: z.string().min(1),
  toToken: z.string().min(1).optional(),
  recipient: z.string().optional(),
  resolvedRecipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  amount: z.string().min(1),
  maxFeeUsd: z.number().positive(),
  deadlineIso: z.string().datetime(),
  chain: z.string().default('sepolia'),
  slippageBps: z.number().int().min(1).max(5000).default(50),
  repeatCount: z.number().int().positive().optional(),
  notes: z.string().optional()
});

export type ParsedIntent = z.infer<typeof parsedIntentSchema>;
