import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '@app/common';

/** Namespaced so a `KEYS`/`SCAN` over the live-path keys never collides. */
const KEY_PREFIX = 'auth:revoked:';

/**
 * Tokens that have been signed but must no longer be accepted.
 *
 * **Why this exists at all:** a JWT is valid until it expires, and `logout`
 * can only delete the browser's copy of the cookie. Anything that captured
 * that cookie first — a shared pit-wall laptop, a proxy log, a backup of a
 * browser profile — kept a working credential for the rest of the token's
 * life, and the sliding session made that life longer. Signing out has to
 * actually invalidate the token, not just forget it locally.
 *
 * **Keyed by `jti`, not by user.** Revoking every token a person holds would
 * make signing out of the pit-wall laptop also sign them out of the phone in
 * their pocket. One entry per token keeps logout meaning "this session".
 *
 * **The entry expires with the token.** There is no point remembering that a
 * token is revoked past the moment it would have been rejected as expired
 * anyway, and a denylist that only ever grows is a slow memory leak in a
 * process that is meant to hold a cache.
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Reject this token from now until `exp`.
   *
   * A token with no `jti` predates this feature; there is nothing to key on,
   * so it simply keeps its natural expiry. Same for one already past `exp`.
   */
  async revoke(
    jti: string | undefined,
    exp: number | undefined,
  ): Promise<void> {
    if (!jti) {
      return;
    }

    const ttlSeconds = exp ? exp - Math.floor(Date.now() / 1000) : 0;
    if (ttlSeconds <= 0) {
      return;
    }

    try {
      await this.redis.set(`${KEY_PREFIX}${jti}`, '1', 'EX', ttlSeconds);
    } catch (error) {
      // Logged, not thrown: a failed logout that still clears the cookie is
      // better than a 500 that leaves the user looking at an error page with
      // their session apparently intact. See `isRevoked` for the other half
      // of this trade.
      this.logger.warn(
        `Could not record token revocation: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Whether this token has been revoked.
   *
   * **Fails open**, and that is a real decision rather than an oversight.
   * Redis in this system is "a cache and a bus, never a system of record"
   * (see `LivePublisherService`), and it is not replicated. Failing closed
   * would turn a Redis restart into every authenticated request 401ing —
   * signing out every driver and blanking every pit wall — to guard against
   * the narrow window in which a *deliberately signed-out* token is replayed
   * during that same outage. The token's own expiry still bounds the damage.
   */
  async isRevoked(jti: string | undefined): Promise<boolean> {
    if (!jti) {
      return false;
    }

    try {
      return (await this.redis.exists(`${KEY_PREFIX}${jti}`)) === 1;
    } catch (error) {
      this.logger.warn(
        `Could not check token revocation, allowing: ${(error as Error).message}`,
      );
      return false;
    }
  }
}
