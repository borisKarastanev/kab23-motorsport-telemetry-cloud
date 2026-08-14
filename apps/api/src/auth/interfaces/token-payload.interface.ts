export interface TokenPayload {
  userId: string;
  /**
   * Token id, stamped by `AuthService.login`. What `TokenRevocationService`
   * denylists — revocation has to name a *token*, not a user, or logging out
   * of one browser would sign the same person out everywhere.
   */
  jti?: string;
  /**
   * Issued-at, epoch seconds. Stamped by `jsonwebtoken` itself. The sliding
   * session reads it to decide whether this token is old enough to be worth
   * re-issuing; see `SlidingSessionInterceptor`.
   */
  iat?: number;
  /**
   * Expiry, epoch seconds. Stamped by `JwtModule`'s `expiresIn` rather than by
   * `login`, so it is optional on the way out and present on the way back in.
   */
  exp?: number;
}
