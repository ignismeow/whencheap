import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SessionSignerService } from './session-signer.service';

@Module({
  imports: [ConfigModule],
  providers: [SessionSignerService],
  exports: [SessionSignerService]
})
export class SessionModule {}
