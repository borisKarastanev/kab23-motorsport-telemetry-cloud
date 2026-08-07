import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

describe('UpdateProfileDto', () => {
  it('accepts an empty patch', async () => {
    const dto = plainToInstance(UpdateProfileDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a valid displayName', async () => {
    const dto = plainToInstance(UpdateProfileDto, {
      displayName: 'New Name',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a displayName over 120 characters', async () => {
    const dto = plainToInstance(UpdateProfileDto, {
      displayName: 'x'.repeat(121),
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'displayName')).toBe(true);
  });

  /**
   * There is no decorator for email, password or role at all — whitelisting
   * by omission is what stops a role escalation via PATCH /users/me. Extra
   * keys pass validation (whitelist isn't enabled at the pipe), but the
   * service layer only ever reads `displayName` off this DTO.
   */
  it('does not validate email, password or role — they are simply not part of the shape', async () => {
    const dto = plainToInstance(UpdateProfileDto, {
      displayName: 'New Name',
      role: 'ADMIN',
    });

    expect(await validate(dto)).toHaveLength(0);
  });
});
