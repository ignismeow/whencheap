import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GasSnapshotEntity } from './gas-snapshot.entity';
import { GasService } from './gas.service';

@Injectable()
export class GasCronService implements OnModuleInit {
  private readonly logger = new Logger(GasCronService.name);

  constructor(
    private readonly gasService: GasService,
    @InjectRepository(GasSnapshotEntity)
    private readonly snapshotRepo: Repository<GasSnapshotEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.snapshotRepo.query(`
      CREATE TABLE IF NOT EXISTS gas_snapshots (
        id SERIAL PRIMARY KEY,
        chain VARCHAR(20) NOT NULL,
        "baseFeeGwei" DECIMAL(30,12) NOT NULL,
        "priorityFeeGwei" DECIMAL(30,12) NOT NULL,
        "safeLowGwei" DECIMAL(30,12) NOT NULL,
        "standardGwei" DECIMAL(30,12) NOT NULL,
        "fastGwei" DECIMAL(30,12) NOT NULL,
        "ethPriceUsd" DECIMAL(10,2) NOT NULL,
        "capturedAt" TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await this.snapshotRepo.query(`
      CREATE INDEX IF NOT EXISTS idx_gas_snapshots_chain_time
      ON gas_snapshots (chain, "capturedAt" DESC)
    `);
    this.logger.log('gas_snapshots table ready');

    await this.collectGasData();
  }

  @Cron('*/30 * * * * *')
  async collectGasData(): Promise<void> {
    for (const chain of ['sepolia', 'mainnet']) {
      try {
        const snapshot = await this.gasService.getCurrentGas(chain);
        await this.snapshotRepo.save(
          this.snapshotRepo.create({
            chain,
            baseFeeGwei: snapshot.baseFeeGwei,
            priorityFeeGwei: snapshot.priorityFeeGwei,
            safeLowGwei: snapshot.safeLowGwei,
            standardGwei: snapshot.standardGwei,
            fastGwei: snapshot.fastGwei,
            ethPriceUsd: snapshot.ethPriceUsd,
          }),
        );
      } catch (err) {
        this.logger.warn(`Gas collection failed for ${chain}: ${String(err)}`);
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async pruneOldData(): Promise<void> {
    await this.snapshotRepo.query(`
      DELETE FROM gas_snapshots
      WHERE "capturedAt" < NOW() - INTERVAL '7 days'
    `);
    this.logger.log('Pruned gas snapshots older than 7 days');
  }
}
