import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Deliberately not `PartialType(CreateSessionDto)`: `carId`, `driverId`, and
 * `startedAt` are what tenant scoping and telemetry attribution key off, so
 * they are fixed at creation rather than patchable afterwards.
 */
export class UpdateSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  track?: string;
}
