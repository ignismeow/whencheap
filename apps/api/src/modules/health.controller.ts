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
        provider: 'gemini',
        model: this.config.get<string>('GEMINI_MODEL') ?? 'gemini-2.5-flash',
        configured: Boolean(this.config.get<string>('GEMINI_API_KEY'))
      }
    };
  }
}
