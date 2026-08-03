import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-local';
import { UsersService } from '../../users/users.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly usersService: UsersService) {
    super({ usernameField: 'email' });
  }

  async validate(email: string, password: string) {
    try {
      return await this.usersService.verifyUser(email, password);
    } catch {
      // Never forward the caught error: passing it to the exception puts the
      // internal message in the response body and leaks whether the account
      // exists. The client always gets the same opaque failure.
      throw new UnauthorizedException('Invalid credentials');
    }
  }
}
