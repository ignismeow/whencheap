import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OllamaIntentParserService } from './ollama-intent-parser.service';

@Module({
  imports: [ConfigModule],
  providers: [OllamaIntentParserService],
  exports: [OllamaIntentParserService]
})
export class AgentModule {}
