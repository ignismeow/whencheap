import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserEntity } from '../user/user.entity';
import { ExecutionEntity } from './execution.entity';
import { AuditEventEntity } from './audit-event.entity';

@Entity('intents')
export class IntentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => UserEntity, (user) => user.intents, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity | null;

  @Column({ type: 'varchar', length: 64 })
  walletAddress!: string;

  @Column({ type: 'text' })
  rawInput!: string;

  @Column({ type: 'varchar', length: 64 })
  status!: string;

  @Column({ type: 'jsonb' })
  parsed!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 128, nullable: true })
  txHash!: string | null;

  @Column({ type: 'integer', nullable: true })
  blockNumber!: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  inferenceProvider!: string | null;

  @Column({ type: 'integer', default: 1 })
  repeatCount!: number;

  @Column({ type: 'integer', default: 0 })
  repeatCompleted!: number;

  @Column({ type: 'timestamp with time zone', nullable: true })
  deadline!: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;

  @OneToMany(() => ExecutionEntity, (execution) => execution.intent)
  executions?: ExecutionEntity[];

  @OneToMany(() => AuditEventEntity, (event) => event.intent)
  auditEvents?: AuditEventEntity[];
}
