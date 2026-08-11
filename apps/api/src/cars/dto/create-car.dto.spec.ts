import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCarDto } from './create-car.dto';

const valid = () => ({
  name: 'E46',
  deviceId: 'TEST123',
});

describe('CreateCarDto', () => {
  it('accepts a minimal valid payload', async () => {
    const dto = plainToInstance(CreateCarDto, valid());

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts optional make, model and teamId when present', async () => {
    const dto = plainToInstance(CreateCarDto, {
      ...valid(),
      make: 'BMW',
      model: 'E46',
      teamId: '11111111-1111-4111-8111-111111111111',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects an empty name', async () => {
    const dto = plainToInstance(CreateCarDto, { ...valid(), name: '' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a name over 120 characters', async () => {
    const dto = plainToInstance(CreateCarDto, {
      ...valid(),
      name: 'x'.repeat(121),
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects a deviceId containing MQTT wildcard characters', async () => {
    const dto = plainToInstance(CreateCarDto, {
      ...valid(),
      deviceId: 'car/+/#',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'deviceId')).toBe(true);
    expect(
      errors.find((e) => e.property === 'deviceId')?.constraints,
    ).toHaveProperty('matches');
  });

  it('rejects an empty deviceId', async () => {
    const dto = plainToInstance(CreateCarDto, { ...valid(), deviceId: '' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'deviceId')).toBe(true);
  });

  it('accepts a deviceId with letters, digits, hyphens and underscores', async () => {
    const dto = plainToInstance(CreateCarDto, {
      ...valid(),
      deviceId: 'car-1_TEST',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a teamId that is not a UUID', async () => {
    const dto = plainToInstance(CreateCarDto, {
      ...valid(),
      teamId: 'not-a-uuid',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'teamId')).toBe(true);
  });
});
