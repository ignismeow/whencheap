import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { formatEther } from 'viem';
import { AuditEventEntity } from './intents/audit-event.entity';
import { SessionSignerService } from './session/session-signer.service';

@Injectable()
export class StatsService {
  constructor(
    private readonly config: ConfigService,
    private readonly sessionSigner: SessionSignerService,
    @InjectRepository(AuditEventEntity)
    private readonly auditRepository: Repository<AuditEventEntity>,
  ) {}

  async getTreasuryStats() {
    const treasuryWallet = this.config.get<string>('TREASURY_WALLET') ?? '';
    const network = this.config.get<string>('NETWORK') ?? 'sepolia';

    const events = await this.auditRepository.find({
      where: { eventType: 'FEE_COLLECTED' },
      order: { createdAt: 'DESC' },
    });

    const totalFeesWei = events.reduce((sum, event) => {
      const value = event.metadata?.feeWei;
      if (typeof value !== 'string' && typeof value !== 'number') {
        return sum;
      }
      return sum + BigInt(value);
    }, 0n);

    const totalExecutions = events.length;
    const averageFeeWei = totalExecutions > 0 ? totalFeesWei / BigInt(totalExecutions) : 0n;
    const treasuryBalanceWei = treasuryWallet
      ? await this.sessionSigner.getProviderForChain(network).getBalance(treasuryWallet)
      : 0n;

    return {
      totalFeesCollected: formatEther(totalFeesWei),
      totalExecutions,
      averageFeeEth: formatEther(averageFeeWei),
      treasuryWallet,
      treasuryBalance: formatEther(treasuryBalanceWei),
    };
  }
}
