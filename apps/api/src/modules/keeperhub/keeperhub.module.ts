import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KeeperHubService } from './keeperhub.service';

@Module({
  imports: [ConfigModule],
  providers: [KeeperHubService],
  exports: [KeeperHubService]
})
export class KeeperHubModule {}
