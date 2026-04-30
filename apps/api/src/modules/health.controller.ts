import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getHealth() {
    const zeroGConfigured = Boolean(this.config.get<string>('ZG_API_KEY'));
    const groqConfigured = Boolean(this.config.get<string>('GROQ_API_KEY'));

    return {
      ok: true,
      service: 'whencheap-api',
      network: this.config.get<string>('NETWORK') ?? 'sepolia',
      ai: {
        provider: zeroGConfigured ? '0g' : 'groq',
        model: zeroGConfigured
          ? (this.config.get<string>('ZG_MODEL') ?? 'auto')
          : 'llama-3.3-70b-versatile',
        configured: zeroGConfigured || groqConfigured
      }
    };
  }
}
