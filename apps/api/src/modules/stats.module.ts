import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEventEntity } from './intents/audit-event.entity';
import { SessionModule } from './session/session.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  imports: [SessionModule, TypeOrmModule.forFeature([AuditEventEntity])],
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
