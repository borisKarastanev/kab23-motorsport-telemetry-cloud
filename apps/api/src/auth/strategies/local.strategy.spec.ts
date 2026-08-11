import { UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../../users/users.service';
import { User } from '../../users/entities/user.entity';
import { LocalStrategy } from './local.strategy';

describe('LocalStrategy', () => {
  let usersService: jest.Mocked<Partial<UsersService>>;
  let strategy: LocalStrategy;

  beforeEach(() => {
    usersService = { verifyUser: jest.fn() };
    strategy = new LocalStrategy(usersService as never);
  });

  it('returns the verified user on success', async () => {
    const user = { id: 'user-1' } as User;
    usersService.verifyUser.mockResolvedValue(user);

    await expect(
      strategy.validate('driver@example.test', 'correct-horse'),
    ).resolves.toBe(user);
    expect(usersService.verifyUser).toHaveBeenCalledWith(
      'driver@example.test',
      'correct-horse',
    );
  });

  it('masks any failure behind a generic Invalid credentials 401', async () => {
    usersService.verifyUser.mockRejectedValue(
      new Error('no user with email driver@example.test'),
    );

    await expect(
      strategy.validate('driver@example.test', 'wrong'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('never forwards the original error message, so account existence cannot leak', async () => {
    // The whole point of the try/catch in LocalStrategy: a message naming the
    // email or saying "user not found" vs "wrong password" would let a caller
    // enumerate real accounts. Only checking the exception *type* above would
    // miss a regression that lets the original message pass through unchanged.
    usersService.verifyUser.mockRejectedValue(
      new Error('no user with email driver@example.test'),
    );

    try {
      await strategy.validate('driver@example.test', 'wrong');
      throw new Error('expected validate to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe(
        'Invalid credentials',
      );
      expect((error as UnauthorizedException).message).not.toContain(
        'driver@example.test',
      );
    }
  });

  it('gives the same generic failure whether the account exists or the password is wrong', async () => {
    usersService.verifyUser.mockRejectedValueOnce(new Error('unknown account'));
    usersService.verifyUser.mockRejectedValueOnce(new Error('wrong password'));

    const unknownAccount = await strategy
      .validate('nobody@example.test', 'x')
      .catch((error) => error);
    const wrongPassword = await strategy
      .validate('real@example.test', 'x')
      .catch((error) => error);

    expect(unknownAccount.message).toBe(wrongPassword.message);
  });
});
