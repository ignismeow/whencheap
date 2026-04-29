import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { IntentsModule } from './intents/intents.module';
import { AgentModule } from './agent/agent.module';
import { HealthController } from './health.controller';
import { AuditEventEntity } from './intents/audit-event.entity';
import { ExecutionEntity } from './intents/execution.entity';
import { IntentEntity } from './intents/intent.entity';
import { SessionAuthorizationEntity } from './session/session-auth.entity';
import { WhenCheapWallet } from './session/wallet.entity';
import { StatsModule } from './stats.module';
import { UserModule } from './user/user.module';
import { UserEntity } from './user/user.entity';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url:
          config.get<string>('DATABASE_URL') ??
          'postgresql://postgres:postgres@localhost:5432/whencheap',
        entities: [
          UserEntity,
          WhenCheapWallet,
          SessionAuthorizationEntity,
          IntentEntity,
          ExecutionEntity,
          AuditEventEntity,
        ],
        synchronize: true,
        logging: false,
      }),
    }),
    ScheduleModule.forRoot(),
    AgentModule,
    IntentsModule,
    StatsModule,
    UserModule,
  ],
  controllers: [HealthController]
})
export class AppModule {}
