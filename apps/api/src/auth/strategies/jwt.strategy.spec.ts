import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { UsersService } from '../../users/users.service';
import { User } from '../../users/entities/user.entity';
import { AUTH_COOKIE, TOKEN_PAYLOAD } from '../auth.constants';
import { TokenRevocationService } from '../token-revocation.service';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  let usersService: jest.Mocked<Partial<UsersService>>;
  let revocations: jest.Mocked<Partial<TokenRevocationService>>;
  let configService: ConfigService;
  let strategy: JwtStrategy;

  const request = () => ({}) as Request;

  beforeEach(() => {
    usersService = { fetchUser: jest.fn() };
    revocations = { isRevoked: jest.fn().mockResolvedValue(false) };
    configService = {
      get: jest.fn().mockReturnValue('jwt-secret'),
    } as unknown as ConfigService;

    strategy = new JwtStrategy(
      usersService as never,
      revocations as unknown as TokenRevocationService,
      configService,
    );
  });

  describe('validate', () => {
    it('resolves the full user for the payload userId', async () => {
      const user = { id: 'user-1' } as User;
      usersService.fetchUser.mockResolvedValue(user);

      await expect(
        strategy.validate(request(), { userId: 'user-1' }),
      ).resolves.toBe(user);
      expect(usersService.fetchUser).toHaveBeenCalledWith({ id: 'user-1' });
    });

    it('propagates a lookup failure rather than swallowing it', async () => {
      usersService.fetchUser.mockRejectedValue(new Error('not found'));

      await expect(
        strategy.validate(request(), { userId: 'ghost' }),
      ).rejects.toThrow('not found');
    });

    it('stashes the payload on the request for the sliding session', async () => {
      // `SlidingSessionInterceptor` needs `iat`/`jti` to decide whether to
      // re-issue, and cannot get them from `request.user` — that is the User
      // entity, not the token.
      const user = { id: 'user-1' } as User;
      usersService.fetchUser.mockResolvedValue(user);
      const req = request();
      const payload = { userId: 'user-1', jti: 'token-1', iat: 1000 };

      await strategy.validate(req, payload);

      expect(req[TOKEN_PAYLOAD]).toBe(payload);
    });

    it('rejects a revoked token without looking the user up', async () => {
      // A signed-out token still carries a valid signature, so passport is
      // happy with it by the time `validate` runs. This is the only thing
      // standing between it and a working session.
      revocations.isRevoked!.mockResolvedValue(true);

      await expect(
        strategy.validate(request(), { userId: 'user-1', jti: 'revoked' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersService.fetchUser).not.toHaveBeenCalled();
    });
  });

  describe('jwtFromRequest extractor', () => {
    /**
     * The constructor hands passport-jwt a single-extractor array built from an
     * inline function. It is only reachable through the `super()` call, so pull
     * it back out of the strategy's own passport configuration to exercise the
     * cookie-then-header fallback directly.
     */
    const extractor = (): ((request: unknown) => string | undefined) => {
      const strategyWithOptions = strategy as unknown as {
        _jwtFromRequest: (request: unknown) => string | undefined;
      };
      return strategyWithOptions._jwtFromRequest;
    };

    it('reads the token from the Authentication cookie first', () => {
      const request = {
        cookies: { [AUTH_COOKIE]: 'from-cookie' },
        headers: { authentication: 'from-header' },
      };

      expect(extractor()(request)).toBe('from-cookie');
    });

    it('falls back to the authentication header when there is no cookie', () => {
      const request = {
        cookies: {},
        headers: { authentication: 'from-header' },
      };

      expect(extractor()(request)).toBe('from-header');
    });

    it('returns a falsy value when neither is present', () => {
      const request = { cookies: {}, headers: {} };

      expect(extractor()(request)).toBeFalsy();
    });
  });
});
