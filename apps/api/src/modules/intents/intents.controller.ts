import { Body, Controller, Get, Logger, Param, Post } from '@nestjs/common';
import { CreateIntentDto } from './dto/create-intent.dto';
import { IntentsService } from './intents.service';

@Controller('intents')
export class IntentsController {
  private readonly logger = new Logger(IntentsController.name);

  constructor(private readonly intents: IntentsService) {}

  @Post()
  create(@Body() dto: CreateIntentDto) {
    return this.intents.create(dto);
  }

  @Post('session')
  storeSession(@Body() body: { userAddress: string; authorization: unknown }) {
    const authorization =
      body.authorization && typeof body.authorization === 'object'
        ? body.authorization as Record<string, unknown>
        : null;

    this.logger.log(
      `POST /intents/session received. ` +
      `User: ${body.userAddress}. ` +
      `Auth present: ${!!body.authorization}. ` +
      `Auth keys: ${authorization ? Object.keys(authorization).join(', ') : 'none'}`
    );
    this.intents.storeAuthorization(body.userAddress, body.authorization);
    return { ok: true };
  }

  @Get()
  list() {
    return this.intents.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.intents.get(id);
  }
}
