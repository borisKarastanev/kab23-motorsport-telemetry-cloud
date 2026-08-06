import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

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
 * Extends rather than repeats `maxPoints`: the 5 000 cap exists to stop a
 * caller asking for a payload no map can draw, and a second copy of it is a
 * second place to forget when it moves.
 */
export class QueryCompareDto extends QueryTraceDto {
  /**
   * The two laps to compare, as `?laps=2,5`.
   *
   * Exactly two. Three overlaid delta traces is a chart nobody reads, and the
   * delta is defined pairwise anyway — the second lap is measured against the
   * first, so a third has no unambiguous meaning.
   */
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.split(',').map((part) => Number(part.trim()))
      : value,
  )
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsInt({ each: true })
  @Min(1, { each: true })
  laps: number[];
}
