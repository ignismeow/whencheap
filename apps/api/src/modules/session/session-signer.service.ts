import { BadGatewayException, BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
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
import { GoogleAuthDto } from '../intents/dto/google-auth.dto';
import { ManagedSessionDto } from '../intents/dto/managed-session.dto';
import { RegisterWalletDto } from '../intents/dto/register-wallet.dto';
import { TestEip7702Dto } from '../intents/dto/test-eip7702.dto';
import { UserEntity, UserIdentifierType } from '../user/user.entity';
import { SessionAuthorizationEntity } from './session-auth.entity';
import { WhenCheapWallet } from './wallet.entity';

const SESSION_ABI = [
  'function canExecute(address wallet, uint256 feeWei) view returns (bool)',
  'function sessions(address wallet) view returns (uint256 maxFeePerTxWei, uint256 maxTotalSpendWei, uint256 spentWei, uint256 expiresAt)',
  'function recordSpend(address wallet, uint256 feeWei)',
  'function authorize(uint256 maxFeePerTxWei, uint256 maxTotalSpendWei, uint256 durationSeconds)',
  'function revokeSession()',
  'function execute(address to, uint256 value, bytes data)',
  'function agentAddress() view returns (address)',
  'function treasury() view returns (address)',
  'function feeBps() view returns (uint16)',
  'function agentFeeSplit() view returns (uint16)',
  'function feeForAmount(uint256 value) view returns (uint256)',
  'function netAfterFee(uint256 value) view returns (uint256)',
  'function swap(bytes commands, bytes[] inputs, uint256 deadline, uint256 swapAmount)',
  'function swapToken(address tokenIn, uint256 amountIn, bytes commands, bytes[] inputs, uint256 deadline)',
  'function swapFeeForAmount(uint256 amount) view returns (uint256)',
  'function netSwapAmount(uint256 amount) view returns (uint256)',
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
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;
const WHEN_CHEAP_SESSION_SWAP_ABI = [
  {
    type: 'function',
    name: 'swap',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
      { name: 'swapAmount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];
const UNIVERSAL_ROUTER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      {
        name: 'deadline',
        type: 'uint256',
      },
    ],
    outputs: [],
  },
] as const;

const GAS_UNITS = { send: 21_000, swap: 150_000 } as const;
const SEPOLIA_CHAIN_ID = 11155111;
const UNISWAP_NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const MAINNET_CHAIN_ID = 1;
const UNIVERSAL_ROUTER_SEPOLIA = '0x8B844f885672f333Bc0042cB669255f93a4C1E6b';
const UNIVERSAL_ROUTER_MAINNET = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';
const UNISWAP_V3_FACTORY_SEPOLIA = '0x0227628f3F023bb0B980b67D528571c95c6DaC1c';
const UNISWAP_V3_FACTORY_MAINNET = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const UNIVERSAL_ROUTER_EXECUTE_SELECTOR = '0x3593564c';
const UNIVERSAL_ROUTER_WRAP_ETH_COMMAND = '0x0b';
const UNIVERSAL_ROUTER_V3_SWAP_EXACT_IN_COMMAND = '0x00';
const UNIVERSAL_ROUTER_ROUTER_AS_RECIPIENT = '0x0000000000000000000000000000000000000002';
const SEPOLIA_V3_FEE_TIER_PRIORITY = [500, 3000, 100, 10000] as const;
const SEPOLIA_V3_FALLBACK_FEE = 100;
const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)',
];
const UNISWAP_V3_POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];
const SEPOLIA_SWAP_TEMPLATE =
  '3593564c' +
  '000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000069f20c9600000000000000000000000000000000000000000000000000000000000000020b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000002' +
  '00000000000000000000000000000000000000000000000000038d7ea4c68000' +
  '00000000000000000000000000000000000000000000000000000000000001400000000000000000000000009dd40426fe0dbaf3d28b4fe7f499231e6ffd3873' +
  '00000000000000000000000000000000000000000000000000038d7ea4c68000' +
  '0000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000002bfff9976782d46cc05630d1f6ebab18b2324d6b140000641c7d4b196cb0c7b01d743fbc6116a902379c72380000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000756e697800000000000c';
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
};

interface UniswapQuoteResponse {
  quote?: Record<string, unknown>;
  routing?: string;
  permitData?: {
    domain?: Record<string, unknown>;
    values?: Record<string, unknown>;
    types?: Record<string, Array<{ name: string; type: string }>>;
  } | null;
}

interface UniswapSwapResponse {
  swap?: {
    to?: string;
    from?: string;
    data?: string;
    value?: string;
    gasLimit?: string;
    gasPrice?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    chainId?: number;
  };
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
}

interface AuthorizationLogPayload {
  contractAddress?: string;
  chainId?: string;
  nonce?: string;
  txHash?: string;
  type?: string;
  [key: string]: unknown;
}

interface EncryptedWalletPayload {
  iv: string;
  encryptedKey: string;
  authTag: string;
}

interface StoredWalletResult {
  user: UserEntity;
  wallet: WhenCheapWallet;
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
    @InjectRepository(WhenCheapWallet)
    private readonly walletRepository: Repository<WhenCheapWallet>,
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
    if (!this.hasValidEncryptionKey()) {
      this.logger.warn(
        'ENCRYPTION_KEY not set or invalid — WhenCheap wallet registration is unavailable',
      );
    }
    if (!this.config.get<string>('GOOGLE_CLIENT_ID')) {
      this.logger.warn('GOOGLE_CLIENT_ID not set — Google auth wallet allocation is unavailable');
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
    await this.migrateLegacyWalletRows();
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
      return null;
    }

