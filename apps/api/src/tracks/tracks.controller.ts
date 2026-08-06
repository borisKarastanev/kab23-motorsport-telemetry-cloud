import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TracksService } from './tracks.service';
import { Track } from './entities/track.entity';

/**
 * Reference tracks, for the analysis UI's map and track picker.
 *
 * Authenticated but **not tenant-scoped** — the only such read in this app. A
 * track is a surveyed fact about a place, identical for every team; see `Track`
 * for why that makes the missing scope correct rather than missing. The guard
 * stays because the platform has no anonymous surface at all.
 *
 * Read-only: gates are seeded from a committed constant, so there is nothing
 * here to write.
 */
@Controller('tracks')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class TracksController {
  constructor(private readonly tracksService: TracksService) {}

  @Get()
  findAll(): Promise<Track[]> {
    return this.tracksService.findAll();
  }
}
