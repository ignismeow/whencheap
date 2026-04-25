import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateIntentDto } from './dto/create-intent.dto';
import { IntentsService } from './intents.service';

@Controller('intents')
export class IntentsController {
  constructor(private readonly intents: IntentsService) {}

  @Post()
  create(@Body() dto: CreateIntentDto) {
    return this.intents.create(dto);
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
