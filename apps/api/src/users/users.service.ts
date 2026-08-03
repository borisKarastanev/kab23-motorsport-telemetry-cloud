import { Injectable } from '@nestjs/common';
import { UsersRepository } from './users.repository';
import { CreateUserDto } from './dto/create-user.dto';
import { GetUserDto } from './dto/get-user.dto';
import { User } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  async create(createUserDto: CreateUserDto): Promise<User> {
    return this.usersRepository.createUser(createUserDto);
  }

  async verifyUser(email: string, password: string): Promise<User> {
    return this.usersRepository.validateUser(email, password);
  }

  async fetchUser(getUserDto: GetUserDto): Promise<User> {
    return this.usersRepository.findOne({ id: getUserDto.id });
  }
}
