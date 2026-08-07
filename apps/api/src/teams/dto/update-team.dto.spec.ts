import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTeamDto } from './update-team.dto';

describe('UpdateTeamDto', () => {
  it('accepts an empty patch — name is optional here', async () => {
    const dto = plainToInstance(UpdateTeamDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a valid name patch', async () => {
    const dto = plainToInstance(UpdateTeamDto, { name: 'Renamed Racing' });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('still enforces the max length when a name is provided', async () => {
    const dto = plainToInstance(UpdateTeamDto, { name: 'x'.repeat(121) });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });
});
