import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OllamaIntentParser } from './ollama-intent-parser.service';

@Module({
  imports: [ConfigModule],
  providers: [OllamaIntentParser],
  exports: [OllamaIntentParser]
})
export class AgentModule {}
