import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExecutionEntity } from '../intents/execution.entity';
import { IntentEntity } from '../intents/intent.entity';
import { SessionAuthorizationEntity } from '../session/session-auth.entity';
import { WhenCheapWallet } from '../session/wallet.entity';
import { UserEntity } from './user.entity';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(WhenCheapWallet)
    private readonly walletRepository: Repository<WhenCheapWallet>,
    @InjectRepository(SessionAuthorizationEntity)
    private readonly sessionRepository: Repository<SessionAuthorizationEntity>,
    @InjectRepository(IntentEntity)
    private readonly intentRepository: Repository<IntentEntity>,
    @InjectRepository(ExecutionEntity)
    private readonly executionRepository: Repository<ExecutionEntity>,
  ) {}

  async getSessions(identifier: string) {
    const user = await this.resolveUser(identifier);
    const sessions = await this.sessionRepository.find({
      where: { userId: user.id },
      order: { createdAt: 'DESC' },
    });

    return sessions.map((session) => ({
      id: session.id,
      walletAddress: session.walletAddress,
      isActive: session.isActive,
      expiresAt: session.expiresAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
    }));
  }

  async revokeSession(identifier: string, sessionId: string) {
    const user = await this.resolveUser(identifier);
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId, userId: user.id },
    });

    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found for ${identifier}`);
    }

    session.isActive = false;
    await this.sessionRepository.save(session);
    return { ok: true };
  }

  async getIntentHistory(
    identifier: string,
    page = 1,
    limit = 20,
    status?: string,
  ) {
    const user = await this.resolveUser(identifier);
    const safePage = Math.max(page, 1);
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    const qb = this.intentRepository
      .createQueryBuilder('intent')
      .leftJoinAndSelect('intent.executions', 'execution')
      .where('intent.userId = :userId', { userId: user.id })
      .orderBy('intent.createdAt', 'DESC')
      .addOrderBy('execution.createdAt', 'ASC')
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit);

    if (status) {
      qb.andWhere('intent.status = :status', { status });
    }

    const [items, total] = await qb.getManyAndCount();
    return {
      page: safePage,
      limit: safeLimit,
      total,
      items: items.map((intent) => ({
        id: intent.id,
        walletAddress: intent.walletAddress,
        rawInput: intent.rawInput,
        status: intent.status,
        parsed: intent.parsed,
        txHash: intent.txHash,
        blockNumber: intent.blockNumber,
        inferenceProvider: intent.inferenceProvider,
        repeatCount: intent.repeatCount,
        repeatCompleted: intent.repeatCompleted,
        deadline: intent.deadline?.toISOString() ?? null,
        createdAt: intent.createdAt.toISOString(),
        updatedAt: intent.updatedAt.toISOString(),
        executions: (intent.executions ?? []).map((execution) => ({
          id: execution.id,
          executionNumber: execution.executionNumber,
          txHash: execution.txHash,
          blockNumber: execution.blockNumber,
          status: execution.status,
          gasPaidWei: execution.gasPaidWei,
          confirmedAt: execution.confirmedAt?.toISOString() ?? null,
          createdAt: execution.createdAt.toISOString(),
        })),
      })),
    };
  }

  async getStats(identifier: string) {
    const user = await this.resolveUser(identifier);
    const totalIntents = await this.intentRepository.count({
      where: { userId: user.id },
    });
    const successfulIntents = await this.intentRepository.count({
      where: { userId: user.id, status: 'FINALIZED' },
    });
    const activeSessions = await this.sessionRepository.count({
      where: { userId: user.id, isActive: true },
    });

    const gasRows = await this.executionRepository
      .createQueryBuilder('execution')
      .innerJoin('execution.intent', 'intent')
      .select('execution.gasPaidWei', 'gasPaidWei')
      .where('intent.userId = :userId', { userId: user.id })
      .getRawMany<{ gasPaidWei: string }>();

    const totalEthSent = gasRows.reduce(
      (sum, row) => sum + BigInt(row.gasPaidWei || '0'),
      0n,
    );

    return {
      totalIntents,
      successfulIntents,
      totalEthSent: totalEthSent.toString(),
      activeSessions,
    };
  }

  private async resolveUser(identifier: string): Promise<UserEntity> {
    const normalized = identifier.trim();
    const user =
      (await this.userRepository.findOne({ where: { identifier: normalized } })) ??
      (await this.walletRepository
        .createQueryBuilder('wallet')
        .leftJoinAndSelect('wallet.user', 'user')
        .where('LOWER(wallet.walletAddress) = LOWER(:identifier)', { identifier: normalized })
        .getOne()
        .then((wallet) => wallet?.user ?? null));

    if (!user) {
      throw new NotFoundException(`User ${identifier} not found`);
    }

    return user;
  }
}
