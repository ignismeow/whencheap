import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { IntentEntity } from './intent.entity';

@Entity('executions')
export class ExecutionEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  intentId!: string;

  @ManyToOne(() => IntentEntity, (intent) => intent.executions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'intentId' })
  intent?: IntentEntity;

  @Column({ type: 'integer' })
  executionNumber!: number;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 128 })
  txHash!: string;

  @Column({ type: 'integer', nullable: true })
  blockNumber!: number | null;

  @Column({ type: 'varchar', length: 64 })
  status!: string;

  @Column({ type: 'varchar', length: 128 })
  gasPaidWei!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  confirmedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;
}
