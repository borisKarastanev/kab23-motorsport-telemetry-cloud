import { DatabaseModule, LoggerModule } from '@app/common';
import { Module } from '@nestjs/common';
import { TracksController } from './tracks.controller';
import { TracksService } from './tracks.service';
import { TracksRepository } from './tracks.repository';
import { TracksSeedService } from './tracks-seed.service';
import { Track } from './entities/track.entity';

@Module({
  imports: [DatabaseModule.forFeature([Track]), LoggerModule],
  controllers: [TracksController],
  providers: [TracksService, TracksRepository, TracksSeedService],
  // The Phase 4 analysis pass resolves a session's track to its S/F gate.
  exports: [TracksService],
})
export class TracksModule {}
