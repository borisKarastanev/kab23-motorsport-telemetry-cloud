import { DatabaseModule, LoggerModule } from '@app/common';
import { Module } from '@nestjs/common';
import { TracksController } from './tracks.controller';
import { TracksService } from './tracks.service';
import { TracksRepository } from './tracks.repository';
import { TracksSeedService } from './tracks-seed.service';
import { Track } from './entities/track.entity';
import { TrackMap } from './track-map/entities/track-map.entity';
import { OverpassClient } from './track-map/overpass.client';
import { TrackMapRepository } from './track-map/track-map.repository';
import { TrackMapService } from './track-map/track-map.service';

@Module({
  imports: [DatabaseModule.forFeature([Track, TrackMap]), LoggerModule],
  controllers: [TracksController],
  providers: [
    TracksService,
    TracksRepository,
    TracksSeedService,
    OverpassClient,
    TrackMapRepository,
    TrackMapService,
  ],
  // The Phase 4 analysis pass resolves a session's track to its S/F gate.
  exports: [TracksService],
})
export class TracksModule {}
