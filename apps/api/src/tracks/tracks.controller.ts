import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  NotFoundException,
  Param,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TracksService } from './tracks.service';
import { Track } from './entities/track.entity';
import { TrackMapService } from './track-map/track-map.service';
import {
  TrackMapResponseDto,
  toTrackMapResponseDto,
} from './track-map/dto/track-map-response.dto';

/**
 * Reference tracks, for the analysis UI's map and track picker.
 *
 * Authenticated but **not tenant-scoped** — the only such read in this app. A
 * track is a surveyed fact about a place, identical for every team; see `Track`
 * for why that makes the missing scope correct rather than missing. The guard
 * stays because the platform has no anonymous surface at all.
 *
 * Read-only: gates are seeded from a committed constant, so there is nothing
 * here to write. The one exception, `GET :track/map`, still writes nothing a
 * client controls — it caches a third party's data the first time anyone
 * asks, which is `TrackMapService`'s job, not this controller's.
 */
@Controller('tracks')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class TracksController {
  constructor(
    private readonly tracksService: TracksService,
    private readonly trackMapService: TrackMapService,
  ) {}

  @Get()
  findAll(): Promise<Track[]> {
    return this.tracksService.findAll();
  }

  /**
   * A circuit's outline, fetched from OpenStreetMap on the first request for
   * a track and cached forever after. `:track` takes the same slug-or-device-id
   * a session's own `track` string does, via `TracksService.resolve` — the
   * same lookup `AnalysisService` uses to find a session's S/F gate.
   *
   * 404 only when the track string resolves to no row at all. A track this
   * platform knows but cannot place on OpenStreetMap is not a 404: it is a
   * 200 with `status: 'unavailable'`, because the racing line above it is
   * still real and still worth drawing.
   */
  @Get(':track/map')
  async getMap(@Param('track') track: string): Promise<TrackMapResponseDto> {
    const resolved = await this.tracksService.resolve(track);
    if (!resolved) {
      throw new NotFoundException('Track not found');
    }

    return toTrackMapResponseDto(
      await this.trackMapService.get(resolved),
      resolved.name,
    );
  }
}
