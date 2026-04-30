import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OllamaIntentParserService } from './ollama-intent-parser.service';
import { ZgInferenceService } from '../intents/zg-inference.service';

@Module({
  imports: [ConfigModule],
  providers: [OllamaIntentParserService, ZgInferenceService],
  exports: [OllamaIntentParserService, ZgInferenceService]
})
export class AgentModule {}
