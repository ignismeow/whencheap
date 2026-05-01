import { Controller, Get, Query } from '@nestjs/common';
import { GasService } from './gas.service';

@Controller('gas')
export class GasController {
  constructor(private readonly gasService: GasService) {}

  @Get('current')
  getCurrent(@Query('chain') chain = 'sepolia') {
    return this.gasService.getCurrentGas(chain);
  }

  @Get('costs')
  getCosts(@Query('chain') chain = 'sepolia') {
    return this.gasService.getGasCosts(chain);
  }

  @Get('suggestion')
  getSuggestion(
    @Query('type') type: 'send' | 'swap' = 'swap',
    @Query('deadline') deadline?: string,
    @Query('chain') chain = 'sepolia',
  ) {
    return this.gasService.getGasSuggestion(type, deadline ? parseInt(deadline, 10) : null, chain);
  }

  @Get('analytics')
  getAnalytics(@Query('chain') chain = 'sepolia') {
    return this.gasService.getAnalytics(chain);
  }

  @Get('history')
  getHistory(@Query('chain') chain = 'sepolia') {
    return this.gasService.getHistory(chain);
  }
}
