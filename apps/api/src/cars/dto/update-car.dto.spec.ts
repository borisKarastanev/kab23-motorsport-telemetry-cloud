import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateCarDto } from './update-car.dto';

describe('UpdateCarDto', () => {
  it('accepts an empty patch — every inherited field is optional', async () => {
    const dto = plainToInstance(UpdateCarDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a partial patch of just the name', async () => {
    const dto = plainToInstance(UpdateCarDto, { name: 'E46 GTR' });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('still enforces the deviceId shape when provided', async () => {
    const dto = plainToInstance(UpdateCarDto, { deviceId: 'car/+/#' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'deviceId')).toBe(true);
  });

  it('still enforces the teamId as a UUID when provided', async () => {
    const dto = plainToInstance(UpdateCarDto, { teamId: 'not-a-uuid' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'teamId')).toBe(true);
  });
});
