import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentModule } from '../agent/agent.module';
import { GasModule } from '../gas/gas.module';
import { KeeperHubModule } from '../keeperhub/keeperhub.module';
import { SessionModule } from '../session/session.module';
import { AuditEventEntity } from './audit-event.entity';
import { ExecutionEntity } from './execution.entity';
import { IntentEntity } from './intent.entity';
import { IntentsController } from './intents.controller';
import { IntentsService } from './intents.service';
import { UserEntity } from '../user/user.entity';
import { WhenCheapWallet } from '../session/wallet.entity';

@Module({
  imports: [
    AgentModule,
    GasModule,
    KeeperHubModule,
    SessionModule,
    TypeOrmModule.forFeature([
      UserEntity,
      WhenCheapWallet,
      IntentEntity,
      ExecutionEntity,
      AuditEventEntity,
    ]),
  ],
  controllers: [IntentsController],
  providers: [IntentsService],
  exports: [IntentsService]
})
export class IntentsModule {}
