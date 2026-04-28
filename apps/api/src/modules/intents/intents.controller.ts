import { BadRequestException, Body, Controller, Get, Logger, Param, Post, Query } from '@nestjs/common';
import { CreateIntentDto } from './dto/create-intent.dto';
import { GoogleAuthDto } from './dto/google-auth.dto';
import { ManagedSessionDto } from './dto/managed-session.dto';
import { RegisterWalletDto } from './dto/register-wallet.dto';
import { TestEip7702Dto } from './dto/test-eip7702.dto';
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
  async storeSession(@Body() body: { userAddress: string; authorization: unknown }) {
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
    await this.intents.storeAuthorization(body.userAddress, body.authorization);
    return { ok: true };
  }

  @Post('wallet')
  async registerWallet(@Body() dto: RegisterWalletDto) {
    this.logger.log(`POST /intents/wallet received for ${dto.userAddress}`);
    return await this.intents.registerWallet(dto);
  }

  @Post('google-auth')
  async authenticateWithGoogle(@Body() dto: GoogleAuthDto) {
    this.logger.log('POST /intents/google-auth received');
    return await this.intents.authenticateWithGoogle(dto);
  }

  @Post('wallet/authorize')
  authorizeManagedWalletSession(@Body() dto: ManagedSessionDto) {
    this.logger.log(`POST /intents/wallet/authorize received for ${dto.userAddress}`);
    return this.intents.authorizeManagedWalletSession(dto);
  }

  @Post('wallet/revoke')
  revokeManagedWalletSession(@Body() body: { userAddress: string }) {
    this.logger.log(`POST /intents/wallet/revoke received for ${body.userAddress}`);
    return this.intents.revokeManagedWalletSession(body.userAddress);
  }

  @Post('test-eip7702')
  testEip7702(@Body() dto: TestEip7702Dto) {
    this.logger.warn('TEST ENDPOINT — do not expose in production');
    return this.intents.testEip7702(dto);
  }

  @Get()
  async list() {
    return await this.intents.list();
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return await this.intents.get(id);
  }

  @Get('resolve-name/lookup')
  async resolveName(@Query('name') name?: string) {
    if (!name) {
      throw new BadRequestException('Query parameter "name" is required');
    }

    const address = await this.intents.resolveRecipientName(name);
    return { name, address };
  }
}
