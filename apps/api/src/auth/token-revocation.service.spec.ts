import Redis from 'ioredis';
import { TokenRevocationService } from './token-revocation.service';

describe('TokenRevocationService', () => {
  let redis: jest.Mocked<Pick<Redis, 'set' | 'exists'>>;
  let service: TokenRevocationService;

  /** 2033-ish, comfortably in the future whatever the clock says. */
  const FUTURE_EXP = Math.floor(Date.now() / 1000) + 600;

  beforeEach(() => {
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      exists: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<Pick<Redis, 'set' | 'exists'>>;

    service = new TokenRevocationService(redis as unknown as Redis);
  });

  describe('revoke', () => {
    it('stores the token id with a TTL matching what was left of its life', async () => {
      // The entry must not outlive the token: a denylist that only grows is a
      // leak in a process that is meant to be holding a cache.
      await service.revoke('token-1', FUTURE_EXP);

      const [key, value, mode, ttl] = redis.set.mock.calls[0];
      expect(key).toContain('token-1');
      expect(value).toBe('1');
      expect(mode).toBe('EX');
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(600);
    });

    it('does nothing for a token that carries no id', async () => {
      // Minted before `jti` existed. There is nothing to key on, so it keeps
      // its natural expiry rather than being silently un-revocable *and*
      // costing a Redis round trip.
      await service.revoke(undefined, FUTURE_EXP);

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('does nothing for a token that has already expired', async () => {
      await service.revoke('token-1', Math.floor(Date.now() / 1000) - 1);

      expect(redis.set).not.toHaveBeenCalled();
    });

    it('does not throw when Redis is unreachable', async () => {
      // A logout that fails to record the revocation must still clear the
      // cookie rather than 500 — the user is left looking at an error page
      // with their session apparently intact otherwise.
      redis.set.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.revoke('token-1', FUTURE_EXP),
      ).resolves.toBeUndefined();
    });
  });

  describe('isRevoked', () => {
    it('is true once the id is present', async () => {
      redis.exists.mockResolvedValue(1);

      await expect(service.isRevoked('token-1')).resolves.toBe(true);
    });

    it('is false for an id that was never revoked', async () => {
      await expect(service.isRevoked('token-1')).resolves.toBe(false);
    });

    it('is false for a token with no id, without asking Redis', async () => {
      await expect(service.isRevoked(undefined)).resolves.toBe(false);
      expect(redis.exists).not.toHaveBeenCalled();
    });

    it('fails open when Redis is unreachable', async () => {
      // Deliberate, and the reasoning is in the service: failing closed turns
      // a Redis restart into every request 401ing — signing out every driver
      // and blanking every pit wall — to guard a narrow replay window that
      // the token's own expiry already bounds.
      redis.exists.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(service.isRevoked('token-1')).resolves.toBe(false);
    });
  });
});