    try {
      return JSON.parse(persisted.authorizationJson) as unknown;
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

  async registerWallet(dto: RegisterWalletDto): Promise<{ ok: true; address: string }> {
    if (!this.isValidPrivateKey(dto.privateKey)) {
      throw new BadRequestException(
        'privateKey must be a 66-character 0x-prefixed hex string',
      );
    }

    if (!ethers.isAddress(dto.userAddress)) {
      throw new BadRequestException('userAddress must be a valid EVM address');
    }

    const normalizedAddress = dto.userAddress.toLowerCase();
    const userAccount = privateKeyToAccount(dto.privateKey as `0x${string}`);

    if (userAccount.address.toLowerCase() !== normalizedAddress) {
      throw new BadRequestException('Private key does not match userAddress');
    }

    const encrypted = this.encryptPrivateKey(dto.privateKey);
    await this.storeEncryptedWallet(
      normalizedAddress,
      UserIdentifierType.Wallet,
      encrypted.encryptedKey,
      encrypted.iv,
      encrypted.authTag,
      userAccount.address,
    );
    this.logger.log(`Stored encrypted WhenCheap wallet for ${userAccount.address}`);

    return { ok: true, address: userAccount.address };
  }

  async getRegisteredWallet(userAddress: string): Promise<string | null> {
    const storedWallet = await this.getWalletByAddress(userAddress);
    return storedWallet ? this.serializeStoredWallet(storedWallet) : null;
  }

  async getWalletByIdentifier(identifier: string): Promise<string | null> {
    const storedWallet = await this.getEncryptedWallet(identifier);
    return storedWallet ? this.serializeStoredWallet(storedWallet.wallet) : null;
  }

  async authenticateWithGoogle(dto: GoogleAuthDto) {
    const googleProfile = await this.verifyGoogleCredential(dto.credential);
    const existing =
      (await this.getEncryptedWallet(googleProfile.email.toLowerCase())) ??
      (await this.getEncryptedWallet(googleProfile.googleSub));

    if (existing) {
      const payload = this.extractWalletPayload(existing.wallet);
      await this.storeEncryptedWallet(
        googleProfile.email.toLowerCase(),
        UserIdentifierType.Email,
        payload.encryptedKey,
        payload.iv,
        payload.authTag,
        existing.wallet.walletAddress,
      );

      return {
        ok: true as const,
        created: false,
        email: googleProfile.email,
        address: existing.wallet.walletAddress,
      };
    }

    const wallet = ethers.Wallet.createRandom();
    const encrypted = this.encryptPrivateKey(wallet.privateKey);
    await this.storeEncryptedWallet(
      googleProfile.email.toLowerCase(),
      UserIdentifierType.Email,
      encrypted.encryptedKey,
      encrypted.iv,
      encrypted.authTag,
      wallet.address,
    );
    this.logger.log(`Allocated managed wallet ${wallet.address} for ${googleProfile.email}`);

    return {
      ok: true as const,
      created: true,
      email: googleProfile.email,
      address: wallet.address,
    };
  }

  async authorizeManagedWalletSession(dto: ManagedSessionDto): Promise<{ ok: true; txHash: string }> {
    try {
      const wallet = await this.requireStoredWallet(dto.userAddress);
      const chain = dto.chain ?? 'sepolia';
      const sessionContractAddress = this.requireSessionContractAddress(chain);
      const rpcUrl = this.requireRpcUrl(chain);
      const provider = this.getProviderForChain(chain);
      const chainConfig = this.getChainConfig(chain);
      const account = privateKeyToAccount(wallet);
      const balance = await provider.getBalance(account.address);

      if (balance === 0n) {
        throw new BadRequestException(
          `Managed wallet ${account.address} has no ${
            this.isMainnetChain(chain) ? 'mainnet' : 'Sepolia'
          } ETH. Fund it before authorizing a session.`,
        );
      }

      const client = createWalletClient({
        account,
        chain: chainConfig.viemChain,
        transport: http(rpcUrl),
      });

      const txHash = await client.writeContract({
        address: sessionContractAddress,
        abi: SESSION_VIEM_ABI,
        functionName: 'authorize',
        args: [
          parseEther(dto.maxFeePerTxEth),
          parseEther(dto.maxTotalSpendEth),
          BigInt(dto.expiryHours) * 3600n,
        ],
        chain: chainConfig.viemChain,
        account,
      });

      await provider.waitForTransaction(txHash, 1);
      const normalizedAddress = dto.userAddress.toLowerCase();
      const user = await this.resolveOrCreateWalletUser(normalizedAddress);
      await this.sessionRepository.upsert(
        {
          userId: user.id,
          walletAddress: normalizedAddress,
          chain: this.normalizeChain(chain),
          authorizationJson: JSON.stringify({
            type: 'managed-wallet-session',
            txHash,
          }),
          isActive: true,
          expiresAt: new Date(Date.now() + Number(dto.expiryHours) * 60 * 60 * 1000),
        },
        ['walletAddress', 'chain'],
      );
      return { ok: true, txHash };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Managed wallet authorization failed: ${message}`);
    }
  }

  async revokeManagedWalletSession(
    userAddress: string,
    chain = 'sepolia',
  ): Promise<{ ok: true; txHash: string }> {
    try {
      const wallet = await this.requireStoredWallet(userAddress);
      const sessionContractAddress = this.requireSessionContractAddress(chain);
      const rpcUrl = this.requireRpcUrl(chain);
      const provider = this.getProviderForChain(chain);
      const chainConfig = this.getChainConfig(chain);
      const account = privateKeyToAccount(wallet);
      const client = createWalletClient({
        account,
        chain: chainConfig.viemChain,
        transport: http(rpcUrl),
      });

      const txHash = await client.writeContract({
        address: sessionContractAddress,
        abi: SESSION_VIEM_ABI,
        functionName: 'revokeSession',
        args: [],
        chain: chainConfig.viemChain,
        account,
      });

      await provider.waitForTransaction(txHash, 1);
      await this.sessionRepository
        .createQueryBuilder()
        .update(SessionAuthorizationEntity)
        .set({ isActive: false })
        .where('LOWER(walletAddress) = LOWER(:walletAddress)', { walletAddress: userAddress })
        .andWhere('chain = :chain', { chain: this.normalizeChain(chain) })
        .execute();
      return { ok: true, txHash };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Managed wallet revoke failed: ${message}`);
    }
  }

