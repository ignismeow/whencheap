import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { GasModule } from '../gas/gas.module';
import { KeeperHubModule } from '../keeperhub/keeperhub.module';
import { SessionModule } from '../session/session.module';
import { IntentsController } from './intents.controller';
import { IntentsService } from './intents.service';

@Module({
  imports: [AgentModule, GasModule, KeeperHubModule, SessionModule],
  controllers: [IntentsController],
  providers: [IntentsService],
  exports: [IntentsService]
})
export class IntentsModule {}
