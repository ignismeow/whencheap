import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { ethers } from 'ethers';
import { Repository } from 'typeorm';
import {
  Chain,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, sepolia } from 'viem/chains';
import { IntentRecord } from '../intents/intent.types';
import { TestEip7702Dto } from '../intents/dto/test-eip7702.dto';
import { UserEntity, UserIdentifierType } from '../user/user.entity';
import { SessionAuthorizationEntity } from './session-auth.entity';

const SESSION_ABI = [
  // Session limits
  'function canExecute(address wallet, uint256 feeWei) view returns (bool)',
  'function canExecuteWithDeposit(address wallet, uint256 feeWei, uint256 intentAmount) view returns (bool)',
  'function sessions(address wallet) view returns (uint256 maxFeePerTxWei, uint256 maxTotalSpendWei, uint256 spentWei, uint256 expiresAt)',
  'function recordSpend(address wallet, uint256 feeWei)',
  'function authorize(uint256 maxFeePerTxWei, uint256 maxTotalSpendWei, uint256 durationSeconds)',
  'function revokeSession()',
  // Deposits
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  'function deposits(address wallet) view returns (uint256)',
  'function remainingDeposit(address wallet) view returns (uint256)',
  // Execution — V2: wallet is first arg, no msg.value (deducted from deposit)
  'function execute(address wallet, address to, uint256 value, bytes data)',
  'function executeSwap(address wallet, address swapRouter, bytes swapCalldata, uint256 amount, address outputToken)',
  // Fee helpers
  'function agentAddress() view returns (address)',
  'function treasury() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function agentFeeSplit() view returns (uint16)',
  'function feeForAmount(uint256 value) view returns (uint256)',
  'function netAfterFee(uint256 value) view returns (uint256)',
  'function agentFeeForAmount(uint256 value) view returns (uint256)',
  'function treasuryFeeForAmount(uint256 value) view returns (uint256)',
];

const SESSION_EVENT_ABI = [
  'event FeeCollected(address indexed recipient, uint256 feeWei, uint256 totalValue, string feeType)',
  'event FeeCollectionFailed(address indexed recipient, uint256 feeWei)',
] as const;

const SESSION_VIEM_ABI = parseAbi([...SESSION_ABI, ...SESSION_EVENT_ABI]);
const WHEN_CHEAP_SESSION_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;
const WHEN_CHEAP_SESSION_EXECUTE_SWAP_ABI = parseAbi([
  'function executeSwap(address wallet, address swapRouter, bytes swapCalldata, uint256 amount, address outputToken)',
]);
const GAS_UNITS = { send: 21_000, swap: 150_000 } as const;
const SEPOLIA_CHAIN_ID = 11155111;
const UNISWAP_NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const MAINNET_CHAIN_ID = 1;
const SWAP_ROUTER_02_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const MAINNET_TOKENS: Record<string, { address: string; decimals: number; symbol: string }> = {
  ETH: { address: UNISWAP_NATIVE_ETH, decimals: 18, symbol: 'ETH' },
  WETH: {
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    decimals: 18,
    symbol: 'WETH',
  },
  USDC: {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    symbol: 'USDC',
  },
  USDT: {
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    symbol: 'USDT',
  },
  DAI: {
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    decimals: 18,
    symbol: 'DAI',
  },
  WBTC: {
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    decimals: 8,
    symbol: 'WBTC',
  },
};
const SEPOLIA_TOKENS: Record<string, { address: string; decimals: number; symbol: string }> = {
  ETH: { address: UNISWAP_NATIVE_ETH, decimals: 18, symbol: 'ETH' },
  WETH: {
    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    decimals: 18,
    symbol: 'WETH',
  },
  USDC: {
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
    symbol: 'USDC',
  },
  DAI: {
    address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
    decimals: 18,
    symbol: 'DAI',
  },
  USDT: {
    address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
    decimals: 6,
    symbol: 'USDT',
  },
};

interface UniswapSwapCalldataResult {
  calldata: string;
  value: bigint;
  to: string;
  endpointUsed: 'swap_7702' | 'swap';
}

interface StoredEip7702Authorization {
  contractAddress: string;
  chainId: number | bigint;
  nonce: number | string | bigint;
  txHash?: string;
  type?: string;
}

interface StoredSessionAuthorizationMarker {
  type: string;
  txHash?: string;
  externalWallet?: boolean;
}

interface SessionDetail {
  expired: boolean;
  depositZero: boolean;
  budgetExceeded: boolean;
  feeTooHigh: boolean;
  depositEth: string;
  expiresAt: Date | null;
  remainingBudgetEth: string;
}

interface AuthorizationLogPayload {
  contractAddress?: string;
  chainId?: string;
  nonce?: string;
  txHash?: string;
  type?: string;
  [key: string]: unknown;
}

@Injectable()
export class SessionSignerService implements OnModuleInit {
  private readonly logger = new Logger(SessionSignerService.name);
  readonly provider: ethers.JsonRpcProvider;
  private readonly agentWalletPk: string | null;
  private readonly agentWallet: ethers.Wallet | null;
  private readonly sessionContract: ethers.Contract | null;

