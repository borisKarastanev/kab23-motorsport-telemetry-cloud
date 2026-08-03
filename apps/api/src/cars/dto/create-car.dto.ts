import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateCarDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  make?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  model?: string;

  /**
   * Constrained to characters that are safe in an MQTT topic segment: a `+`,
   * `#`, or `/` here would let a car subscribe or publish outside its own
   * `cars/<deviceId>/…` namespace.
   */
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_-]+$/, {
    message: 'deviceId may contain only letters, digits, hyphens, underscores',
  })
  deviceId: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;
}
