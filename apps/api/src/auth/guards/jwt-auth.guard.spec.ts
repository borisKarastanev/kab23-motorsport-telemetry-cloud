import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  it('is defined', () => {
    expect(new JwtAuthGuard()).toBeDefined();
  });

  it('extends the passport AuthGuard for the jwt strategy', () => {
    // The one-liner is entirely declarative — `AuthGuard('jwt')` is what wires
    // this to the JwtStrategy registered under that name. Asserting the
    // prototype chain is what would actually catch a typo'd strategy name.
    expect(JwtAuthGuard.prototype).toBeInstanceOf(AuthGuard('jwt'));
  });
});
