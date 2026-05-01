import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GasOracleService } from './gas-oracle.service';
import { GasCronService } from './gas-cron.service';
import { GasSnapshotEntity } from './gas-snapshot.entity';
import { GasService } from './gas.service';
import { GasController } from './gas.controller';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([GasSnapshotEntity])],
  controllers: [GasController],
  providers: [GasOracleService, GasService, GasCronService],
  exports: [GasOracleService, GasService]
})
export class GasModule {}