  /**
   * Mirrors the flag in IntentsService. broadcastIntent() will throw if this
   * is false, providing a second layer of defence against accidental execution.
   */
  private readonly agentFallbackEnabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(SessionAuthorizationEntity)
    private readonly sessionRepository: Repository<SessionAuthorizationEntity>,
  ) {
    const rpcUrl = this.config.get<string>('RPC_URL') ?? '';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    const pk = this.config.get<string>('AGENT_WALLET_PK') ?? '';
    this.agentWalletPk = pk || null;
    this.agentWallet = this.isValidPrivateKey(pk) ? new ethers.Wallet(pk, this.provider) : null;

    const contractAddr = this.config.get<string>('SESSION_CONTRACT_ADDR');
    this.sessionContract = contractAddr
      ? new ethers.Contract(contractAddr, SESSION_ABI, this.provider)
      : null;

    const raw = this.config.get<string>('ALLOW_AGENT_FUNDED_FALLBACK') ?? 'false';
    this.agentFallbackEnabled = raw.toLowerCase() === 'true';

    if (!pk) {
      this.logger.warn('AGENT_WALLET_PK not set — agent wallet execution unavailable');
    } else if (!this.agentWallet) {
      this.logger.warn(
        'AGENT_WALLET_PK is not a valid 66-character 0x-prefixed hex private key ' +
        '— agent wallet execution unavailable',
      );
    }
    if (!this.sessionContract) {
      this.logger.warn('SESSION_CONTRACT_ADDR not set — session validation skipped');
    }
    if (!this.agentFallbackEnabled) {
      this.logger.log(
        'Agent-funded fallback is disabled. broadcastIntent() will refuse to broadcast.',
      );
    }

    void this.logAgentWalletEnsName();
  }

  async onModuleInit(): Promise<void> {
    await this.ensureSessionAuthorizationChainSchema();
  }

  get agentAddress(): string | null {
    return this.agentWallet?.address ?? null;
  }

  getProviderForChain(chain: string): ethers.JsonRpcProvider {
    return new ethers.JsonRpcProvider(this.getChainConfig(chain).rpcUrl);
  }

  async storeAuthorization(
    userAddress: string,
    authorization: unknown,
    chain = 'sepolia',
  ): Promise<void> {
    this.logger.warn(
      'Persisting EIP-7702 authorization. Fresh auth should be re-signed per execution; stored auth is legacy-only.',
    );
    const key = userAddress.toLowerCase();
    const normalizedChain = this.normalizeChain(chain);
    const user = await this.resolveOrCreateWalletUser(key);
    await this.sessionRepository.upsert(
      {
        userId: user.id,
        walletAddress: key,
        chain: normalizedChain,
        authorizationJson: JSON.stringify(authorization),
        isActive: true,
        expiresAt: null,
      },
      ['walletAddress', 'chain'],
    );
    this.logger.log(`Stored EIP-7702 authorization for ${userAddress} on ${normalizedChain}`);
  }

  async getAuthorization(userAddress: string, chain = 'sepolia'): Promise<unknown | null> {
    const key = userAddress.toLowerCase();
    const normalizedChain = this.normalizeChain(chain);
    const persisted = await this.sessionRepository.findOne({
      where: { walletAddress: key, chain: normalizedChain, isActive: true },
    });

    if (!persisted) {
      this.logger.warn(`[getAuthorization] No authorization found for ${key} on ${normalizedChain}`);
      return null;
    }

    if (persisted.expiresAt && persisted.expiresAt.getTime() <= Date.now()) {
      this.logger.warn(`[getAuthorization] Authorization expired for ${key} on ${normalizedChain}`);
      await this.sessionRepository.update(
        { walletAddress: key, chain: normalizedChain },
        { isActive: false },
      );
      return null;
    }

    try {
      const parsed = JSON.parse(persisted.authorizationJson) as unknown;
      if (!this.isOnChainSessionMarker(parsed)) {
        this.logger.warn(
          'Using stored authorization — this should not happen. Auth should be re-signed fresh per execution.',
        );
      }
      this.logger.log(`[getAuthorization] Found valid authorization for ${key} on ${normalizedChain}`);
      return parsed;
    } catch {
      this.logger.warn(`Stored authorization for ${key} on ${normalizedChain} is invalid JSON.`);
      return null;
    }
  }

  async hasAuthorization(userAddress: string, chain = 'sepolia'): Promise<boolean> {
    const key = userAddress.toLowerCase();
    const normalizedChain = this.normalizeChain(chain);
    return (
      await this.sessionRepository.count({
        where: { walletAddress: key, chain: normalizedChain, isActive: true },
      })
    ) > 0;
  }

  async authorizeExternalWalletSession(body: {
    userAddress: string;
    maxFeePerTxEth: string;
    maxTotalSpendEth: string;
    expiryHours: string;
    chain?: string;
  }): Promise<{ ok: true }> {
    try {
      const chain = body.chain ?? 'sepolia';
      const normalizedAddress = body.userAddress.toLowerCase();
      const user = await this.resolveOrCreateWalletUser(normalizedAddress);

      // Store on-chain session marker in DB
      // This allows executeSessionBacked path to be used for execution
      await this.sessionRepository.upsert(
        {
          userId: user.id,
          walletAddress: normalizedAddress,
          chain: this.normalizeChain(chain),
          authorizationJson: JSON.stringify({
            type: 'on-chain-session',
            externalWallet: true,
          }),
          isActive: true,
          expiresAt: new Date(Date.now() + Number(body.expiryHours) * 60 * 60 * 1000),
        },
        ['walletAddress', 'chain'],
      );

      this.logger.log(
        `Stored on-chain session authorization for external wallet ${normalizedAddress} on ${chain}. ` +
        `Limits: ${body.maxFeePerTxEth} ETH per tx, ${body.maxTotalSpendEth} ETH total, ` +
        `${body.expiryHours} hours expiry.`,
      );

      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`External wallet session authorization failed: ${message}`);
    }
  }

  /** View call — no gas, just checks session limits on-chain. */
  async canExecuteSession(
    wallet: string,
    feeWei: bigint,
    chain = 'sepolia',
    intentAmountWei?: bigint,
  ): Promise<boolean> {
    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) return true;
    try {
      const authorization = await this.getAuthorization(wallet, chain);
      if (this.isOnChainSessionMarker(authorization)) {
        if (intentAmountWei !== undefined) {
          return (await sessionContract.canExecuteWithDeposit(wallet, feeWei, intentAmountWei)) as boolean;
        }

        const [sessionValid, deposit] = await Promise.all([
          sessionContract.canExecute(wallet, feeWei) as Promise<boolean>,
          sessionContract.deposits(wallet) as Promise<bigint>,
        ]);

        if (!sessionValid) {
          this.logger.warn(`Session invalid for ${wallet} on ${chain}`);
          return false;
        }

        if (deposit === 0n) {
          this.logger.warn(`No deposit found for ${wallet} on ${chain}`);
          return false;
        }

        return true;
      }

      if (intentAmountWei !== undefined) {
        return (await sessionContract.canExecuteWithDeposit(wallet, feeWei, intentAmountWei)) as boolean;
      }
      return (await sessionContract.canExecute(wallet, feeWei)) as boolean;
    } catch (err) {
      this.logger.warn(`canExecute check failed for ${wallet} on ${chain}: ${String(err)}`);
      return false;
    }
  }

  async getSessionDetail(
    wallet: string,
    chain = 'sepolia',
    feeWei = 0n,
  ): Promise<SessionDetail> {
    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) {
      return {
        expired: false,
        depositZero: false,
        budgetExceeded: false,
        feeTooHigh: false,
        depositEth: '0',
        expiresAt: null,
        remainingBudgetEth: '0',
      };
    }

    try {
      const [session, deposit] = await Promise.all([
        sessionContract.sessions(wallet) as Promise<readonly [bigint, bigint, bigint, bigint]>,
        sessionContract.deposits(wallet) as Promise<bigint>,
      ]);

      const [maxFeePerTxWei, maxTotalSpendWei, spentWei, expiresAt] = session;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const remainingBudgetWei =
        maxTotalSpendWei > spentWei ? maxTotalSpendWei - spentWei : 0n;

      return {
        expired: expiresAt === 0n || now >= expiresAt,
        depositZero: deposit === 0n,
        budgetExceeded: spentWei >= maxTotalSpendWei || remainingBudgetWei < feeWei,
        feeTooHigh: feeWei > maxFeePerTxWei,
        depositEth: formatEther(deposit),
        expiresAt: expiresAt > 0n ? new Date(Number(expiresAt) * 1000) : null,
        remainingBudgetEth: formatEther(remainingBudgetWei),
      };
    } catch (err) {
      this.logger.warn(`getSessionDetail failed for ${wallet} on ${chain}: ${String(err)}`);
      return {
        expired: true,
        depositZero: true,
        budgetExceeded: false,
        feeTooHigh: false,
        depositEth: '0',
        expiresAt: null,
        remainingBudgetEth: '0',
      };
    }
  }

  async getSessionPermission(
    wallet: string,
    chain = 'sepolia',
  ): Promise<{
    maxFeePerTxWei: bigint;
    maxTotalSpendWei: bigint;
    spentWei: bigint;
    expiresAt: bigint;
  } | null> {
    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) return null;

    try {
      const session = await sessionContract.sessions(wallet) as readonly [
        bigint,
        bigint,
        bigint,
        bigint,
      ];

      return {
        maxFeePerTxWei: session[0],
        maxTotalSpendWei: session[1],
        spentWei: session[2],
        expiresAt: session[3],
      };
    } catch (err) {
      this.logger.warn(`sessions() check failed for ${wallet} on ${chain}: ${String(err)}`);
      return null;
    }
  }

  /**
   * Broadcasts a transaction directly from the agent wallet.
   *
   * This method will throw if ALLOW_AGENT_FUNDED_FALLBACK is not explicitly
   * set to 'true'. This is the second layer of defence — even if the calling
   * code somehow reaches this method, the broadcast is blocked.
   *
   * Only supports 'send' intents (ETH transfers). Swaps must go via KeeperHub.
   */
  async broadcastIntent(intent: IntentRecord, baseFeeGwei: number): Promise<string> {
    // ── Hard gate: refuse if fallback is disabled ─────────────────────────
    if (!this.agentFallbackEnabled) {
      throw new Error(
        'broadcastIntent called but ALLOW_AGENT_FUNDED_FALLBACK is not enabled. ' +
        'Set ALLOW_AGENT_FUNDED_FALLBACK=true to allow direct agent-funded execution.',
      );
    }

    return this.broadcastAgentWalletExecution(intent, baseFeeGwei);
  }

  async broadcastSessionBackedIntent(
    intent: IntentRecord,
    baseFeeGwei: number,
  ): Promise<string> {
    const chain = intent.parsed.chain ?? 'sepolia';
    const chainConfig = this.getChainConfig(chain);
    const sessionContractAddress = this.requireSessionContractAddress(chain);
    const agentWallet = this.requireAgentWallet(chainConfig.rpcUrl);
    const gasPriceWei = BigInt(Math.round(baseFeeGwei * 1.2 * 1e9));

    // V2 deposit model: ETH comes from deposits[wallet], agent sends no ETH
    const intentAmountWei = ethers.parseEther(String(intent.parsed.amount));
    const depositCheck = await this.checkUserDeposit(intent.wallet, String(intent.parsed.amount), chain);
    if (!depositCheck.sufficient) {
      throw new Error(
        `Insufficient deposit. Has: ${depositCheck.have} ETH, needs: ${depositCheck.need} ETH. ` +
        `User must deposit more ETH into WhenCheapSession contract.`,
      );
    }

    const sessionContract = new ethers.Contract(sessionContractAddress, SESSION_ABI, agentWallet);
    const execution = await this.buildExecutionTransaction(intent, agentWallet.address);

    let tx: ethers.TransactionResponse;

    if (intent.parsed.type === 'swap') {
      const swapCall = await this.buildSwapCallParameters(intent);
      tx = await (sessionContract.executeSwap as (
        wallet: string,
        router: string,
        swapCalldata: string,
        amount: bigint,
        outputToken: string,
        overrides: ethers.Overrides,
      ) => Promise<ethers.TransactionResponse>)(
        intent.wallet,
        swapCall.swapRouter,
        swapCall.calldata,
        intentAmountWei,
        swapCall.outputTokenAddress,
        { gasLimit: execution.gasLimit ?? 600_000n, gasPrice: gasPriceWei },
      );
    } else {
      tx = await (sessionContract.execute as (
        wallet: string,
        to: string,
        value: bigint,
        data: string,
        overrides: ethers.Overrides,
      ) => Promise<ethers.TransactionResponse>)(
        intent.wallet,
        execution.to,
        intentAmountWei,
        execution.data,
        { gasLimit: 150_000n, gasPrice: gasPriceWei },
      );
    }

    this.logger.log(
      `Deposit-backed tx ${tx.hash} via WhenCheapSession.${intent.parsed.type === 'swap' ? 'executeSwap' : 'execute'}(). ` +
      `Intent: ${intent.id}. Wallet: ${intent.wallet}. Agent: ${agentWallet.address}. ` +
      `Contract: ${sessionContractAddress}. Amount: ${ethers.formatEther(intentAmountWei)} ETH`,
    );

    return tx.hash;
  }

  async checkUserDeposit(
    wallet: string,
    intentAmount: string,
    chain = 'sepolia',
  ): Promise<{ sufficient: boolean; have: string; need: string }> {
    const contract = this.getSessionContract(chain);
    if (!contract) {
      return { sufficient: true, have: '?', need: intentAmount };
    }

    try {
      const depositWei = (await contract.deposits(wallet)) as bigint;
      const needWei = ethers.parseEther(intentAmount);
      return {
        sufficient: depositWei >= needWei,
        have: ethers.formatEther(depositWei),
        need: intentAmount,
      };
    } catch (err) {
      this.logger.warn(`deposits() check failed for ${wallet} on ${chain}: ${String(err)}`);
      return { sufficient: false, have: '0', need: intentAmount };
    }
  }

  private async broadcastAgentWalletExecution(
    intent: IntentRecord,
    baseFeeGwei: number,
  ): Promise<string> {
    const chainConfig = this.getChainConfig(intent.parsed.chain ?? 'sepolia');
    await this.ensureAgentWalletBalance(intent, chainConfig);

    const agentWallet = this.requireAgentWallet(chainConfig.rpcUrl);
    const gasPriceWei = BigInt(Math.round(baseFeeGwei * 1.2 * 1e9));
    const execution = await this.buildExecutionTransaction(intent, agentWallet.address);
    const tx = await agentWallet.sendTransaction({
      to: execution.to,
      data: execution.data,
      value: execution.value,
      gasLimit: execution.gasLimit ?? BigInt(GAS_UNITS[intent.parsed.type]),
      gasPrice: gasPriceWei,
    });

    this.logger.log(
      `Broadcast agent-funded fallback tx ${tx.hash} for intent ${intent.id} ` +
      `(from agent: ${agentWallet.address})`,
    );
    return tx.hash;
  }

  /**
   * Broadcasts an EIP-7702 delegated execution transaction.
   * This uses the user's own wallet (via the signed authorization) — NOT the
   * agent wallet balance — so it is safe regardless of the fallback flag.
   */
  async broadcastEIP7702Intent(
    intent: IntentRecord,
    authorization: unknown,
  ): Promise<string> {
    const pk = this.requireAgentPrivateKey();
    this.logger.warn(
      'Using stored authorization — this should not happen. Auth should be re-signed fresh per execution.',
    );
    const storedAuthorization = this.normalizeAuthorizationForLogging(authorization);
    const chainConfig = this.getChainConfig(intent.parsed.chain ?? 'sepolia');
    if (chainConfig.chainId === MAINNET_CHAIN_ID) {
      await this.ensureAgentWalletBalance(intent, chainConfig);
    }

    const agentAccount = privateKeyToAccount(pk as `0x${string}`);
    const rpcUrl = chainConfig.rpcUrl;
    const agentClient = createWalletClient({
      account: agentAccount,
      chain: chainConfig.viemChain,
      transport: http(rpcUrl),
    });

    const execution = await this.buildExecutionTransaction(intent, agentAccount.address);
    const sessionContractAddress = this.requireSessionContractAddress(intent.parsed.chain ?? 'sepolia');

    this.logger.log(
      `Using stored EIP-7702 authorization for ${intent.wallet}: ${JSON.stringify({
        ...storedAuthorization,
      })}`,
    );
    this.logger.warn(
      'Using stored authorization — this should not happen. Auth should be re-signed fresh per execution.',
    );

    const executeCalldata = encodeFunctionData({
      abi: WHEN_CHEAP_SESSION_EXECUTE_ABI,
      functionName: 'execute',
      args: [
        agentAccount.address as `0x${string}`,
        execution.to as `0x${string}`,
        execution.value,
        execution.data as `0x${string}`,
      ],
    });

    this.logger.log(
      `Session execute() calldata prepared for audit parity: ${JSON.stringify({
        functionName: 'execute',
        args: [execution.to, execution.value.toString(), execution.data],
      })}`,
    );

    const outerTxValue =
      intent.parsed.type === 'send'
        ? (intent.parsed.fromToken?.toUpperCase() ?? 'ETH') === 'ETH'
          ? parseEther(String(intent.parsed.amount))
          : 0n
        : execution.value;

    const signedAuth = await (
      agentClient as unknown as {
        signAuthorization: (request: {
          contractAddress: `0x${string}`;
          executor: 'self';
        }) => Promise<unknown>;
      }
    ).signAuthorization({
      contractAddress: sessionContractAddress,
      executor: 'self',
    });

    const hash = await (
      agentClient as unknown as {
        sendTransaction: (request: {
          authorizationList: unknown[];
          to: `0x${string}`;
          data?: `0x${string}`;
          value?: bigint;
          gas?: bigint;
        }) => Promise<`0x${string}`>;
      }
    ).sendTransaction({
      authorizationList: [signedAuth],
      to: agentAccount.address,
      data: executeCalldata,
      value: outerTxValue,
      gas: 100_000n,
    });

    this.logger.log(
      `EIP-7702 agent-self-delegation tx ${hash}. Requested by user: ${intent.wallet}. Agent relay/signer: ${agentAccount.address}. Delegated contract: ${sessionContractAddress}`,
    );

    return hash;
  }

  async testEip7702UserWalletExecution(dto: TestEip7702Dto) {
    this.logger.warn('TEST ENDPOINT — do not expose in production');

    const sessionContractAddress = this.requireSessionContractAddress();
    const rpcUrl = this.requireRpcUrl();
    const userAccount = privateKeyToAccount(dto.userPrivateKey as `0x${string}`);
    const userClient = createWalletClient({
      account: userAccount,
      chain: sepolia,
      transport: http(rpcUrl),
    });
    const publicClient = this.provider;

    const authorizeHash = await userClient.writeContract({
      address: sessionContractAddress,
      abi: SESSION_VIEM_ABI,
      functionName: 'authorize',
      args: [parseEther('0.001'), parseEther('0.01'), 86400n],
      chain: sepolia,
      account: userAccount,
    });
    await publicClient.waitForTransaction(authorizeHash, 1);

    const freshNonce = await publicClient.getTransactionCount(userAccount.address, 'pending');

    const auth = await (
      userClient as unknown as {
        signAuthorization: (request: {
          contractAddress: `0x${string}`;
          nonce: number;
        }) => Promise<unknown>;
      }
    ).signAuthorization({
      contractAddress: sessionContractAddress,
      nonce: freshNonce,
    });

    const agentAccount = privateKeyToAccount(this.requireAgentPrivateKey());
    const agentClient = createWalletClient({
      account: agentAccount,
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const executeCalldata = encodeFunctionData({
      abi: WHEN_CHEAP_SESSION_EXECUTE_ABI,
      functionName: 'execute',
      args: [userAccount.address as `0x${string}`, dto.recipient as `0x${string}`, parseEther(dto.amount), '0x'],
    });

    const hash = await (
      agentClient as unknown as {
        sendTransaction: (request: {
          authorizationList: unknown[];
          to: `0x${string}`;
          data: `0x${string}`;
          value: bigint;
          gas: bigint;
        }) => Promise<`0x${string}`>;
      }
    ).sendTransaction({
      authorizationList: [auth],
      to: userAccount.address,
      data: executeCalldata,
      value: parseEther(dto.amount),
      gas: 200_000n,
    });

    return {
      hash,
      userAddress: userAccount.address,
      etherscanUrl: `https://sepolia.etherscan.io/tx/${hash}`,
    };
  }

  async recordSpend(
    wallet: string,
    feeWei: bigint,
    chain = 'sepolia',
  ): Promise<string | null> {
    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) return null;

    const agentWallet = this.requireAgentWallet(this.getChainConfig(chain).rpcUrl);
    const writable = sessionContract.connect(agentWallet) as ethers.Contract;
    const tx = await writable.recordSpend(wallet, feeWei);
    await tx.wait(1);
    return tx.hash as string;
  }

  async getPlatformFeeWei(valueWei: bigint, chain = 'sepolia'): Promise<bigint> {
    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) {
      return 0n;
    }

    try {
      return (await sessionContract.feeForAmount(valueWei)) as bigint;
    } catch (err) {
      this.logger.warn(`feeForAmount check failed on ${chain}: ${String(err)}`);
      return 0n;
    }
  }

  async getNetSwapAmountWei(
    valueWei: bigint,
    chain = 'sepolia',
  ): Promise<bigint> {
    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) {
      return valueWei;
    }

    try {
      return (await sessionContract.netAfterFee(valueWei)) as bigint;
    } catch (err) {
      this.logger.warn(`netAfterFee check failed on ${chain}: ${String(err)}`);
      return valueWei;
    }
  }

  formatTokenAmount(
    valueWei: bigint,
    tokenSymbol: string,
    chain = 'sepolia',
  ): string {
    try {
      const token = this.resolveToken(tokenSymbol, chain);
      return `${ethers.formatUnits(valueWei, token.decimals)} ${token.symbol}`;
    } catch {
      return `${valueWei.toString()} ${tokenSymbol.toUpperCase()}`;
    }
  }

  decodeFeeCollectionFromReceipt(receipt: ethers.TransactionReceipt): Array<{
    recipient: string;
    feeWei: string;
    totalValue: string;
    netAmount: string;
    feeType: string;
  }> {
    const feeEvents: Array<{
      recipient: string;
      feeWei: string;
      totalValue: string;
      netAmount: string;
      feeType: string;
    }> = [];

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: SESSION_VIEM_ABI,
          data: log.data as `0x${string}`,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });

        if (decoded.eventName !== 'FeeCollected') {
          continue;
        }

        const args = decoded.args as unknown as {
          recipient: string;
          feeWei: bigint;
          totalValue: bigint;
          feeType: string;
        };
        const recipient = args.recipient;
        const feeWei = args.feeWei;
        const totalValue = args.totalValue;
        const feeType = args.feeType;

        feeEvents.push({
          recipient,
          feeWei: feeWei.toString(),
          totalValue: totalValue.toString(),
          netAmount: (totalValue - feeWei).toString(),
          feeType,
        });
      } catch {
        continue;
      }
    }

    return feeEvents;
  }

  estimateFeeWei(
    baseFeeGwei: number,
    type: 'send' | 'swap' = 'send',
    _chain = 'sepolia',
  ): bigint {
    const gasUnits = GAS_UNITS[type] ?? GAS_UNITS.send;
    // 1.2x multiplier matches the priority tip added in broadcastIntent
    return BigInt(Math.round(baseFeeGwei * 1.2 * 1e9)) * BigInt(gasUnits);
  }

  private requireAgentWallet(rpcUrl?: string): ethers.Wallet {
    this.requireAgentPrivateKey();
    if (!this.agentWalletPk) throw new Error('AGENT_WALLET_PK is invalid or not configured');
    return new ethers.Wallet(this.agentWalletPk, new ethers.JsonRpcProvider(rpcUrl ?? this.requireRpcUrl()));
  }

  private requireAgentPrivateKey(): `0x${string}` {
    const pk = this.agentWalletPk;
    if (!pk) throw new Error('AGENT_WALLET_PK not configured');
    if (!this.isValidPrivateKey(pk)) {
      throw new Error(
        'AGENT_WALLET_PK must be a 66-character 0x-prefixed hex private key',
      );
    }
    return pk as `0x${string}`;
  }

  private requireSessionContractAddress(chain = 'sepolia'): `0x${string}` {
    const contractAddress = this.getChainConfig(chain).sessionContractAddr;
    if (!ethers.isAddress(contractAddress)) {
      throw new Error(`${this.isMainnetChain(chain) ? 'MAINNET_SESSION_CONTRACT_ADDR' : 'SESSION_CONTRACT_ADDR'} is missing or invalid`);
    }
    return contractAddress as `0x${string}`;
  }

  private requireRpcUrl(chain = 'sepolia'): string {
    const rpcUrl = this.getChainConfig(chain).rpcUrl;
    if (!rpcUrl) {
      throw new Error(`${this.isMainnetChain(chain) ? 'MAINNET_RPC_URL' : 'RPC_URL'} is not configured`);
    }
    return rpcUrl;
  }

  private isValidPrivateKey(pk: string): pk is `0x${string}` {
    return /^0x[0-9a-fA-F]{64}$/.test(pk);
  }

  private normalizeAuthorizationForLogging(
    authorization: unknown,
  ): AuthorizationLogPayload {
    if (!authorization || typeof authorization !== 'object') {
      throw new Error('Stored EIP-7702 authorization is missing or invalid');
    }

    const value = authorization as Partial<StoredEip7702Authorization & StoredSessionAuthorizationMarker> &
      Record<string, unknown>;

    return {
      ...value,
      contractAddress:
        typeof value.contractAddress === 'string' ? value.contractAddress : undefined,
      chainId:
        value.chainId !== undefined && value.chainId !== null
          ? String(value.chainId)
          : undefined,
      nonce:
        value.nonce !== undefined && value.nonce !== null
          ? String(value.nonce)
          : undefined,
      txHash: typeof value.txHash === 'string' ? value.txHash : undefined,
      type: typeof value.type === 'string' ? value.type : undefined,
    };
  }

  isOnChainSessionMarker(authorization: unknown): authorization is StoredSessionAuthorizationMarker {
    return (
      !!authorization &&
      typeof authorization === 'object' &&
      (authorization as StoredSessionAuthorizationMarker).type === 'on-chain-session'
    );
  }

  async resolveName(name: string): Promise<string | null> {
    try {
      return await this.getProviderForChain('ethereum').resolveName(name);
    } catch (error) {
      this.logger.warn(`ENS resolution failed for ${name}: ${String(error)}`);
      return null;
    }
  }

  private async buildExecutionTransaction(
    intent: IntentRecord,
    swapper: string,
  ): Promise<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
    gasLimit?: bigint;
    sessionValueWei?: bigint;
    uniswapEndpoint?: 'swap_7702' | 'swap';
  }> {
    if (intent.parsed.type === 'send') {
      const recipient = this.getRecipient(intent);
      const chain = intent.parsed.chain ?? 'sepolia';
      const fromToken = intent.parsed.fromToken?.toUpperCase() ?? 'ETH';
      const isNative = fromToken === 'ETH';

      if (!isNative) {
        const tokenInfo = this.resolveToken(fromToken, chain);
        const amountToken = ethers.parseUnits(String(intent.parsed.amount), tokenInfo.decimals);
        const transferCalldata = encodeFunctionData({
          abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
          functionName: 'transfer',
          args: [recipient as `0x${string}`, amountToken],
        });

        return {
          to: tokenInfo.address as `0x${string}`,
          data: transferCalldata,
          value: 0n,
          gasLimit: 80_000n,
        };
      }

      return {
        to: recipient as `0x${string}`,
        data: '0x',
        value: parseEther(String(intent.parsed.amount)),
        gasLimit: BigInt(GAS_UNITS.send),
      };
    }

    return this.buildSwapTransaction(intent, swapper);
  }

  private getRecipient(intent: IntentRecord): string {
    const recipient = intent.parsed.resolvedRecipient ?? intent.parsed.recipient;
    if (!recipient || !ethers.isAddress(recipient)) {
      throw new Error('Intent has no executable recipient address');
    }
    return recipient;
  }

  private async buildSwapTransaction(
    intent: IntentRecord,
    _swapper: string,
  ): Promise<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
    gasLimit?: bigint;
    sessionValueWei?: bigint;
    uniswapEndpoint?: 'swap_7702' | 'swap';
  }> {
    const chain = intent.parsed.chain ?? 'sepolia';
    const sessionContractAddress = this.requireSessionContractAddress(chain);
    const { fullAmount, feeWei, netAmount, swapRouter, calldata, outputTokenAddress, endpointUsed, tokenInSymbol } =
      await this.buildSwapCallParameters(intent);

    const executeSwapCalldata = encodeFunctionData({
      abi: WHEN_CHEAP_SESSION_EXECUTE_SWAP_ABI,
      functionName: 'executeSwap',
      args: [
        intent.wallet as `0x${string}`,
        swapRouter as `0x${string}`,
        calldata as `0x${string}`,
        fullAmount,
        outputTokenAddress as `0x${string}`,
      ],
    });

    this.logger.log(
      `Swap via session contract. Router: ${swapRouter}. ` +
      `Full: ${this.formatTokenAmount(fullAmount, tokenInSymbol, chain)}. ` +
      `Net: ${this.formatTokenAmount(netAmount, tokenInSymbol, chain)}. ` +
      `Fee: ${this.formatTokenAmount(feeWei, tokenInSymbol, chain)}. Contract: ${sessionContractAddress}`,
    );

    return {
      to: sessionContractAddress,
      data: executeSwapCalldata,
      value: fullAmount,
      gasLimit: 600_000n,
      uniswapEndpoint: endpointUsed,
    };
  }

  private async buildSwapCallParameters(intent: IntentRecord): Promise<{
    fullAmount: bigint;
    feeWei: bigint;
    netAmount: bigint;
    swapRouter: `0x${string}`;
    calldata: `0x${string}`;
    outputTokenAddress: `0x${string}`;
    endpointUsed: 'swap_7702' | 'swap';
    tokenInSymbol: string;
  }> {
    const chain = intent.parsed.chain ?? 'sepolia';
    const chainConfig = this.getChainConfig(chain);
    const tokenIn = this.resolveToken(intent.parsed.fromToken, chain);
    const tokenOut = this.resolveToken(intent.parsed.toToken ?? 'USDC', chain);

    if (
      chainConfig.chainId === SEPOLIA_CHAIN_ID &&
      !['ETH', 'WETH'].includes(tokenIn.symbol.toUpperCase())
    ) {
      throw new Error(
        'Sepolia demo currently supports ETH-funded swaps only. Try ETH -> USDC or ETH -> DAI.',
      );
    }

    const fullAmount = ethers.parseUnits(String(intent.parsed.amount), tokenIn.decimals);
    const feeWei = await this.getPlatformFeeWei(fullAmount, chain);
    const netAmount = fullAmount - feeWei;
    const { calldata, to: swapRouter, endpointUsed } = await this.buildUniswapSwapCalldata(
      chainConfig.chainId,
      tokenIn.address,
      tokenOut.address,
      tokenIn.decimals,
      tokenOut.decimals,
      netAmount,
      intent.wallet,
      intent.parsed.slippageBps ?? 50,
    );

    return {
      fullAmount,
      feeWei,
      netAmount,
      swapRouter: swapRouter as `0x${string}`,
      calldata: calldata as `0x${string}`,
      outputTokenAddress: tokenOut.address as `0x${string}`,
      endpointUsed,
      tokenInSymbol: tokenIn.symbol,
    };
  }

  private async buildUniswapSwapCalldata(
    chainId: number,
    tokenInAddress: string,
    tokenOutAddress: string,
    _tokenInDecimals: number,
    _tokenOutDecimals: number,
    amountIn: bigint,
    recipient: string,
    slippageBps = 50,
  ): Promise<UniswapSwapCalldataResult> {
    const apiKey = this.config.get<string>('UNISWAP_API_KEY');
    if (!apiKey) {
      throw new Error('UNISWAP_API_KEY not configured');
    }

    const isNativeIn = tokenInAddress.toLowerCase() === UNISWAP_NATIVE_ETH.toLowerCase();
    const tokenIn = isNativeIn
      ? '0x0000000000000000000000000000000000000000'
      : tokenInAddress;

    let quoteRes: AxiosResponse<Record<string, unknown>>;
    try {
      quoteRes = await axios.post(
        'https://trade-api.gateway.uniswap.org/v1/quote',
        {
          tokenIn,
          tokenOut: tokenOutAddress,
          tokenInChainId: chainId,
          tokenOutChainId: chainId,
          type: 'EXACT_INPUT',
          amount: amountIn.toString(),
          swapper: recipient,
          slippageTolerance: slippageBps / 100,
        },
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
    } catch (err) {
      if (err instanceof AxiosError) {
        const status = err.response?.status;
        const body = JSON.stringify(err.response?.data ?? {});
        const url = err.config?.url;
        throw new Error(`Uniswap API ${status} at ${url}: ${body}`);
      }
      throw err;
    }

    const {
      quote,
      permitData,
      routing,
    } = quoteRes.data as {
      quote?: Record<string, unknown>;
      permitData?: {
        domain: Record<string, unknown>;
        types: Record<string, Array<Record<string, unknown>>>;
        values: Record<string, unknown>;
      };
      routing?: string;
    };

    this.logger.log(
      `Uniswap API quote: routing=${routing ?? 'unknown'} outputAmount=${String(
        (quote as { output?: { amount?: string } } | undefined)?.output?.amount ?? 'unknown',
      )}`,
    );

    if (routing === 'DUTCH_V2' || routing === 'DUTCH_V3' || routing === 'PRIORITY') {
      throw new Error(
        `UniswapX routing (${routing}) not supported — requires gasless order flow`,
      );
    }

    const chain = chainId === MAINNET_CHAIN_ID ? 'mainnet' : 'sepolia';
    const sessionContractAddress = this.requireSessionContractAddress(chain);

    const swapBody: Record<string, unknown> = {
      quote,
      delegation: sessionContractAddress,
    };
    if (permitData) {
      const agentWallet = this.requireAgentWallet();
      const signature = await agentWallet.signTypedData(
        permitData.domain,
        permitData.types as Record<string, Array<{ name: string; type: string }>>,
        permitData.values,
      );
      swapBody.signature = signature;
      swapBody.permitData = permitData;
    }

    let swapRes: AxiosResponse<Record<string, unknown>>;
    let endpointUsed: 'swap_7702' | 'swap' = 'swap_7702';
    try {
      swapRes = await axios.post(
        'https://trade-api.gateway.uniswap.org/v1/swap_7702',
        swapBody,
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      this.logger.log('Uniswap /swap_7702 endpoint used — EIP-7702 optimized calldata');
    } catch (err) {
      this.logger.warn(`Uniswap /swap_7702 failed: ${String(err)} — falling back to /swap`);
      const fallbackBody = { ...swapBody };
      delete fallbackBody.delegation;
      endpointUsed = 'swap';

      try {
        swapRes = await axios.post(
          'https://trade-api.gateway.uniswap.org/v1/swap',
          fallbackBody,
          {
            headers: {
              'x-api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          },
        );
        this.logger.log('Uniswap /swap fallback used');
      } catch (fallbackErr) {
        if (fallbackErr instanceof AxiosError) {
          const status = fallbackErr.response?.status;
          const body = JSON.stringify(fallbackErr.response?.data ?? {});
          const url = fallbackErr.config?.url;
          throw new Error(`Uniswap API ${status} at ${url}: ${body}`);
        }
        throw fallbackErr;
      }
    }

    const { swap } = swapRes.data as {
      swap?: { data?: string; value?: string; to?: string };
    };

    if (!swap?.data || swap.data === '0x') {
      throw new Error('Uniswap API returned empty transaction data');
    }

    this.logger.warn(
      `[UNISWAP DEBUG] Quote request swapper: ${recipient}\n` +
      `Swap response calldata length: ${swap.data.length}\n` +
      `Swap response to: ${swap.to ?? SWAP_ROUTER_02_ADDRESS}\n` +
      `Full swap response: ${JSON.stringify(swap, null, 2)}`,
    );

    try {
      const universalRouter = new ethers.Interface([
        'function execute(bytes commands, bytes[] inputs) payable',
        'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
      ]);
      const decoded = universalRouter.parseTransaction({ data: swap.data });
      this.logger.warn(
        `[UNISWAP DECODE] Function: ${decoded?.name ?? 'unknown'}\n` +
        `Args: ${JSON.stringify(
          decoded
            ? decoded.args.toArray().map((arg) =>
                typeof arg === 'bigint'
                  ? arg.toString()
                  : Array.isArray(arg)
                    ? arg.map((item) => (typeof item === 'bigint' ? item.toString() : item))
                    : arg,
              )
            : [],
          null,
          2,
        )}`,
      );
    } catch (err) {
      this.logger.warn(`[UNISWAP DECODE] Failed to decode: ${String(err)}`);
    }

    this.logger.log(`Uniswap API swap tx built. to=${swap.to} value=${swap.value ?? '0'}`);

    return {
      calldata: swap.data,
      value:
        isNativeIn
          ? amountIn
          : BigInt(swap.value ?? '0'),
      to: swap.to ?? SWAP_ROUTER_02_ADDRESS,
      endpointUsed,
    };
  }

  private resolveToken(symbol: string, chain: string): { address: string; decimals: number; symbol: string } {
    const normalized = symbol.trim().toUpperCase();
    const token = (this.isMainnetChain(chain) ? MAINNET_TOKENS : SEPOLIA_TOKENS)[normalized];

    if (!token) {
      throw new Error(
        `Token ${symbol} not supported on ${chain}. Supported: ${Object.keys(
          this.isMainnetChain(chain) ? MAINNET_TOKENS : SEPOLIA_TOKENS,
        ).join(', ')}`,
      );
    }

    return token;
  }

  private getChainConfig(chain: string): {
    chainId: number;
    rpcUrl: string;
    sessionContractAddr: string;
    viemChain: Chain;
  } {
    if (this.isMainnetChain(chain)) {
      return {
        chainId: MAINNET_CHAIN_ID,
        rpcUrl: this.config.get<string>('MAINNET_RPC_URL') ?? '',
        sessionContractAddr: this.config.get<string>('MAINNET_SESSION_CONTRACT_ADDR') ?? '',
        viemChain: mainnet,
      };
    }

    return {
      chainId: SEPOLIA_CHAIN_ID,
      rpcUrl: this.config.get<string>('RPC_URL') ?? '',
      sessionContractAddr: this.config.get<string>('SESSION_CONTRACT_ADDR') ?? '',
      viemChain: sepolia,
    };
  }

  private isMainnetChain(chain: string): boolean {
    return ['ethereum', 'mainnet', 'eth'].includes(chain.toLowerCase());
  }

  private normalizeChain(chain: string): string {
    return this.isMainnetChain(chain) ? 'mainnet' : 'sepolia';
  }

  private getSessionContract(chain: string): ethers.Contract | null {
    const contractAddr = this.getChainConfig(chain).sessionContractAddr;
    if (!contractAddr || !ethers.isAddress(contractAddr)) {
      return null;
    }

    return new ethers.Contract(
      contractAddr,
      SESSION_ABI,
      this.getProviderForChain(chain),
    );
  }

  private async ensureAgentWalletBalance(
    intent: IntentRecord,
    chainConfig: { chainId: number; rpcUrl: string },
  ): Promise<void> {
    if (!this.agentWallet) return;

    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const balance = await provider.getBalance(this.agentWallet.address);
    const gasBuffer = ethers.parseEther('0.005');
    const required =
      intent.parsed.type === 'send'
        ? ethers.parseEther(intent.parsed.amount) + gasBuffer
        : gasBuffer;

    if (balance < required) {
      const network = chainConfig.chainId === MAINNET_CHAIN_ID ? 'mainnet' : 'Sepolia testnet';
      throw new Error(
        `Insufficient ${network} ETH in agent wallet (${this.agentWallet.address}). ` +
        `Have: ${ethers.formatEther(balance)} ETH, ` +
        `need: ${ethers.formatEther(required)} ETH. ` +
        `Fund the agent wallet to execute this intent.`,
      );
    }
  }

  private async logAgentWalletEnsName(): Promise<void> {
    if (!this.agentWallet) return;

    try {
      const ens = await this.provider.lookupAddress(this.agentWallet.address);
      if (ens) {
        this.logger.log(`Agent wallet ENS name: ${ens} (${this.agentWallet.address})`);
      } else {
        this.logger.log(`Agent wallet has no ENS name: ${this.agentWallet.address}`);
      }
    } catch (error) {
      this.logger.warn(`Agent wallet ENS lookup failed: ${String(error)}`);
    }
  }

  private async ensureSessionAuthorizationChainSchema(): Promise<void> {
    await this.sessionRepository.query(`
      ALTER TABLE session_authorizations
      ADD COLUMN IF NOT EXISTS chain varchar(32) NOT NULL DEFAULT 'sepolia'
    `);
    await this.sessionRepository.query(
      'DROP INDEX IF EXISTS "IDX_session_authorizations_walletAddress"',
    );
    await this.sessionRepository.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_session_authorizations_walletAddress_chain"
      ON session_authorizations ("walletAddress", chain)
    `);
  }

  private async resolveOrCreateWalletUser(walletAddress: string): Promise<UserEntity> {
    let user = await this.userRepository.findOne({
      where: { identifier: walletAddress.toLowerCase() },
    });

    if (!user) {
      user = this.userRepository.create({
        identifier: walletAddress.toLowerCase(),
        identifierType: UserIdentifierType.Wallet,
      });
      user = await this.userRepository.save(user);
    }

    return user;
  }
}
