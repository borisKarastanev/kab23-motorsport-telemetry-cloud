import { DatabaseModule, LoggerModule } from '@app/common';
import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { TracksModule } from '../tracks/tracks.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { AnalysisSamplesRepository } from './analysis-samples.repository';
import { Lap } from './entities/lap.entity';
import { LapsRepository } from './laps.repository';

/**
 * Lap derivation and the analysis API.
 *
 * Lives in `apps/api` rather than `libs/common` because only the API derives
 * laps: CLAUDE.md is explicit that `libs/common` is for what both apps
 * genuinely share, and nothing here is shared with ingest. If live lap counting
 * ever moves into ingest, that is the moment to promote the pure functions —
 * they have no Nest or TypeORM dependencies precisely so that move stays cheap.
 *
 * `SessionsModule` is imported for its authorization, not for convenience:
 * every route here is scoped by `SessionsService.requireReadableSession`.
 */
@Module({
  imports: [
    DatabaseModule.forFeature([Lap]),
    LoggerModule,
    SessionsModule,
    TracksModule,
  ],
  controllers: [AnalysisController],
  providers: [AnalysisService, LapsRepository, AnalysisSamplesRepository],
  exports: [AnalysisService],
})
export class AnalysisModule {}
