import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { User } from '../../users/entities/user.entity';
import { AUTH_COOKIE } from '../auth.constants';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  let usersService: jest.Mocked<Partial<UsersService>>;
  let configService: ConfigService;
  let strategy: JwtStrategy;

  beforeEach(() => {
    usersService = { fetchUser: jest.fn() };
    configService = {
      get: jest.fn().mockReturnValue('jwt-secret'),
    } as unknown as ConfigService;

    strategy = new JwtStrategy(usersService as never, configService);
  });

  describe('validate', () => {
    it('resolves the full user for the payload userId', async () => {
      const user = { id: 'user-1' } as User;
      usersService.fetchUser.mockResolvedValue(user);

      await expect(
        strategy.validate({ userId: 'user-1' }),
      ).resolves.toBe(user);
      expect(usersService.fetchUser).toHaveBeenCalledWith({ id: 'user-1' });
    });

    it('propagates a lookup failure rather than swallowing it', async () => {
      usersService.fetchUser.mockRejectedValue(new Error('not found'));

      await expect(
        strategy.validate({ userId: 'ghost' }),
      ).rejects.toThrow('not found');
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
