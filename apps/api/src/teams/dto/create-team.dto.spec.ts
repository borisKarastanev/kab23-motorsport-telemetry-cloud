import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTeamDto } from './create-team.dto';

describe('CreateTeamDto', () => {
  it('accepts a valid name', async () => {
    const dto = plainToInstance(CreateTeamDto, { name: 'Apex Racing' });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an empty name', async () => {
    const dto = plainToInstance(CreateTeamDto, { name: '' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a missing name', async () => {
    const dto = plainToInstance(CreateTeamDto, {});

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a name over 120 characters', async () => {
    const dto = plainToInstance(CreateTeamDto, { name: 'x'.repeat(121) });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });
});
