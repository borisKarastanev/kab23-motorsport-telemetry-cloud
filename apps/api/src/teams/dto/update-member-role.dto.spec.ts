import 'reflect-metadata';
import { TeamRole } from '@app/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateMemberRoleDto } from './update-member-role.dto';

describe('UpdateMemberRoleDto', () => {
  it('accepts a valid role', async () => {
    const dto = plainToInstance(UpdateMemberRoleDto, {
      role: TeamRole.MANAGER,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a missing role', async () => {
    const dto = plainToInstance(UpdateMemberRoleDto, {});

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it('rejects a role outside the enum', async () => {
    const dto = plainToInstance(UpdateMemberRoleDto, { role: 'NOT_A_ROLE' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });
});
