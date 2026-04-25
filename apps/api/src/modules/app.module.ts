import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { IntentsModule } from './intents/intents.module';
import { AgentModule } from './agent/agent.module';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    AgentModule,
    IntentsModule
  ],
  controllers: [HealthController]
})
export class AppModule {}
