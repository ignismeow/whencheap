import { Controller, Delete, Get, Param, Query } from '@nestjs/common';
import { UserService } from './user.service';

@Controller('users')
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get(':identifier/sessions')
  getSessions(@Param('identifier') identifier: string) {
    return this.users.getSessions(identifier);
  }

  @Delete(':identifier/sessions/:id')
  revokeSession(@Param('identifier') identifier: string, @Param('id') id: string) {
    return this.users.revokeSession(identifier, id);
  }

  @Get(':identifier/intents')
  getIntentHistory(
    @Param('identifier') identifier: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.users.getIntentHistory(
      identifier,
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
      status,
    );
  }

  @Get(':identifier/stats')
  getStats(@Param('identifier') identifier: string) {
    return this.users.getStats(identifier);
  }
}
