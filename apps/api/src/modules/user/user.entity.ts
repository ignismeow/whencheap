import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { IntentEntity } from '../intents/intent.entity';
import { SessionAuthorizationEntity } from '../session/session-auth.entity';

export enum UserIdentifierType {
  Google = 'google',
  Email = 'email',
  Wallet = 'wallet',
}

@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 255 })
  identifier!: string;

  @Column({
    type: 'enum',
    enum: UserIdentifierType,
  })
  identifierType!: UserIdentifierType;

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt!: Date;

  @OneToMany(() => SessionAuthorizationEntity, (session) => session.user)
  sessionAuthorizations?: SessionAuthorizationEntity[];

  @OneToMany(() => IntentEntity, (intent) => intent.user)
  intents?: IntentEntity[];
}
