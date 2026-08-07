import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSessionDto } from './update-session.dto';

describe('UpdateSessionDto', () => {
  it('accepts an empty patch', async () => {
    const dto = plainToInstance(UpdateSessionDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a valid track patch', async () => {
    const dto = plainToInstance(UpdateSessionDto, { track: 'monza' });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a track over 120 characters', async () => {
    const dto = plainToInstance(UpdateSessionDto, {
      track: 'x'.repeat(121),
    });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'track')).toBe(true);
  });

  it('has no validation decorators for carId, driverId or startedAt', async () => {
    // Not a PartialType(CreateSessionDto): these are fixed at creation, so
    // this DTO carries no rules for them at all — only `track` is patchable.
    const dto = plainToInstance(UpdateSessionDto, {
      track: 'monza',
      carId: 'should-be-ignored-by-the-service-layer',
    });

    expect(await validate(dto)).toHaveLength(0);
  });
});
