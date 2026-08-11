import { AuthGuard } from '@nestjs/passport';
import { LocalAuthGuard } from './local-auth.guard';

describe('LocalAuthGuard', () => {
  it('is defined', () => {
    expect(new LocalAuthGuard()).toBeDefined();
  });

  it('extends the passport AuthGuard for the local strategy', () => {
    expect(LocalAuthGuard.prototype).toBeInstanceOf(AuthGuard('local'));
  });
});
