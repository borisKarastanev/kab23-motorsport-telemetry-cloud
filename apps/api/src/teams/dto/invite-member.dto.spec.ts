import 'reflect-metadata';
import { TeamRole } from '@app/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InviteMemberDto } from './invite-member.dto';

describe('InviteMemberDto', () => {
  it('accepts a valid email with no role', async () => {
    const dto = plainToInstance(InviteMemberDto, {
      email: 'invitee@example.test',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a valid email with an explicit role', async () => {
    const dto = plainToInstance(InviteMemberDto, {
      email: 'invitee@example.test',
      role: TeamRole.MANAGER,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a malformed email', async () => {
    const dto = plainToInstance(InviteMemberDto, { email: 'not-an-email' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a missing email', async () => {
    const dto = plainToInstance(InviteMemberDto, {});

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });

  it('rejects a role outside the enum', async () => {
    const dto = plainToInstance(InviteMemberDto, {
      email: 'invitee@example.test',
      role: 'NOT_A_ROLE',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });
});
