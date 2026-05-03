import { Address } from 'viem';

export const sessionContractAddress = process.env.NEXT_PUBLIC_SESSION_CONTRACT as Address | undefined;
export const mainnetSessionContractAddress = process.env.NEXT_PUBLIC_MAINNET_SESSION_CONTRACT as
  | Address
  | undefined;

export const whenCheapSessionAbi = [
  // ── Deposits ──────────────────────────────────────────
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'deposits',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'remainingDeposit',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── Session ───────────────────────────────────────────
  {
    type: 'function',
    name: 'authorize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'maxFeePerTxWei', type: 'uint256' },
      { name: 'maxTotalSpendWei', type: 'uint256' },
      { name: 'durationSeconds', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeSession',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'sessions',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [
      { name: 'maxFeePerTxWei', type: 'uint256' },
      { name: 'maxTotalSpendWei', type: 'uint256' },
      { name: 'spentWei', type: 'uint256' },
      { name: 'expiresAt', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'canExecute',
    stateMutability: 'view',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'feeWei', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'canExecuteWithDeposit',
    stateMutability: 'view',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'feeWei', type: 'uint256' },
      { name: 'intentAmount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'remainingBudget',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── Fee helpers ───────────────────────────────────────
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'agentFeeSplit',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'agentAddress',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'treasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'agentFeeForAmount',
    stateMutability: 'view',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'feeForAmount',
    stateMutability: 'view',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'netAfterFee',
    stateMutability: 'view',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── Misc view ─────────────────────────────────────────
  {
    type: 'function',
    name: 'isDelegated',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdrawn',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionAuthorized',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'maxFeePerTxWei', type: 'uint256', indexed: false },
      { name: 'maxTotalSpendWei', type: 'uint256', indexed: false },
      { name: 'expiresAt', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionRevoked',
    inputs: [
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'refundAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;
