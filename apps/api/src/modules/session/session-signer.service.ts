import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { createWalletClient, http, parseAbi, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { IntentRecord } from '../intents/intent.types';

const SESSION_ABI = [
  'function canExecute(address wallet, uint256 feeWei) view returns (bool)',
  'function recordSpend(address wallet, uint256 feeWei)',
  'function execute(address to, uint256 value, bytes data)',
  'function agentAddress() view returns (address)'
];

const SESSION_VIEM_ABI = parseAbi(SESSION_ABI);

const GAS_UNITS = { send: 21_000, swap: 150_000 } as const;

@Injectable()
export class SessionSignerService {
  private readonly logger = new Logger(SessionSignerService.name);
  readonly provider: ethers.JsonRpcProvider;
  private readonly agentWalletPk: string | null;
  private readonly agentWallet: ethers.Wallet | null;
  private readonly sessionContract: ethers.Contract | null;
  private readonly authorizations = new Map<string, unknown>();

  constructor(private readonly config: ConfigService) {
    const rpcUrl = this.config.get<string>('RPC_URL') ?? '';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    const pk = this.config.get<string>('AGENT_WALLET_PK') ?? '';
    this.agentWalletPk = pk || null;
    this.agentWallet = this.isValidPrivateKey(pk) ? new ethers.Wallet(pk, this.provider) : null;

    const contractAddr = this.config.get<string>('SESSION_CONTRACT_ADDR');
    this.sessionContract = contractAddr
      ? new ethers.Contract(contractAddr, SESSION_ABI, this.provider)
      : null;

    if (!pk) {
      this.logger.warn('AGENT_WALLET_PK not set — agent wallet execution unavailable');
    } else if (!this.agentWallet) {
      this.logger.warn('AGENT_WALLET_PK is not a valid 66-character 0x-prefixed hex private key — agent wallet execution unavailable');
    }
    if (!this.sessionContract) {
      this.logger.warn('SESSION_CONTRACT_ADDR not set — session validation skipped');
    }
  }

  get agentAddress(): string | null {
    return this.agentWallet?.address ?? null;
  }

  storeAuthorization(userAddress: string, authorization: unknown): void {
    this.authorizations.set(userAddress.toLowerCase(), authorization);
    this.logger.log(`Stored EIP-7702 authorization for ${userAddress}`);
  }

  getAuthorization(userAddress: string): unknown | null {
    return this.authorizations.get(userAddress.toLowerCase()) ?? null;
  }

  hasAuthorization(userAddress: string): boolean {
    return this.authorizations.has(userAddress.toLowerCase());
  }

  // View call — no gas, just checks session limits on-chain
  async canExecuteSession(wallet: string, feeWei: bigint): Promise<boolean> {
    if (!this.sessionContract) return true;
    try {
      return await this.sessionContract.canExecute(wallet, feeWei) as boolean;
    } catch (err) {
      this.logger.warn(`canExecute check failed for ${wallet}: ${String(err)}`);
      return false;
    }
  }

  // Broadcasts an agent-funded fallback tx and returns the hash immediately.
  // This does NOT send from the user's wallet. EIP-7702 delegated execution needs
  // a separate account implementation path and should not be faked by setting `from`.
  async broadcastIntent(intent: IntentRecord, baseFeeGwei: number): Promise<string> {
    const agentWallet = this.requireAgentWallet();
    if (intent.parsed.type !== 'send') throw new Error('Direct execution only supports send intents');
    if (!intent.parsed.recipient) throw new Error('Intent has no recipient');

    const gasPriceWei = BigInt(Math.round(baseFeeGwei * 1.2 * 1e9));
    const gasLimit = BigInt(GAS_UNITS.send);

    const tx = await agentWallet.sendTransaction({
      to: intent.parsed.recipient,
      value: ethers.parseEther(String(intent.parsed.amount)),
      gasLimit,
      gasPrice: gasPriceWei
    });

    this.logger.log(`Broadcast agent-funded fallback tx ${tx.hash} for intent ${intent.id} (from agent: ${agentWallet.address})`);
    return tx.hash;
  }

  async broadcastEIP7702Intent(intent: IntentRecord, authorization: unknown, baseFeeGwei: number): Promise<string> {
    const pk = this.requireAgentPrivateKey();
    if (intent.parsed.type !== 'send') throw new Error('EIP-7702 execution only supports send intents currently');
    if (!intent.parsed.recipient) throw new Error('Intent has no recipient');

    const agentAccount = privateKeyToAccount(pk as `0x${string}`);
    const rpcUrl = this.config.get<string>('RPC_URL') ?? '';
    const client = createWalletClient({
      account: agentAccount,
      chain: sepolia,
      transport: http(rpcUrl)
    });

    const gasPriceWei = BigInt(Math.round(baseFeeGwei * 1.2 * 1e9));
    const hash = await (client as unknown as {
      writeContract: (request: {
        authorizationList: unknown[];
        address: `0x${string}`;
        abi: typeof SESSION_VIEM_ABI;
        functionName: 'execute';
        args: [`0x${string}`, bigint, `0x${string}`];
        gas?: bigint;
        gasPrice?: bigint;
      }) => Promise<`0x${string}`>;
    }).writeContract({
      authorizationList: [authorization],
      address: intent.wallet as `0x${string}`,
      abi: SESSION_VIEM_ABI,
      functionName: 'execute',
      args: [
        intent.parsed.recipient as `0x${string}`,
        parseEther(String(intent.parsed.amount)),
        '0x'
      ],
      gas: BigInt(GAS_UNITS.send + 30_000),
      gasPrice: gasPriceWei
    });

    this.logger.log(
      `EIP-7702 delegated execute tx ${hash} broadcast for intent ${intent.id}. ` +
      `Delegated wallet: ${intent.wallet}. Agent relay: ${agentAccount.address}.`
    );

    return hash;
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
      throw new Error('AGENT_WALLET_PK must be a 66-character 0x-prefixed hex private key');
    }
    return pk as `0x${string}`;
  }

  private isValidPrivateKey(pk: string): pk is `0x${string}` {
    return /^0x[0-9a-fA-F]{64}$/.test(pk);
  }
}
