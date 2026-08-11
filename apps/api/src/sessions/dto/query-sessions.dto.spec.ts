import 'reflect-metadata';
import { SessionStatus } from '@app/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QuerySessionsDto } from './query-sessions.dto';

describe('QuerySessionsDto', () => {
  it('accepts an entirely empty query', async () => {
    const dto = plainToInstance(QuerySessionsDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a valid carId, teamId and status together', async () => {
    const dto = plainToInstance(QuerySessionsDto, {
      carId: '11111111-1111-4111-8111-111111111111',
      teamId: '22222222-2222-4222-8222-222222222222',
      status: SessionStatus.LIVE,
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a carId that is not a UUID', async () => {
    const dto = plainToInstance(QuerySessionsDto, { carId: 'not-a-uuid' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'carId')).toBe(true);
  });

  it('rejects a teamId that is not a UUID', async () => {
    const dto = plainToInstance(QuerySessionsDto, { teamId: 'not-a-uuid' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'teamId')).toBe(true);
  });

  it('rejects a status outside the enum', async () => {
    const dto = plainToInstance(QuerySessionsDto, { status: 'NOT_A_STATUS' });

    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });
});
