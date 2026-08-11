import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryTelemetryDto } from './query-telemetry.dto';

describe('QueryTelemetryDto', () => {
  it('accepts an entirely empty query', async () => {
    const dto = plainToInstance(QueryTelemetryDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('coerces maxPoints from the querystring string into a number', () => {
    const dto = plainToInstance(QueryTelemetryDto, { maxPoints: '500' });

    expect(dto.maxPoints).toBe(500);
  });

  it('accepts a valid from/to/maxPoints combination', async () => {
    const dto = plainToInstance(QueryTelemetryDto, {
      from: '2026-08-01T10:00:00.000Z',
      to: '2026-08-01T10:30:00.000Z',
      maxPoints: '2000',
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a from/to that is not ISO 8601', async () => {
    const dto = plainToInstance(QueryTelemetryDto, { from: 'yesterday' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'from')).toBe(true);
  });

  it('rejects a maxPoints below the floor', async () => {
    const dto = plainToInstance(QueryTelemetryDto, { maxPoints: '0' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxPoints')).toBe(true);
  });

  it('rejects a maxPoints above the cap', async () => {
    // Capped rather than optional-unbounded, or a caller could turn one
    // request into a heavy scan and a payload no chart can use.
    const dto = plainToInstance(QueryTelemetryDto, { maxPoints: '5001' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxPoints')).toBe(true);
  });

  it('rejects a non-integer maxPoints', async () => {
    const dto = plainToInstance(QueryTelemetryDto, { maxPoints: '10.5' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'maxPoints')).toBe(true);
  });
});
