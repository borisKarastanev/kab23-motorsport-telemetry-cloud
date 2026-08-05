import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { AUTH_COOKIE } from './auth.constants';
import { TokenPayload } from './interfaces/token-payload.interface';

@Injectable()
export class AuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
  ) {}

  login(user: User, response: Response): User {
    const tokenPayload: TokenPayload = { userId: user.id };

    const expires = new Date();
    expires.setSeconds(
      expires.getSeconds() + this.configService.get<number>('JWT_EXPIRATION'),
    );

    const token = this.jwtService.sign(tokenPayload);

    response.cookie(AUTH_COOKIE, token, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      expires,
    });

    return user;
  }

  logout(response: Response): void {
    response.cookie(AUTH_COOKIE, '', {
      httpOnly: true,
      expires: new Date(),
    });
  }

  /**
   * Verifies a raw token and resolves who it belongs to.
   *
   * For callers outside the request cycle — the live WebSocket handshake — where
   * passport and its guards do not run. `JwtStrategy` stays as it is rather than
   * routing through here: passport has already verified the signature by the
   * time `validate` is reached, and calling this would verify it twice.
   *
   * Throws on a bad, expired or unknown token; the caller decides what to say
   * about that, and says the same thing for all three.
   */
  async userFromToken(token: string): Promise<{ user: User; exp?: number }> {
    const payload = await this.jwtService.verifyAsync<TokenPayload>(token);

    return {
      user: await this.usersService.fetchUser({ id: payload.userId }),
      exp: payload.exp,
    };
  }
}
