import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { TelemetryFrameDto } from './telemetry-frame.dto';

/**
 * A batch of spooled frames replayed after the link came back.
 *
 * The device deletes its local copy only once the broker acknowledges the
 * batch, so an interrupted drain re-sends rather than loses. That makes
 * duplicates normal, not exceptional — dedup is the hypertable's job (see
 * `TelemetryWriterService`), never the device's.
 */
export class BackfillBatchDto {
  @IsInt()
  v: number;

  @IsUUID()
  sid: string;

  // Min 1: an empty batch has no frame to anchor the run's clock on, and
  // anchoring at zero would push every later sample a device uptime into the
  // future. A device with nothing to drain should send nothing.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => TelemetryFrameDto)
  frames: TelemetryFrameDto[];
}
