import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { IntentEntity } from './intent.entity';

@Entity('audit_events')
export class AuditEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  intentId!: string;

  @ManyToOne(() => IntentEntity, (intent) => intent.auditEvents, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'intentId' })
  intent?: IntentEntity;

  @Column({ type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;
}
