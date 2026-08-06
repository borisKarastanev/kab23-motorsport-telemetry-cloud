import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface LapSummary {
  sessionId: string;
  lapCount: number;
  bestLapMs: number | null;
}

/**
 * Lap counts and best lap times, for the session list.
 *
 * **Raw SQL rather than the `Lap` entity, on purpose.** `laps` belongs to
 * `apps/api/src/analysis`, and `AnalysisModule` already imports `SessionsModule`
 * for its authorization — importing back the other way would be a cycle. This is
 * the same shape `TelemetryRepository` already uses for `telemetry_samples`, and
 * for the same reason: a read-only rollup over a table another module owns does
 * not justify a second copy of its definition, and there is no entity to hydrate
 * from a `GROUP BY`.
 *
 * One grouped query for a whole page of sessions rather than one per session:
 * the list is the place an N+1 would actually be felt.
 *
 * This class does no authorization. `SessionsService.findAll` has already scoped
 * the session ids it passes in, and is the only caller.
 */
@Injectable()
export class LapSummaryRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async findBySessions(sessionIds: string[]): Promise<Map<string, LapSummary>> {
    if (!sessionIds.length) {
      return new Map();
    }

    const rows: LapSummary[] = await this.dataSource.query(
      `SELECT "sessionId",
              count(*)::int    AS "lapCount",
              min("lapMs")::int AS "bestLapMs"
         FROM laps
        WHERE "sessionId" = ANY($1)
        GROUP BY "sessionId"`,
      [sessionIds],
    );

    return new Map(rows.map((row) => [row.sessionId, row]));
  }
}
