import { AbstractEntity } from '@app/common/database/abstract.entity';
import { UserRole } from '@app/common';
import { Exclude } from 'class-transformer';
import { Column, Entity } from 'typeorm';

@Entity()
export class User extends AbstractEntity<User> {
  @Column({ unique: true })
  email: string;

  @Exclude()
  @Column()
  password: string;

  @Column({ nullable: true })
  displayName?: string;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.DRIVER })
  role: UserRole;
}
