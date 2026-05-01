import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('gas_snapshots')
@Index(['chain', 'capturedAt'])
export class GasSnapshotEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ length: 20 })
  chain!: string;

  @Column({ type: 'decimal', precision: 30, scale: 12 })
  baseFeeGwei!: number;

  @Column({ type: 'decimal', precision: 30, scale: 12 })
  priorityFeeGwei!: number;

  @Column({ type: 'decimal', precision: 30, scale: 12 })
  safeLowGwei!: number;

  @Column({ type: 'decimal', precision: 30, scale: 12 })
  standardGwei!: number;

  @Column({ type: 'decimal', precision: 30, scale: 12 })
  fastGwei!: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  ethPriceUsd!: number;

  @CreateDateColumn()
  capturedAt!: Date;
}
