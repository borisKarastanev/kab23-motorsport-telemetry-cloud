import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GetUserDto } from './get-user.dto';

describe('GetUserDto', () => {
  it('accepts a non-empty id', async () => {
    const dto = plainToInstance(GetUserDto, { id: 'user-1' });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an empty id', async () => {
    const dto = plainToInstance(GetUserDto, { id: '' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'id')).toBe(true);
  });

  it('rejects a missing id', async () => {
    const dto = plainToInstance(GetUserDto, {});

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'id')).toBe(true);
  });
});
