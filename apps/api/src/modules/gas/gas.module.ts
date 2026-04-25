import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GasOracleService } from './gas-oracle.service';

@Module({
  imports: [ConfigModule],
  providers: [GasOracleService],
  exports: [GasOracleService]
})
export class GasModule {}
