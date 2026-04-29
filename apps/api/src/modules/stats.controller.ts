import { Controller, Get } from '@nestjs/common';
import { StatsService } from './stats.service';

@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('treasury')
  getTreasuryStats() {
    return this.stats.getTreasuryStats();
  }
}
