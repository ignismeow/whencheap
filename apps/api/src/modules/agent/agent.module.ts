import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GeminiIntentParser } from './gemini-intent-parser.service';

@Module({
  imports: [ConfigModule],
  providers: [GeminiIntentParser],
  exports: [GeminiIntentParser]
})
export class AgentModule {}
