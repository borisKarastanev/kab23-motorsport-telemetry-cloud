import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
  registerDecorator,
  ValidationOptions,
} from 'class-validator';
import { LapRef } from './optimal-lap.dto';

/** Enough to draw a corner faithfully; few enough that a lap stays a page. */
export const DEFAULT_TRACE_POINTS = 1000;

export class QueryTraceDto {
  /**
   * Upper bound on returned points.
   *
   * Capped rather than unbounded: a 64 s lap at 10 Hz is 640 points, but the
   * same endpoint over a 25 Hz device or a very long lap is not, and letting a
   * caller ask for everything turns one request into a payload no map can draw.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(5000)
  maxPoints?: number;
}

/**
 * A lap number (`1`, `2`, …) or the literal `'optimal'` — `IsInt`/`Min` alone
 * cannot express the second spelling, so this is a small custom validator
 * rather than a second decorator bolted on beside them.
 */
function isLapRef(value: unknown): boolean {
  return (
    value === 'optimal' || (Number.isInteger(value) && (value as number) >= 1)
  );
}

export function IsLapRef(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isLapRef',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isLapRef(value);
        },
        defaultMessage(): string {
          return `${propertyName} must be a positive integer lap number or 'optimal'`;
        },
      },
    });
  };
}

/**
 * Extends rather than repeats `maxPoints`: the 5 000 cap exists to stop a
 * caller asking for a payload no map can draw, and a second copy of it is a
 * second place to forget when it moves.
 */
export class QueryCompareDto extends QueryTraceDto {
  /**
   * The two laps to compare, as `?laps=2,5` or `?laps=optimal,5`.
   *
   * Exactly two. Three overlaid delta traces is a chart nobody reads, and the
   * delta is defined pairwise anyway — the second lap is measured against the
   * first, so a third has no unambiguous meaning.
   */
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.split(',').map((part) => {
          const trimmed = part.trim();
          return trimmed === 'optimal' ? trimmed : Number(trimmed);
        })
      : value,
  )
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsLapRef({ each: true })
  laps: LapRef[];
}
