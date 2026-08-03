import { AbstractRepository } from '@app/common';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UsersRepository extends AbstractRepository<User> {
  protected readonly logger: Logger = new Logger(UsersRepository.name);

  constructor(
    @InjectRepository(User)
    usersRepository: Repository<User>,
    entityManager: EntityManager,
  ) {
    super(usersRepository, entityManager);
  }

  async createUser(createUserDto: CreateUserDto): Promise<User> {
    const { email, password, displayName, role } = createUserDto;
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = new User({
      // Normalized on the way in so the unique index is a real one-account-per-
      // address rule, and so team invites match the address as typed.
      email: email.toLowerCase(),
      password: hashedPassword,
      displayName,
      role,
    });

    // Deliberately does not echo the address back — a message naming the email
    // turns registration into an account-enumeration oracle.
    return this.createOrConflict(user, 'Registration failed');
  }

  async validateUser(email: string, password: string): Promise<User> {
    // Unknown email and wrong password must be indistinguishable to the caller,
    // so the repository's NotFoundException never escapes as a 404.
    let user: User;
    try {
      user = await this.findOne({ email: email.toLowerCase() });
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordIsValid = await bcrypt.compare(password, user.password);

    if (!passwordIsValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return user;
  }
}
