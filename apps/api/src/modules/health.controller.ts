import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getHealth() {
    return {
      ok: true,
      service: 'whencheap-api',
      network: this.config.get<string>('NETWORK') ?? 'sepolia',
      ai: {
        provider: 'ollama',
        baseUrl: this.config.get<string>('OLLAMA_BASE_URL') ?? 'http://localhost:11434',
        model: this.config.get<string>('OLLAMA_MODEL') ?? 'llama3.1'
      }
    };
  }
}