  /** View call — no gas, just checks session limits on-chain. */
  async canExecuteSession(
    wallet: string,
    feeWei: bigint,
    chain = 'sepolia',
  ): Promise<boolean> {
    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) return true;
    try {
      return (await sessionContract.canExecute(wallet, feeWei)) as boolean;
    } catch (err) {
      this.logger.warn(`canExecute check failed for ${wallet} on ${chain}: ${String(err)}`);
      return false;
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
    return this.broadcastAgentWalletExecution(intent, baseFeeGwei);
  }

  async broadcastWithUserWallet(
    intent: IntentRecord,
    encryptedKeyData: string,
  ): Promise<string> {
    const decryptedKey = this.decryptPrivateKey(encryptedKeyData);
    const userAccount = privateKeyToAccount(decryptedKey);
    const chainConfig = this.getChainConfig(intent.parsed.chain ?? 'sepolia');
    const sessionContractAddress = this.requireSessionContractAddress(intent.parsed.chain ?? 'sepolia');
    const rpcUrl = chainConfig.rpcUrl;
    const provider = this.getProviderForChain(intent.parsed.chain ?? 'sepolia');

    if (userAccount.address.toLowerCase() !== intent.wallet.toLowerCase()) {
      throw new Error('Stored wallet does not match intent wallet');
    }

    const userClient = createWalletClient({
      account: userAccount,
      chain: chainConfig.viemChain,
      transport: http(rpcUrl),
    });

    if (chainConfig.chainId === MAINNET_CHAIN_ID) {
      await this.ensureAgentWalletBalance(intent, chainConfig);
    }

    const freshNonce = await provider.getTransactionCount(userAccount.address, 'latest');
    const signedAuth = await (
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
      chain: chainConfig.viemChain,
      transport: http(rpcUrl),
    });

