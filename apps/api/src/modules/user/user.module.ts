import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEventEntity } from '../intents/audit-event.entity';
import { ExecutionEntity } from '../intents/execution.entity';
import { IntentEntity } from '../intents/intent.entity';
import { SessionAuthorizationEntity } from '../session/session-auth.entity';
import { WhenCheapWallet } from '../session/wallet.entity';
import { UserController } from './user.controller';
import { UserEntity } from './user.entity';
import { UserService } from './user.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      WhenCheapWallet,
      SessionAuthorizationEntity,
      IntentEntity,
      ExecutionEntity,
      AuditEventEntity,
    ]),
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
