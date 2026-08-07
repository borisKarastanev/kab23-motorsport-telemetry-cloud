import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryCompareDto, QueryTraceDto } from './query-trace.dto';

describe('QueryTraceDto', () => {
  it('accepts an absent maxPoints', async () => {
    const dto = plainToInstance(QueryTraceDto, {});

    expect(await validate(dto)).toHaveLength(0);
  });

  it('coerces a numeric string query param into a number', async () => {
    const dto = plainToInstance(QueryTraceDto, { maxPoints: '500' });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.maxPoints).toBe(500);
  });

  it('accepts the lower bound of 2', async () => {
    const dto = plainToInstance(QueryTraceDto, { maxPoints: '2' });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts the upper bound of 5000', async () => {
    const dto = plainToInstance(QueryTraceDto, { maxPoints: '5000' });

    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects a maxPoints below 2', async () => {
    const dto = plainToInstance(QueryTraceDto, { maxPoints: '1' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('min');
  });

  it('rejects a maxPoints above 5000', async () => {
    const dto = plainToInstance(QueryTraceDto, { maxPoints: '5001' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('rejects a non-integer maxPoints', async () => {
    const dto = plainToInstance(QueryTraceDto, { maxPoints: '2.5' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isInt');
  });
});

describe('QueryCompareDto', () => {
  it('parses a comma-separated laps query string into an array of numbers', async () => {
    const dto = plainToInstance(QueryCompareDto, { laps: '2,5' });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.laps).toEqual([2, 5]);
  });

  it('tolerates whitespace around the comma-separated values', async () => {
    const dto = plainToInstance(QueryCompareDto, { laps: ' 2 , 5 ' });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.laps).toEqual([2, 5]);
  });

  it('leaves a non-string value (e.g. already an array) untouched', async () => {
    const dto = plainToInstance(QueryCompareDto, { laps: [2, 5] });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.laps).toEqual([2, 5]);
  });

  it('rejects fewer than two laps', async () => {
    const dto = plainToInstance(QueryCompareDto, { laps: '2' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMinSize');
  });

  it('rejects more than two laps', async () => {
    const dto = plainToInstance(QueryCompareDto, { laps: '1,2,3' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('arrayMaxSize');
  });

  it('rejects a non-integer lap number', async () => {
    const dto = plainToInstance(QueryCompareDto, { laps: '2.5,5' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('isInt');
  });

  it('rejects a lap number below 1', async () => {
    const dto = plainToInstance(QueryCompareDto, { laps: '0,5' });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('min');
  });

  it('inherits maxPoints validation from QueryTraceDto', async () => {
    const dto = plainToInstance(QueryCompareDto, {
      laps: '2,5',
      maxPoints: '5001',
    });

    const errors = await validate(dto);
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('maxPoints');
  });
});
