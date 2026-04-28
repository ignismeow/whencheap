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

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => UserEntity, (user) => user.wallets, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  walletAddress!: string;

  @Column({ type: 'text' })
  encryptedPrivateKey!: string;

  @Column({ type: 'varchar', length: 64 })
  iv!: string;

  @Column({ type: 'varchar', length: 64 })
  authTag!: string;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;
}
