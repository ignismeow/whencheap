import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getHealth() {
    const zeroGConfigured = Boolean(this.config.get<string>('ZG_BEARER_TOKEN'));
    const ollamaConfigured = Boolean(this.config.get<string>('OLLAMA_BASE_URL'));

    return {
      ok: true,
      service: 'whencheap-api',
      network: this.config.get<string>('NETWORK') ?? 'sepolia',
      ai: {
        provider: zeroGConfigured ? '0g' : 'ollama',
        model: zeroGConfigured
          ? (this.config.get<string>('ZG_MODEL') ?? 'auto')
          : (this.config.get<string>('OLLAMA_MODEL') ?? 'llama3.1:8b'),
        configured: zeroGConfigured || ollamaConfigured
      }
    };
  }
}
