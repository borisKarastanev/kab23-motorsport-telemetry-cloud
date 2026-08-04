import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TelemetrySample } from './entities/telemetry-sample.entity';

/** Flush thresholds — whichever is reached first. */
const MAX_BUFFERED_ROWS = 100;
const MAX_BUFFER_AGE_MS = 250;

/**
 * Buffers samples and writes them in batches.
 *
 * One `INSERT` per frame would be ten round trips per second per car, spent
 * almost entirely on latency. Coalescing into batches of up to 100 rows (or
 * whatever has accumulated after 250 ms) is roughly an order of magnitude fewer
 * round trips, and 250 ms is comfortably inside the <1–2 s glass-to-glass
 * budget — the Phase 3 live path publishes to Redis *before* this flush, so
 * nothing a viewer sees ever waits on the database.
 *
 * Writes use `ON CONFLICT DO NOTHING` against the `(session_id, seq, time)`
 * dedup index. That is what lets a device re-send any backfill batch it is not
 * certain landed: duplicates are free, and lost data is not.
 */
@Injectable()
export class TelemetryWriterService implements OnApplicationShutdown {
  private readonly logger = new Logger(TelemetryWriterService.name);
  private buffer: TelemetrySample[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** Serialises flushes so two batches never interleave on the same buffer. */
  private flushing: Promise<void> = Promise.resolve();

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onApplicationShutdown(): Promise<void> {
    this.cancelTimer();
    await this.flush();
  }

  enqueue(sample: TelemetrySample): void {
    this.buffer.push(sample);
    this.scheduleFlush();
  }

  /**
   * A whole backfill batch at once, deliberately not `enqueue` in a loop: that
   * would trip the row threshold every 100 samples and, because flushes are
   * serialised, turn one replayed batch into a chain of round trips. The batch
   * is already complete when it arrives, so there is no latency to bound.
   */
  enqueueAll(samples: TelemetrySample[]): void {
    this.buffer.push(...samples);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.buffer.length >= MAX_BUFFERED_ROWS) {
      void this.flush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), MAX_BUFFER_AGE_MS);
    }
  }

  /** Exposed for tests and shutdown; the buffer normally flushes itself. */
  flush(): Promise<void> {
    this.cancelTimer();

    if (!this.buffer.length) {
      return this.flushing;
    }

    const batch = this.buffer;
    this.buffer = [];

    const run = () => this.write(batch);
    this.flushing = this.flushing.then(run, run);
    return this.flushing;
  }

  private async write(batch: TelemetrySample[]): Promise<void> {
    try {
      await this.dataSource
        .createQueryBuilder()
        .insert()
        .into(TelemetrySample)
        .values(batch)
        .orIgnore()
        .execute();
    } catch (error) {
      // Counts only. A failed batch carries GPS traces for a named driver, so
      // the rows themselves must never be logged to diagnose the write.
      this.logger.error(
        `Dropped a batch of ${batch.length} telemetry samples: ${
          (error as Error).message
        }`,
      );
    }
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
