import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { UserEntity } from '../user/user.entity';

@Entity('whencheap_wallets')
export class WhenCheapWallet {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => UserEntity, (user) => user.wallets, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity | null;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  walletAddress!: string;

  @Column({ type: 'text' })
  encryptedPrivateKey!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  iv!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  authTag!: string | null;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;
}