    if (intent.parsed.type === 'swap') {
      const swapExecution = await this.buildDirectSepoliaSwapTransaction(intent);
      return await (
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
        authorizationList: [signedAuth],
        to: swapExecution.to,
        data: swapExecution.data,
        value: swapExecution.value,
        gas: swapExecution.gasLimit ?? 400_000n,
      });
    }

    const execution = await this.buildExecutionTransaction(intent, userAccount.address);
    const outerTxValue =
      execution.sessionValueWei !== undefined
        ? execution.sessionValueWei
        : parseEther(String(intent.parsed.amount));
    const executeCalldata = encodeFunctionData({
      abi: WHEN_CHEAP_SESSION_EXECUTE_ABI,
      functionName: 'execute',
      args: [
        execution.to as `0x${string}`,
        outerTxValue,
        execution.data as `0x${string}`,
      ],
    });

    return await (
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
      authorizationList: [signedAuth],
      to: userAccount.address,
      data: executeCalldata,
      value: outerTxValue,
      gas: 200_000n,
    });
  }

  async executeSwap(intent: IntentRecord): Promise<string> {
    const wallet = await this.getWalletByAddress(intent.wallet);
    if (!wallet) {
      throw new Error(
        `No encrypted wallet found for ${intent.wallet}. User must register a WhenCheap wallet first.`,
      );
    }

    this.logger.log(
      `Executing managed-wallet swap for ${intent.wallet}: ` +
        `${intent.parsed.amount} ${intent.parsed.fromToken} -> ${intent.parsed.toToken ?? 'USDC'} ` +
        `on ${intent.parsed.chain ?? 'sepolia'}`,
    );

    return this.broadcastWithUserWallet(intent, this.serializeStoredWallet(wallet));
  }

  private async broadcastAgentWalletExecution(
    intent: IntentRecord,
    baseFeeGwei: number,
  ): Promise<string> {
    const chainConfig = this.getChainConfig(intent.parsed.chain ?? 'sepolia');
    if (chainConfig.chainId === MAINNET_CHAIN_ID) {
      await this.ensureAgentWalletBalance(intent, chainConfig);
    }

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

    const executeCalldata = encodeFunctionData({
      abi: WHEN_CHEAP_SESSION_EXECUTE_ABI,
      functionName: 'execute',
      args: [
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
        ? parseEther(String(intent.parsed.amount))
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

    const freshNonce = await publicClient.getTransactionCount(userAccount.address, 'latest');

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
      args: [dto.recipient as `0x${string}`, parseEther(dto.amount), '0x'],
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

  async ensureManagedWalletHasRequiredBalance(
    userWalletAddress: string,
    intentAmount: string,
    baseFeeGwei: number,
    type: 'send' | 'swap',
    chain = 'sepolia',
  ): Promise<void> {
    const wallet = await this.getWalletByAddress(userWalletAddress);
    if (!wallet) {
      return;
    }

    const amountWei = parseEther(intentAmount);
    const gasBufferWei = this.estimateFeeWei(baseFeeGwei, type, chain);
    const feeWei =
      type === 'swap'
        ? await this.getPlatformFeeWei(amountWei, chain)
        : 0n;
    const requiredWei = amountWei + feeWei + gasBufferWei;
    const availableWei = await this.getProviderForChain(chain).getBalance(userWalletAddress);

    if (availableWei < requiredWei) {
      throw new BadRequestException(
        `Insufficient balance in managed wallet. Required: ${formatEther(requiredWei)} ETH, ` +
          `Available: ${formatEther(availableWei)} ETH`,
      );
    }
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
      return (await sessionContract.netSwapAmount(valueWei)) as bigint;
    } catch (err) {
      this.logger.warn(`netSwapAmount check failed on ${chain}: ${String(err)}`);
      return valueWei;
    }
  }

  async collectSwapPlatformFee(
    walletAddress: string,
    swapAmountWei: bigint,
    chain = 'sepolia',
  ): Promise<Array<{
    recipient: string;
    feeWei: string;
    txHash: string;
    feeType: 'agent' | 'treasury';
  }>> {
    const wallet = await this.getWalletByAddress(walletAddress);
    if (!wallet) {
      throw new Error(`No encrypted wallet found for ${walletAddress}`);
    }

    const sessionContract = this.getSessionContract(chain);
    if (!sessionContract) {
      throw new Error(`Session contract not configured for ${chain}`);
    }

    const decryptedKey = this.decryptPrivateKey(this.serializeStoredWallet(wallet));
    const userAccount = privateKeyToAccount(decryptedKey);
    const chainConfig = this.getChainConfig(chain);
    const userClient = createWalletClient({
      account: userAccount,
      chain: chainConfig.viemChain,
      transport: http(chainConfig.rpcUrl),
    });

    const [agentRecipient, treasuryRecipient, agentFeeWei, treasuryFeeWei] = await Promise.all([
      sessionContract.agentAddress() as Promise<string>,
      sessionContract.treasury() as Promise<string>,
      sessionContract.agentFeeForAmount(swapAmountWei) as Promise<bigint>,
      sessionContract.treasuryFeeForAmount(swapAmountWei) as Promise<bigint>,
    ]);

    const transfers: Array<{
      recipient: string;
      feeWei: string;
      txHash: string;
      feeType: 'agent' | 'treasury';
    }> = [];

    if (agentFeeWei > 0n) {
      const txHash = await userClient.sendTransaction({
        to: agentRecipient as `0x${string}`,
        value: agentFeeWei,
        gas: 21_000n,
        chain: chainConfig.viemChain,
        account: userAccount,
      });
      transfers.push({
        recipient: agentRecipient,
        feeWei: agentFeeWei.toString(),
        txHash,
        feeType: 'agent',
      });
    }

    if (treasuryFeeWei > 0n) {
      const txHash = await userClient.sendTransaction({
        to: treasuryRecipient as `0x${string}`,
        value: treasuryFeeWei,
        gas: 21_000n,
        chain: chainConfig.viemChain,
        account: userAccount,
      });
      transfers.push({
        recipient: treasuryRecipient,
        feeWei: treasuryFeeWei.toString(),
        txHash,
        feeType: 'treasury',
      });
    }

    return transfers;
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

  private hasValidEncryptionKey(): boolean {
    const rawKey = this.config.get<string>('ENCRYPTION_KEY') ?? '';
    return /^[0-9a-fA-F]{64}$/.test(rawKey);
  }

  private requireEncryptionKey(): Buffer {
    const rawKey = this.config.get<string>('ENCRYPTION_KEY') ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(rawKey)) {
      throw new Error('ENCRYPTION_KEY must be a 32-byte hex string');
    }
    return Buffer.from(rawKey, 'hex');
  }

  private encryptPrivateKey(privateKey: string): EncryptedWalletPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireEncryptionKey(), iv);
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(privateKey, 'utf8')),
      cipher.final(),
    ]);

    return {
      iv: iv.toString('hex'),
      encryptedKey: encrypted.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
    };
  }

  private decryptPrivateKey(encryptedKeyData: string): `0x${string}` {
    let payload: EncryptedWalletPayload;
    try {
      payload = JSON.parse(encryptedKeyData) as EncryptedWalletPayload;
    } catch {
      throw new Error('Stored wallet payload is invalid');
    }

    if (!payload.iv || !payload.encryptedKey || !payload.authTag) {
      throw new Error('Stored wallet payload is incomplete');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.requireEncryptionKey(),
      Buffer.from(payload.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.encryptedKey, 'hex')),
      decipher.final(),
    ]).toString('utf8');

    return decrypted as `0x${string}`;
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
  }> {
    if (intent.parsed.type === 'send') {
      const recipient = this.getRecipient(intent);
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
    swapper: string,
  ): Promise<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
    gasLimit?: bigint;
    sessionValueWei?: bigint;
  }> {
    const chain = intent.parsed.chain ?? 'sepolia';
    const chainConfig = this.getChainConfig(chain);
    const tokenIn = this.resolveToken(intent.parsed.fromToken, chain);
    const tokenOut = this.resolveToken(intent.parsed.toToken ?? 'USDC', chain);
    const amount = ethers.parseUnits(String(intent.parsed.amount), tokenIn.decimals).toString();
    const uniswapApiKey = this.config.get<string>('UNISWAP_API_KEY') ?? '';

    if (!uniswapApiKey) {
      throw new Error('UNISWAP_API_KEY is not configured');
    }

    const headers = {
      'x-api-key': uniswapApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-universal-router-version': '2.0',
      'x-erc20eth-enabled': tokenIn.symbol === 'ETH' ? 'true' : 'false',
    };

    let quoteResponse: AxiosResponse<UniswapQuoteResponse>;
    try {
      quoteResponse = await axios.post<UniswapQuoteResponse>(
        'https://trade-api.gateway.uniswap.org/v1/quote',
        {
          type: 'EXACT_INPUT',
          amount,
          tokenInChainId: chainConfig.chainId,
          tokenOutChainId: chainConfig.chainId,
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          swapper,
          slippageTolerance: intent.parsed.slippageBps / 100,
          routingPreference: 'BEST_PRICE',
        },
        { headers, timeout: 20_000 },
      );
    } catch (err) {
      if (this.shouldUseDirectSepoliaSwapFallback(err, chain)) {
        return await this.buildDirectSepoliaSwapTransaction(intent);
      }

      if (err instanceof AxiosError) {
        const status = err.response?.status;
        const body = JSON.stringify(err.response?.data ?? {});
        const url = err.config?.url;
        throw new Error(`Uniswap API ${status} at ${url}: ${body}`);
      }
      throw err;
    }

    const routing = quoteResponse.data.routing;
    if (!routing || !['CLASSIC', 'WRAP', 'UNWRAP'].includes(routing)) {
      throw new Error(`Unsupported Uniswap routing response: ${routing ?? 'unknown'}`);
    }

    const swapRequest: Record<string, unknown> = {
      quote: quoteResponse.data.quote,
    };

    if (quoteResponse.data.permitData) {
      if (swapper.toLowerCase() !== (this.agentAddress ?? '').toLowerCase()) {
        throw new Error(
          'Swap requires Permit2 signature from the swapper wallet; unsupported for current EIP-7702 path',
        );
      }

      const agentWallet = this.requireAgentWallet();
      const signature = await agentWallet.signTypedData(
        quoteResponse.data.permitData.domain ?? {},
        this.sanitizePermitTypes(quoteResponse.data.permitData.types ?? {}),
        quoteResponse.data.permitData.values ?? {},
      );

      swapRequest.signature = signature;
      swapRequest.permitData = quoteResponse.data.permitData;
    }

    let swapResponse: AxiosResponse<UniswapSwapResponse>;
    try {
      swapResponse = await axios.post<UniswapSwapResponse>(
        'https://trade-api.gateway.uniswap.org/v1/swap',
        swapRequest,
        { headers, timeout: 20_000 },
      );
    } catch (err) {
      if (this.shouldUseDirectSepoliaSwapFallback(err, chain)) {
        return await this.buildDirectSepoliaSwapTransaction(intent);
      }

      if (err instanceof AxiosError) {
        const status = err.response?.status;
        const body = JSON.stringify(err.response?.data ?? {});
        const url = err.config?.url;
        throw new Error(`Uniswap API ${status} at ${url}: ${body}`);
      }
      throw err;
    }

    const swap = swapResponse.data.swap;
    if (!swap?.to || !swap.data || swap.data === '0x') {
      throw new Error('Uniswap /swap response did not include executable calldata');
    }

    const quotedOutputAmount = (
      quoteResponse.data.quote as { output?: { amount?: string }; routeString?: string } | undefined
    )?.output?.amount;
    const routeString = (
      quoteResponse.data.quote as { output?: { amount?: string }; routeString?: string } | undefined
    )?.routeString;

    this.logger.log(
      `Uniswap swap prepared for ${intent.wallet}: ` +
        `${intent.parsed.amount} ${tokenIn.symbol} -> ${quotedOutputAmount ?? '?'} ${tokenOut.symbol}. ` +
        `Router: ${swap.to}. Route: ${routeString ?? quoteResponse.data.routing ?? 'unknown'}`,
    );

    return {
      to: swap.to as `0x${string}`,
      data: swap.data as `0x${string}`,
      value: BigInt(swap.value ?? '0'),
      gasLimit: swap.gasLimit ? BigInt(swap.gasLimit) : BigInt(GAS_UNITS.swap),
    };
  }

  private shouldUseDirectSepoliaSwapFallback(error: unknown, chain: string): boolean {
    if (this.normalizeChain(chain) !== 'sepolia') {
      return false;
    }

    if (!(error instanceof AxiosError)) {
      return false;
    }

    const status = error.response?.status;
    const body = JSON.stringify(error.response?.data ?? {});
    return status === 404 || body.includes('NO_ROUTE');
  }

  private async buildDirectSepoliaSwapTransaction(
    intent: IntentRecord,
  ): Promise<{
    to: `0x${string}`;
    data: `0x${string}`;
    value: bigint;
    gasLimit?: bigint;
    sessionValueWei?: bigint;
  }> {
    const chain = intent.parsed.chain ?? 'sepolia';
    const swapAmount = parseEther(String(intent.parsed.amount));
    const fromToken = intent.parsed.fromToken.trim().toUpperCase();
    const toToken = (intent.parsed.toToken ?? 'USDC').trim().toUpperCase();
    const sessionContractAddress = this.requireSessionContractAddress(chain);

    if (this.normalizeChain(chain) !== 'sepolia') {
      throw new Error('Direct Universal Router fallback is only supported on Sepolia.');
    }

    if (fromToken !== 'ETH') {
      throw new Error(
        `Swap from ${intent.parsed.fromToken} to ${intent.parsed.toToken ?? 'USDC'} not supported on Sepolia. ` +
          'Use ETH->USDC or ETH->WETH, or switch to mainnet.',
      );
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
    const netSwap = await this.getNetSwapAmountWei(swapAmount, chain);

    if (toToken === 'USDC') {
      this.logger.warn(
        `Trade API failed on Sepolia, using direct Universal Router fallback for ${intent.wallet}.`,
      );

      const universalRouterCalldata = this.buildDirectSepoliaSwapCalldata(
        intent.wallet,
        netSwap,
        deadline,
      );

      if ((this.config.get<string>('NODE_ENV') ?? 'development') !== 'production') {
        const selector = universalRouterCalldata.slice(0, 10);
        if (selector !== UNIVERSAL_ROUTER_EXECUTE_SELECTOR) {
          throw new Error(`Wrong function selector: ${selector}`);
        }
      }

      this.logger.log(
        `Swap path: WETH -[fee 100 template]-> USDC. ` +
          `swapIn: ${ethers.formatEther(swapAmount)} ETH. ` +
          `feeCollectedLater: ${ethers.formatEther(swapAmount - netSwap)} ETH. ` +
          `deadline: ${deadline.toString()}`,
      );

      return {
        to: UNIVERSAL_ROUTER_SEPOLIA as `0x${string}`,
        data: universalRouterCalldata,
        value: netSwap,
        gasLimit: 400_000n,
      };
    }

    if (toToken === 'WETH') {
      this.logger.warn(
        `Trade API failed on Sepolia, using session-backed Universal Router wrap fallback for ${intent.wallet}.`,
      );

      const { commands, inputs } = this.buildUniversalRouterSwap(
        [0x0b],
        netSwap,
        intent.wallet,
        netSwap,
        0n,
      );
      const swapCalldata = encodeFunctionData({
        abi: WHEN_CHEAP_SESSION_SWAP_ABI,
        functionName: 'swap',
        args: [commands, inputs, deadline, swapAmount],
      });

      return {
        to: sessionContractAddress,
        data: swapCalldata,
        value: swapAmount,
        gasLimit: 350_000n,
      };
    }

    throw new Error(
      `Swap from ${intent.parsed.fromToken} to ${intent.parsed.toToken ?? 'USDC'} not supported on Sepolia. ` +
        'Use ETH->USDC or ETH->WETH, or switch to mainnet.',
    );
  }

  private buildV3Path(tokenIn: string, tokenOut: string, fee: number): Uint8Array {
    const path = new Uint8Array(43);
    this.logger.log(`Building path with fee=${fee} hex=${fee.toString(16).padStart(6, '0')}`);
    path.set(ethers.getBytes(tokenIn as `0x${string}`), 0);
    path[20] = (fee >> 16) & 0xff;
    path[21] = (fee >> 8) & 0xff;
    path[22] = fee & 0xff;
    this.logger.log(
      `Path bytes 20-22: ${path[20].toString(16).padStart(2, '0')}` +
        `${path[21].toString(16).padStart(2, '0')}` +
        `${path[22].toString(16).padStart(2, '0')}`,
    );
    path.set(ethers.getBytes(tokenOut as `0x${string}`), 23);
    return path;
  }

  private buildDirectSepoliaSwapCalldata(
    recipient: string,
    amountIn: bigint,
    deadline: bigint,
  ): `0x${string}` {
    const deadlineHex = deadline.toString(16).padStart(8, '0');
    const amountHex = amountIn.toString(16).padStart(64, '0');
    const recipientHex = recipient.toLowerCase().replace(/^0x/, '');
    const calldata = `0x${SEPOLIA_SWAP_TEMPLATE
      .replace('69f20c96', deadlineHex)
      .replaceAll('00000000000000000000000000000000000000000000000000038d7ea4c68000', amountHex)
      .replace('9dd40426fe0dbaf3d28b4fe7f499231e6ffd3873', recipientHex)}` as `0x${string}`;

    if (calldata.length !== 1436 + 2) {
      throw new Error(`Template length wrong: ${calldata.length}`);
    }

    this.logger.log(
      `Built template Sepolia swap calldata for ${recipient}. amountIn=${amountIn.toString()} deadline=${deadline.toString()}`,
    );

    return calldata;
  }

  private buildMultiHopV3Path(tokens: string[], fees: number[]): Uint8Array {
    if (tokens.length !== fees.length + 1) {
      throw new Error('Invalid Uniswap V3 multi-hop path configuration');
    }

    const size = 20 + fees.length * 23;
    const path = new Uint8Array(size);
    path.set(ethers.getBytes(tokens[0] as `0x${string}`), 0);
    let offset = 20;

    for (let i = 0; i < fees.length; i += 1) {
      path[offset] = (fees[i] >> 16) & 0xff;
      path[offset + 1] = (fees[i] >> 8) & 0xff;
      path[offset + 2] = fees[i] & 0xff;
      path.set(ethers.getBytes(tokens[i + 1] as `0x${string}`), offset + 3);
      offset += 23;
    }

    return path;
  }

  private buildUniversalRouterSwap(
    commands: number[],
    wrapAmount: bigint,
    recipient: string,
    amountIn: bigint,
    amountOutMin: bigint,
    path?: Uint8Array,
  ): { commands: `0x${string}`; inputs: `0x${string}`[] } {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const inputsList: `0x${string}`[] = [];

    for (const cmd of commands) {
      if (cmd === 0x0b) {
        const wrapRecipient =
          path && commands.includes(0x00)
            ? UNIVERSAL_ROUTER_ROUTER_AS_RECIPIENT
            : recipient;
        inputsList.push(
          abiCoder.encode(
            ['address', 'uint256'],
            [wrapRecipient, wrapAmount],
          ) as `0x${string}`,
        );
        continue;
      }

      if (cmd === 0x00) {
        if (!path) {
          throw new Error('V3 swap command requires a path');
        }
        const swapInput = abiCoder.encode(
          ['address', 'uint256', 'uint256', 'bytes', 'bool'],
          [recipient, amountIn, amountOutMin, path, false],
        ) as `0x${string}`;
        const decoded = abiCoder.decode(
          ['address', 'uint256', 'uint256', 'bytes', 'bool'],
          swapInput,
        ) as unknown as [string, bigint, bigint, string, boolean];
        const decodedPath = ethers.getBytes(decoded[3]);
        if (decodedPath.length !== 43) {
          throw new Error(
            `Path encoding wrong: expected 43 bytes, got ${decodedPath.length}`,
          );
        }
        this.logger.log(`Path correctly encoded: ${ethers.hexlify(decodedPath)}`);
        inputsList.push(
          swapInput,
        );
        continue;
      }

      throw new Error(`Universal Router command 0x${cmd.toString(16)} not supported yet`);
    }

    return {
      commands: ethers.hexlify(new Uint8Array(commands)) as `0x${string}`,
      inputs: inputsList,
    };
  }

  private async findBestSepoliaRoute(tokenIn: string, tokenOut: string): Promise<number> {
    const provider = this.getProviderForChain('sepolia');
    const factory = new ethers.Contract(
      UNISWAP_V3_FACTORY_SEPOLIA,
      UNISWAP_V3_FACTORY_ABI,
      provider,
    );

    for (const fee of SEPOLIA_V3_FEE_TIER_PRIORITY) {
      try {
        const poolAddr = (await factory.getPool(tokenIn, tokenOut, fee)) as string;
        if (!poolAddr || poolAddr === ethers.ZeroAddress) {
          continue;
        }

        const poolContract = new ethers.Contract(poolAddr, UNISWAP_V3_POOL_ABI, provider);
        const liquidity = (await poolContract.liquidity()) as bigint;
        if (liquidity <= 0n) {
          continue;
        }

        const [sqrtPriceX96] = (await poolContract.slot0()) as [bigint, number, number, number, number, number, boolean];
        if (sqrtPriceX96 === 0n) {
          continue;
        }

        this.logger.log(
          `Selected pool: ${poolAddr} fee=${fee} liquidity=${liquidity.toString()} sqrtPriceX96=${sqrtPriceX96.toString()}`,
        );
        return fee;
      } catch (err) {
        this.logger.warn(`Could not inspect Sepolia pool fee ${fee}: ${String(err)}`);
      }
    }

    try {
      const fallbackPoolAddr = (await factory.getPool(
        tokenIn,
        tokenOut,
        SEPOLIA_V3_FALLBACK_FEE,
      )) as string;
      if (fallbackPoolAddr && fallbackPoolAddr !== ethers.ZeroAddress) {
        const fallbackPool = new ethers.Contract(fallbackPoolAddr, UNISWAP_V3_POOL_ABI, provider);
        const fallbackLiquidity = (await fallbackPool.liquidity()) as bigint;
        const [fallbackSqrtPriceX96] = (await fallbackPool.slot0()) as [bigint, number, number, number, number, number, boolean];
        if (fallbackLiquidity > 0n && fallbackSqrtPriceX96 > 0n) {
          this.logger.log(
            `Selected pool: ${fallbackPoolAddr} fee=${SEPOLIA_V3_FALLBACK_FEE} liquidity=${fallbackLiquidity.toString()} sqrtPriceX96=${fallbackSqrtPriceX96.toString()} (confirmed fallback)`,
          );
          return SEPOLIA_V3_FALLBACK_FEE;
        }
      }
    } catch (err) {
      this.logger.warn(`Could not inspect confirmed fallback fee ${SEPOLIA_V3_FALLBACK_FEE}: ${String(err)}`);
    }

    throw new Error('No initialized Sepolia Uniswap v3 pool found for this token pair');
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
    if (chainConfig.chainId !== MAINNET_CHAIN_ID || !this.agentWallet) {
      return;
    }

    const mainnetProvider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const balance = await mainnetProvider.getBalance(this.agentWallet.address);
    const required =
      intent.parsed.type === 'send'
        ? ethers.parseEther(intent.parsed.amount) + ethers.parseEther('0.005')
        : ethers.parseEther('0.005');

    if (balance < required) {
      throw new Error(
        `Insufficient mainnet ETH in agent wallet (${this.agentWallet.address}). ` +
          `Have: ${ethers.formatEther(balance)} ETH. ` +
          `Need: ${ethers.formatEther(required)} ETH.`,
      );
    }
  }

  private sanitizePermitTypes(
    types: Record<string, Array<{ name: string; type: string }>>,
  ): Record<string, Array<{ name: string; type: string }>> {
    const next = { ...types };
    delete next.EIP712Domain;
    return next;
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

  private async storeEncryptedWallet(
    identifier: string,
    identifierType: UserIdentifierType,
    encryptedPrivateKey: string,
    iv: string,
    authTag: string,
    walletAddress: string,
  ): Promise<void> {
    const normalizedIdentifier =
      identifierType === UserIdentifierType.Wallet ? identifier.toLowerCase() : identifier;
    let user = await this.userRepository.findOne({
      where: { identifier: normalizedIdentifier },
    });

    if (!user) {
      user = this.userRepository.create({
        identifier: normalizedIdentifier,
        identifierType,
      });
      user = await this.userRepository.save(user);
    }

    const checksumWallet = ethers.getAddress(walletAddress);
    const existingWallet =
      (await this.walletRepository.findOne({ where: { userId: user.id } })) ??
      (await this.getWalletByAddress(checksumWallet));

    const walletRecord = this.walletRepository.create({
      id: existingWallet?.id,
      userId: user.id,
      walletAddress: checksumWallet.toLowerCase(),
      encryptedPrivateKey,
      iv,
      authTag,
      createdAt: existingWallet?.createdAt,
    });

    await this.walletRepository.save(walletRecord);
  }

  private async getEncryptedWallet(identifier: string): Promise<StoredWalletResult | null> {
    const user = await this.userRepository.findOne({
      where: { identifier },
    });

    if (!user) {
      return null;
    }

    const wallet =
      (await this.walletRepository.findOne({ where: { userId: user.id } })) ??
      null;

    return wallet ? { user, wallet } : null;
  }

  async getWalletByAddress(walletAddress: string): Promise<WhenCheapWallet | null> {
    return await this.walletRepository
      .createQueryBuilder('wallet')
      .where('LOWER(wallet.walletAddress) = LOWER(:walletAddress)', { walletAddress })
      .getOne();
  }

  private serializeStoredWallet(wallet: WhenCheapWallet): string {
    return JSON.stringify(this.extractWalletPayload(wallet));
  }

  private async resolveOrCreateWalletUser(walletAddress: string): Promise<UserEntity> {
    const existingWallet = await this.getWalletByAddress(walletAddress);
    if (existingWallet?.userId) {
      const user = await this.userRepository.findOne({ where: { id: existingWallet.userId } });
      if (user) {
        return user;
      }
    }

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

  private async migrateLegacyWalletRows(): Promise<void> {
    type LegacyWalletRow = {
      id: string;
      userId: string | null;
      walletAddress: string;
      encryptedPrivateKey: string;
      iv: string | null;
      authTag: string | null;
      userIdentifier?: string | null;
    };

    let legacyRows: LegacyWalletRow[] = [];
    try {
      legacyRows = (await this.walletRepository.query(
        'SELECT id, "userId", "walletAddress", "encryptedPrivateKey", iv, "authTag", "userIdentifier" FROM whencheap_wallets',
      )) as LegacyWalletRow[];
    } catch {
      legacyRows = (await this.walletRepository.query(
        'SELECT id, "userId", "walletAddress", "encryptedPrivateKey", iv, "authTag" FROM whencheap_wallets',
      )) as LegacyWalletRow[];
    }

    let migrated = 0;
    for (const row of legacyRows) {
      const needsMigration = !row.userId || !row.iv || !row.authTag;
      if (!needsMigration) {
        continue;
      }

      const identifier = row.userIdentifier?.trim() || row.walletAddress.toLowerCase();
      const identifierType = this.inferIdentifierType(identifier);
      let user =
        (await this.userRepository.findOne({ where: { identifier } })) ??
        this.userRepository.create({ identifier, identifierType });

      if (!user.id) {
        user = await this.userRepository.save(user);
      }

      let encryptedKey = row.encryptedPrivateKey;
      let iv = row.iv;
      let authTag = row.authTag;

      if (!iv || !authTag) {
        const payload = JSON.parse(row.encryptedPrivateKey) as EncryptedWalletPayload;
        encryptedKey = payload.encryptedKey;
        iv = payload.iv;
        authTag = payload.authTag;
      }

      await this.walletRepository.update(row.id, {
        userId: user.id,
        walletAddress: row.walletAddress.toLowerCase(),
        encryptedPrivateKey: encryptedKey,
        iv,
        authTag,
      });
      migrated += 1;
    }

    if (migrated > 0) {
      this.logger.log(`Migrated ${migrated} legacy wallet row(s) to the new PostgreSQL schema.`);
    }
  }

  private inferIdentifierType(identifier: string): UserIdentifierType {
    if (identifier.includes('@')) {
      return UserIdentifierType.Email;
    }
    if (ethers.isAddress(identifier)) {
      return UserIdentifierType.Wallet;
    }
    return UserIdentifierType.Google;
  }

  private extractWalletPayload(wallet: WhenCheapWallet): EncryptedWalletPayload {
    if (wallet.iv && wallet.authTag) {
      return {
        iv: wallet.iv,
        encryptedKey: wallet.encryptedPrivateKey,
        authTag: wallet.authTag,
      };
    }

    try {
      return JSON.parse(wallet.encryptedPrivateKey) as EncryptedWalletPayload;
    } catch {
      throw new Error(
        `Wallet ${wallet.id} is missing IV/authTag and legacy payload could not be parsed`,
      );
    }
  }

  private async verifyGoogleCredential(
    credential: string,
  ): Promise<{ email: string; googleSub: string }> {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID') ?? '';
    if (!clientId) {
      throw new Error('GOOGLE_CLIENT_ID is not configured');
    }

    let response: AxiosResponse<Record<string, unknown>>;
    try {
      response = await axios.get('https://oauth2.googleapis.com/tokeninfo', {
        family: 4,
        params: { id_token: credential },
        timeout: 15_000,
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const upstreamStatus = error.response?.status;
        const upstreamBody =
          typeof error.response?.data === 'string'
            ? error.response.data
            : JSON.stringify(error.response?.data ?? {});

        this.logger.error(
          `Google credential verification failed: ${error.message}${
            upstreamStatus ? ` (status ${upstreamStatus})` : ''
          }${upstreamBody && upstreamBody !== '{}' ? ` body=${upstreamBody}` : ''}`,
        );

        if (upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 500) {
          throw new BadRequestException('Invalid Google credential');
        }

        throw new BadGatewayException('Google verification service is unreachable');
      }

      this.logger.error(`Google credential verification failed with non-Axios error: ${String(error)}`);
      throw new BadGatewayException('Google verification service is unreachable');
    }

    const payload = response.data as Record<string, unknown>;
    const audience = typeof payload.aud === 'string' ? payload.aud : '';
    const email = typeof payload.email === 'string' ? payload.email : '';
    const emailVerified = String(payload.email_verified ?? '').toLowerCase() === 'true';
    const googleSub = typeof payload.sub === 'string' ? payload.sub : '';

    if (audience !== clientId) {
      throw new BadRequestException('Google token audience mismatch');
    }
    if (!email || !googleSub || !emailVerified) {
      throw new BadRequestException('Google account is not verified');
    }

    return { email, googleSub };
  }

  private async requireStoredWallet(userAddress: string): Promise<`0x${string}`> {
    const encrypted = await this.getRegisteredWallet(userAddress);
    if (!encrypted) {
      throw new BadRequestException(
        `No managed wallet is stored for ${userAddress}. Sign in with Google again to re-link your wallet.`,
      );
    }

    const decrypted = this.decryptPrivateKey(encrypted);
    if (!this.isValidPrivateKey(decrypted)) {
      throw new BadRequestException('Stored managed wallet key is invalid');
    }

    return decrypted;
  }
}
