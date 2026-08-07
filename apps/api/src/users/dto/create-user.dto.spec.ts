import 'reflect-metadata';
import { UserRole } from '@app/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserDto } from './create-user.dto';

const STRONG_PASSWORD = 'Test-password-123!';

const valid = () => ({
  email: 'driver@example.test',
  password: STRONG_PASSWORD,
});

describe('CreateUserDto', () => {
  it('accepts a minimal valid payload', async () => {
    const dto = plainToInstance(CreateUserDto, valid());

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a self-assignable role', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...valid(),
      role: UserRole.MANAGER,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts an optional displayName', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...valid(),
      displayName: 'Driver One',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a malformed email', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...valid(),
      email: 'not-an-email',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a missing email', async () => {
    const dto = plainToInstance(CreateUserDto, { password: STRONG_PASSWORD });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a weak password', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...valid(),
      password: 'weak',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  it('rejects a missing password', async () => {
    const dto = plainToInstance(CreateUserDto, {
      email: 'driver@example.test',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'password')).toBe(true);
  });

  /**
   * `UserRole.ADMIN` bypasses team-membership checks throughout the app, so a
   * caller must never be able to self-assign it at registration.
   */
  it('rejects the ADMIN role even though it is a valid enum member', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...valid(),
      role: UserRole.ADMIN,
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it('rejects a role outside the enum entirely', async () => {
    const dto = plainToInstance(CreateUserDto, {
      ...valid(),
      role: 'NOT_A_ROLE',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });
});
