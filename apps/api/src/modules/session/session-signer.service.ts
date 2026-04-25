import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { IntentRecord } from '../intents/intent.types';

const SESSION_ABI = [
  'function canExecute(address wallet, uint256 feeWei) view returns (bool)'
];

const GAS_UNITS = { send: 21_000, swap: 150_000 } as const;

@Injectable()
export class SessionSignerService {
  private readonly logger = new Logger(SessionSignerService.name);
  readonly provider: ethers.JsonRpcProvider;
  private readonly agentWallet: ethers.Wallet | null;
  private readonly sessionContract: ethers.Contract | null;

  constructor(private readonly config: ConfigService) {
    const rpcUrl = this.config.get<string>('RPC_URL') ?? '';
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    const pk = this.config.get<string>('AGENT_WALLET_PK');
    this.agentWallet = pk ? new ethers.Wallet(pk, this.provider) : null;

    const contractAddr = this.config.get<string>('SESSION_CONTRACT_ADDR');
    this.sessionContract = contractAddr
      ? new ethers.Contract(contractAddr, SESSION_ABI, this.provider)
      : null;

    if (!this.agentWallet) {
      this.logger.warn('AGENT_WALLET_PK not set — direct execution disabled, falling back to KeeperHub');
    }
    if (!this.sessionContract) {
      this.logger.warn('SESSION_CONTRACT_ADDR not set — session validation skipped');
    }
  }

  get agentAddress(): string | null {
    return this.agentWallet?.address ?? null;
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

  // Broadcasts the tx and returns the hash immediately (no waiting for confirmation)
  async broadcastIntent(intent: IntentRecord, baseFeeGwei: number): Promise<string> {
    if (!this.agentWallet) throw new Error('AGENT_WALLET_PK not configured');
    if (intent.parsed.type !== 'send') throw new Error('Direct execution only supports send intents');
    if (!intent.parsed.recipient) throw new Error('Intent has no recipient');

    const gasPriceWei = BigInt(Math.round(baseFeeGwei * 1.2 * 1e9));
    const gasLimit = BigInt(GAS_UNITS.send);

    const tx = await this.agentWallet.sendTransaction({
      to: intent.parsed.recipient,
      value: ethers.parseEther(String(intent.parsed.amount)),
      gasLimit,
      gasPrice: gasPriceWei
    });

    this.logger.log(`Broadcast tx ${tx.hash} for intent ${intent.id} (agent: ${this.agentWallet.address})`);
    return tx.hash;
  }

  estimateFeeWei(baseFeeGwei: number, type: 'send' | 'swap' = 'send'): bigint {
    const gasUnits = GAS_UNITS[type] ?? GAS_UNITS.send;
    // 1.2x multiplier matches the priority tip added in broadcastIntent
    return BigInt(Math.round(baseFeeGwei * 1.2 * 1e9)) * BigInt(gasUnits);
  }
}
