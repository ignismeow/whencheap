import { Address } from 'viem';

export const sessionContractAddress = process.env.NEXT_PUBLIC_SESSION_CONTRACT as Address | undefined;
export const mainnetSessionContractAddress = process.env.NEXT_PUBLIC_MAINNET_SESSION_CONTRACT as
  | Address
  | undefined;

export const whenCheapSessionAbi = [
  {
    type: 'function',
    name: 'authorize',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'maxFeePerTxWei', type: 'uint256' },
      { name: 'maxTotalSpendWei', type: 'uint256' },
      { name: 'durationSeconds', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'agentAddress',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'treasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }]
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }]
  },
  {
    type: 'function',
    name: 'agentFeeSplit',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }]
  },
  {
    type: 'function',
    name: 'recordSpend',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'feeWei', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'revokeSession',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'feeForAmount',
    stateMutability: 'view',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'netAfterFee',
    stateMutability: 'view',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'agentFeeForAmount',
    stateMutability: 'view',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'treasuryFeeForAmount',
    stateMutability: 'view',
    inputs: [{ name: 'value', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'canExecute',
    stateMutability: 'view',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'feeWei', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'function',
    name: 'executeBatch',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' }
        ]
      }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'remainingBudget',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'isDelegated',
    stateMutability: 'view',
    inputs: [{ name: 'wallet', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'event',
    name: 'FeeCollected',
    inputs: [
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'feeWei', type: 'uint256', indexed: false },
      { name: 'totalValue', type: 'uint256', indexed: false },
      { name: 'feeType', type: 'string', indexed: false }
    ]
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
      { name: 'expiresAt', type: 'uint256' }
    ]
  }
] as const;
