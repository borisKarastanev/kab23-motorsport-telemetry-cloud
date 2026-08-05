export interface TokenPayload {
  userId: string;
  /**
   * Expiry, epoch seconds. Stamped by `JwtModule`'s `expiresIn` rather than by
   * `login`, so it is optional on the way out and present on the way back in.
   */
  exp?: number;
}
