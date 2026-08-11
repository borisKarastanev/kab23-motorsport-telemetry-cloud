import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { AUTH_COOKIE } from './auth.constants';

const user = { id: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924' } as User;

describe('AuthService cookie attributes', () => {
  const serviceFor = (nodeEnv: string) => {
    const cookie = jest.fn();
    const config = {
      get: (key: string) => ({ NODE_ENV: nodeEnv, JWT_EXPIRATION: 3600 })[key],
    } as unknown as ConfigService;

    const service = new AuthService(
      config,
      { sign: () => 'a.jwt.token' } as unknown as JwtService,
      {} as UsersService,
    );

    return { service, cookie, response: { cookie } as unknown as Response };
  };

  const attributesOf = (cookie: jest.Mock, call = 0) =>
    cookie.mock.calls[call][2];

  it('sets an httpOnly, Secure, SameSite=Lax cookie in production', () => {
    const { service, cookie, response } = serviceFor('production');

    service.login(user, response);

    expect(cookie).toHaveBeenCalledWith(
      AUTH_COOKIE,
      'a.jwt.token',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    );
  });

  /**
   * `ng serve` is plain http://localhost:4200, and a browser drops a `Secure`
   * cookie sent over http — so forcing it on everywhere would break local login
   * entirely.
   */
  it('drops Secure in development so the dev server can log in', () => {
    const { service, cookie, response } = serviceFor('development');

    service.login(user, response);

    expect(attributesOf(cookie)).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
    });
  });

  /**
   * The regression this guards: a clear-cookie whose attributes do not match the
   * original can leave the real cookie in place, so `logout` returns 200 and the
   * viewer stays signed in.
   */
  it('clears the cookie with exactly the attributes it was set with', () => {
    const { service, cookie, response } = serviceFor('production');

    service.login(user, response);
    service.logout(response);

    const [set, cleared] = [attributesOf(cookie, 0), attributesOf(cookie, 1)];

    expect(cleared.httpOnly).toBe(set.httpOnly);
    expect(cleared.secure).toBe(set.secure);
    expect(cleared.sameSite).toBe(set.sameSite);
    expect(cookie.mock.calls[1][1]).toBe('');
    expect(cleared.expires.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('AuthService.userFromToken', () => {
  /**
   * For callers outside the request cycle — the live WebSocket handshake —
   * where passport's guards never run, so nothing else has verified the token.
   */
  it('resolves the user a verified token belongs to, with its expiry', async () => {
    const jwtService = {
      verifyAsync: jest
        .fn()
        .mockResolvedValue({ userId: user.id, exp: 1_800_000_000 }),
    } as unknown as JwtService;
    const usersService = {
      fetchUser: jest.fn().mockResolvedValue(user),
    } as unknown as UsersService;
    const service = new AuthService(
      {} as ConfigService,
      jwtService,
      usersService,
    );

    await expect(service.userFromToken('a.jwt.token')).resolves.toEqual({
      user,
      exp: 1_800_000_000,
    });
    expect(usersService.fetchUser).toHaveBeenCalledWith({ id: user.id });
  });

  it('propagates rejection for a bad, expired or unknown token', async () => {
    // The caller decides what to say about it — and says the same thing for
    // all three, so this must not swallow or reshape the error.
    const jwtService = {
      verifyAsync: jest.fn().mockRejectedValue(new Error('jwt expired')),
    } as unknown as JwtService;
    const service = new AuthService(
      {} as ConfigService,
      jwtService,
      {} as UsersService,
    );

    await expect(service.userFromToken('stale.jwt.token')).rejects.toThrow(
      'jwt expired',
    );
  });
});
