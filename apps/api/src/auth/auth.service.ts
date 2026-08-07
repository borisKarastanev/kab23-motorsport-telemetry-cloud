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
      ...this.cookieAttributes(),
      expires,
    });

    return user;
  }

  logout(response: Response): void {
    response.cookie(AUTH_COOKIE, '', {
      // Same attributes as `login`, not just `httpOnly`. A browser treats
      // (name, domain, path) as the cookie's identity but will refuse to
      // overwrite a `Secure` cookie from a mismatched context, so a clear-cookie
      // that drops `secure`/`sameSite` can silently leave the original in place
      // and log nobody out.
      ...this.cookieAttributes(),
      expires: new Date(),
    });
  }

  /**
   * The attributes every `Authentication` cookie carries, set and cleared.
   *
   * `secure` is driven by `NODE_ENV`, which is validated to a closed set in
   * `config.schema.ts` — a typo there used to mean the cookie quietly shipped
   * without `Secure` over a public endpoint.
   *
   * `sameSite: 'lax'` rather than `'strict'`: the app is served from the same
   * origin as the API in production, so `lax` costs nothing there and still
   * blocks the cross-site POST that CSRF needs — while `strict` would drop the
   * cookie on a plain link into the app from anywhere else, logging the viewer
   * out for no security gain.
   */
  private cookieAttributes() {
    return {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      sameSite: 'lax' as const,
    };
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
