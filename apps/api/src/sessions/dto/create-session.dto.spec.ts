import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSessionDto } from './create-session.dto';

const CAR_ID = '11111111-1111-4111-8111-111111111111';
const DRIVER_ID = '22222222-2222-4222-8222-222222222222';

const valid = () => ({
  carId: CAR_ID,
  track: 'spa',
});

describe('CreateSessionDto', () => {
  it('accepts a minimal valid payload', async () => {
    const dto = plainToInstance(CreateSessionDto, valid());

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts an optional startedAt and driverId', async () => {
    const dto = plainToInstance(CreateSessionDto, {
      ...valid(),
      startedAt: '2026-01-01T00:00:00.000Z',
      driverId: DRIVER_ID,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a missing carId', async () => {
    const dto = plainToInstance(CreateSessionDto, { track: 'spa' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'carId')).toBe(true);
  });

  it('rejects a carId that is not a UUID', async () => {
    const dto = plainToInstance(CreateSessionDto, {
      ...valid(),
      carId: 'not-a-uuid',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'carId')).toBe(true);
  });

  it('rejects an empty track', async () => {
    const dto = plainToInstance(CreateSessionDto, { ...valid(), track: '' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'track')).toBe(true);
  });

  it('rejects a track over 120 characters', async () => {
    const dto = plainToInstance(CreateSessionDto, {
      ...valid(),
      track: 'x'.repeat(121),
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'track')).toBe(true);
  });

  it('rejects a startedAt that is not a valid ISO date string', async () => {
    const dto = plainToInstance(CreateSessionDto, {
      ...valid(),
      startedAt: 'not-a-date',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'startedAt')).toBe(true);
  });

  it('rejects a driverId that is not a UUID', async () => {
    const dto = plainToInstance(CreateSessionDto, {
      ...valid(),
      driverId: 'not-a-uuid',
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'driverId')).toBe(true);
  });
});
