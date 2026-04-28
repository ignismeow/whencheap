import { BadGatewayException, BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import axios, { AxiosResponse } from 'axios';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ethers } from 'ethers';
import { Repository } from 'typeorm';
import { createWalletClient, encodeFunctionData, http, parseAbi, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
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
  'function recordSpend(address wallet, uint256 feeWei)',
  'function authorize(uint256 maxFeePerTxWei, uint256 maxTotalSpendWei, uint256 durationSeconds)',
  'function revokeSession()',
  'function execute(address to, uint256 value, bytes data)',
  'function agentAddress() view returns (address)',
];

const SESSION_VIEM_ABI = parseAbi(SESSION_ABI);
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
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
];

const GAS_UNITS = { send: 21_000, swap: 150_000 } as const;
const SEPOLIA_CHAIN_ID = 11155111;
const NATIVE_ETH = '0x0000000000000000000000000000000000000000';
const TOKEN_REGISTRY: Record<string, { address: string; decimals: number; symbol: string }> = {
  ETH: { address: NATIVE_ETH, decimals: 18, symbol: 'ETH' },
  WETH: {
    address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
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
export class SessionSignerService {
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

  get agentAddress(): string | null {
    return this.agentWallet?.address ?? null;
  }

  async storeAuthorization(userAddress: string, authorization: unknown): Promise<void> {
    const key = userAddress.toLowerCase();
    const user = await this.resolveOrCreateWalletUser(key);
    await this.sessionRepository.upsert(
      {
        userId: user.id,
        walletAddress: key,
        authorizationJson: JSON.stringify(authorization),
        isActive: true,
        expiresAt: null,
      },
      ['walletAddress'],
    );
    this.logger.log(`Stored EIP-7702 authorization for ${userAddress}`);
  }

  async getAuthorization(userAddress: string): Promise<unknown | null> {
    const key = userAddress.toLowerCase();
    const persisted = await this.sessionRepository.findOne({
      where: { walletAddress: key, isActive: true },
    });

    if (!persisted) {
      return null;
    }

    try {
      return JSON.parse(persisted.authorizationJson) as unknown;
    } catch {
      this.logger.warn(`Stored authorization for ${key} is invalid JSON.`);
      return null;
    }
  }

  async hasAuthorization(userAddress: string): Promise<boolean> {
    const key = userAddress.toLowerCase();
    return (await this.sessionRepository.count({ where: { walletAddress: key, isActive: true } })) > 0;
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
      await this.storeEncryptedWallet(
        googleProfile.email.toLowerCase(),
        UserIdentifierType.Email,
        existing.wallet.encryptedPrivateKey,
        existing.wallet.iv,
        existing.wallet.authTag,
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
      const sessionContractAddress = this.requireSessionContractAddress();
      const rpcUrl = this.requireRpcUrl();
      const account = privateKeyToAccount(wallet);
      const balance = await this.provider.getBalance(account.address);

      if (balance === 0n) {
        throw new BadRequestException(
          `Managed wallet ${account.address} has no Sepolia ETH. Fund it before authorizing a session.`,
        );
      }

      const client = createWalletClient({
        account,
        chain: sepolia,
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
        chain: sepolia,
        account,
      });

      await this.provider.waitForTransaction(txHash, 1);
      const normalizedAddress = dto.userAddress.toLowerCase();
      const user = await this.resolveOrCreateWalletUser(normalizedAddress);
      await this.sessionRepository.upsert(
        {
          userId: user.id,
          walletAddress: normalizedAddress,
          authorizationJson: JSON.stringify({
            type: 'managed-wallet-session',
            txHash,
          }),
          isActive: true,
          expiresAt: new Date(Date.now() + Number(dto.expiryHours) * 60 * 60 * 1000),
        },
        ['walletAddress'],
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

  async revokeManagedWalletSession(userAddress: string): Promise<{ ok: true; txHash: string }> {
    try {
      const wallet = await this.requireStoredWallet(userAddress);
      const sessionContractAddress = this.requireSessionContractAddress();
      const rpcUrl = this.requireRpcUrl();
      const account = privateKeyToAccount(wallet);
      const client = createWalletClient({
        account,
        chain: sepolia,
        transport: http(rpcUrl),
      });

      const txHash = await client.writeContract({
        address: sessionContractAddress,
        abi: SESSION_VIEM_ABI,
        functionName: 'revokeSession',
        args: [],
        chain: sepolia,
        account,
      });

      await this.provider.waitForTransaction(txHash, 1);
      await this.sessionRepository
        .createQueryBuilder()
        .update(SessionAuthorizationEntity)
        .set({ isActive: false })
        .where('LOWER(walletAddress) = LOWER(:walletAddress)', { walletAddress: userAddress })
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
  async canExecuteSession(wallet: string, feeWei: bigint): Promise<boolean> {
    if (!this.sessionContract) return true;
    try {
      return (await this.sessionContract.canExecute(wallet, feeWei)) as boolean;
    } catch (err) {
      this.logger.warn(`canExecute check failed for ${wallet}: ${String(err)}`);
      return false;
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
    const sessionContractAddress = this.requireSessionContractAddress();
    const rpcUrl = this.requireRpcUrl();

    if (userAccount.address.toLowerCase() !== intent.wallet.toLowerCase()) {
      throw new Error('Stored wallet does not match intent wallet');
    }

    const userClient = createWalletClient({
      account: userAccount,
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const authorizeHash = await userClient.writeContract({
      address: sessionContractAddress,
      abi: SESSION_VIEM_ABI,
      functionName: 'authorize',
      args: [parseEther('0.001'), parseEther('0.01'), 86400n],
      chain: sepolia,
      account: userAccount,
    });
    await this.provider.waitForTransaction(authorizeHash, 1);

    const freshNonce = await this.provider.getTransactionCount(userAccount.address, 'latest');
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
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const execution = await this.buildExecutionTransaction(intent, userAccount.address);
    const executeCalldata = encodeFunctionData({
      abi: WHEN_CHEAP_SESSION_EXECUTE_ABI,
      functionName: 'execute',
      args: [
        execution.to as `0x${string}`,
        execution.value,
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
      value: parseEther(String(intent.parsed.amount)),
      gas: 200_000n,
    });
  }

  private async broadcastAgentWalletExecution(
    intent: IntentRecord,
    baseFeeGwei: number,
  ): Promise<string> {
    const agentWallet = this.requireAgentWallet();
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

    const agentAccount = privateKeyToAccount(pk as `0x${string}`);
    const rpcUrl = this.config.get<string>('RPC_URL') ?? '';
    const agentClient = createWalletClient({
      account: agentAccount,
      chain: sepolia,
      transport: http(rpcUrl),
    });

    const execution = await this.buildExecutionTransaction(intent, agentAccount.address);
    const sessionContractAddress = this.requireSessionContractAddress();

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

  async recordSpend(wallet: string, feeWei: bigint): Promise<string | null> {
    const agentWallet = this.requireAgentWallet();
    if (!this.sessionContract) return null;

    const writable = this.sessionContract.connect(agentWallet) as ethers.Contract;
    const tx = await writable.recordSpend(wallet, feeWei);
    await tx.wait(1);
    return tx.hash as string;
  }

  estimateFeeWei(baseFeeGwei: number, type: 'send' | 'swap' = 'send'): bigint {
    const gasUnits = GAS_UNITS[type] ?? GAS_UNITS.send;
    // 1.2x multiplier matches the priority tip added in broadcastIntent
    return BigInt(Math.round(baseFeeGwei * 1.2 * 1e9)) * BigInt(gasUnits);
  }

  private requireAgentWallet(): ethers.Wallet {
    this.requireAgentPrivateKey();
    if (!this.agentWallet) throw new Error('AGENT_WALLET_PK is invalid or not configured');
    return this.agentWallet;
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

  private requireSessionContractAddress(): `0x${string}` {
    const contractAddress = this.config.get<string>('SESSION_CONTRACT_ADDR') ?? '';
    if (!ethers.isAddress(contractAddress)) {
      throw new Error('SESSION_CONTRACT_ADDR is missing or invalid');
    }
    return contractAddress as `0x${string}`;
  }

  private requireRpcUrl(): string {
    const rpcUrl = this.config.get<string>('RPC_URL') ?? '';
    if (!rpcUrl) {
      throw new Error('RPC_URL is not configured');
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
      return await this.provider.resolveName(name);
    } catch (error) {
      this.logger.warn(`ENS resolution failed for ${name}: ${String(error)}`);
      return null;
    }
  }

  private async buildExecutionTransaction(
    intent: IntentRecord,
    swapper: string,
  ): Promise<{ to: `0x${string}`; data: `0x${string}`; value: bigint; gasLimit?: bigint }> {
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
  ): Promise<{ to: `0x${string}`; data: `0x${string}`; value: bigint; gasLimit?: bigint }> {
    const tokenIn = this.resolveToken(intent.parsed.fromToken);
    const tokenOut = this.resolveToken(intent.parsed.toToken ?? 'USDC');
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
      'x-erc20eth-enabled': tokenIn.address === NATIVE_ETH ? 'true' : 'false',
    };

    const quoteResponse = await axios.post<UniswapQuoteResponse>(
      'https://trade-api.gateway.uniswap.org/v1/quote',
      {
        type: 'EXACT_INPUT',
        amount,
        tokenInChainId: SEPOLIA_CHAIN_ID,
        tokenOutChainId: SEPOLIA_CHAIN_ID,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        swapper,
        slippageTolerance: intent.parsed.slippageBps / 100,
        routingPreference: 'BEST_PRICE',
        protocols: ['V4'],
      },
      { headers, timeout: 20_000 },
    );

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

    const swapResponse = await axios.post<UniswapSwapResponse>(
      'https://trade-api.gateway.uniswap.org/v1/swap',
      swapRequest,
      { headers, timeout: 20_000 },
    );

    const swap = swapResponse.data.swap;
    if (!swap?.to || !swap.data || swap.data === '0x') {
      throw new Error('Uniswap /swap response did not include executable calldata');
    }

    return {
      to: swap.to as `0x${string}`,
      data: swap.data as `0x${string}`,
      value: BigInt(swap.value ?? '0'),
      gasLimit: swap.gasLimit ? BigInt(swap.gasLimit) : BigInt(GAS_UNITS.swap),
    };
  }

  private resolveToken(symbol: string): { address: string; decimals: number; symbol: string } {
    const normalized = symbol.trim().toUpperCase();
    const token = TOKEN_REGISTRY[normalized];

    if (!token) {
      throw new Error(`Unsupported Sepolia token "${symbol}". Supported tokens: ETH, USDC, WETH`);
    }

    return token;
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
    return JSON.stringify({
      iv: wallet.iv,
      encryptedKey: wallet.encryptedPrivateKey,
      authTag: wallet.authTag,
    } satisfies EncryptedWalletPayload);
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
