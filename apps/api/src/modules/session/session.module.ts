import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionSignerService } from './session-signer.service';
import { SessionAuthorizationEntity } from './session-auth.entity';
import { UserEntity } from '../user/user.entity';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([UserEntity, SessionAuthorizationEntity])],
  providers: [SessionSignerService],
  exports: [SessionSignerService]
})
export class SessionModule {}
