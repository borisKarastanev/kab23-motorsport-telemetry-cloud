import { AnalysisSample, DerivedLap, Gate, LapPoint } from './analysis.types';
import { detectBrakingPoints } from './braking-points';
import {
  MIN_LAP_MS,
  ProjectedGate,
  findGateCrossing,
  projectGate,
} from './gate-crossing';
import { stepM } from './lap-distance';
import { isPositioned, lerpChannel } from './sample-math';
import { DEFAULT_SECTOR_COUNT, sectorTimes } from './sectors';

/**
 * Turns a session's samples into laps.
 *
 * `findGateCrossing` answers "did these two fixes cross the line"; everything
 * that needs memory across fixes lives here — the racing-direction latch, the
 * minimum-lap debounce, the lap counter, and the accumulating path.
 *
 * The **first** crossing arms the timer rather than completing a lap. A car
 * joins the circuit somewhere down the lap, so the run from the session's first
 * sample to the first time it sees the line is an out-lap of unknown length:
 * reporting it as lap 1 would put a garbage time at the top of every lap table.
 * This matches the device's own numbering — the samples the device stamped
 * `lap_number = 1` are exactly the ones this emits as lap 1 — so the derived
 * table and the `lap_number` channel never disagree about which lap is which.
 */
export class LapSegmenter {
  private readonly laps: DerivedLap[] = [];
  private readonly sectorCount: number;

  /** The last fix with a usable position — not necessarily the last sample. */
  private prev: AnalysisSample | null = null;

  /** Racing direction, latched on the arming crossing. 0 until then. */
  private dirSign: 1 | -1 | 0 = 0;

  private lapNumber = 0;
  private points: LapPoint[] | null = null;

  /** The gate in local metres. Constant for the run, so projected once here. */
  private readonly gate: ProjectedGate;

  constructor(gate: Gate, options: { sectorCount?: number } = {}) {
    this.gate = projectGate(gate);
    this.sectorCount = options.sectorCount ?? DEFAULT_SECTOR_COUNT;
  }

  /** Feed samples in ascending time order. */
  push(sample: AnalysisSample): void {
    if (!isPositioned(sample)) {
      // No GPS lock: it cannot contribute to the path or to a crossing, and
      // adding it to the trace at (0, 0) would draw a line to the Gulf of
      // Guinea. Dropped, and `prev` deliberately left alone so the next
      // located fix is compared against the last one that meant something —
      // subject to the gap rejection, which is what decides whether that hop
      // is still bridgeable.
      return;
    }

    const timeMs = sample.time.getTime();

    if (this.prev) {
      const crossing = findGateCrossing(
        toFix(this.prev),
        toFix(sample),
        this.gate,
        { requiredDirSign: this.dirSign || undefined },
      );

      if (crossing && this.acceptCrossing(crossing.crossMs)) {
        this.dirSign ||= crossing.dirSign;

        const anchor: Omit<LapPoint, 'distM'> = {
          timeMs: crossing.crossMs,
          lat: crossing.lat,
          lon: crossing.lon,
          speedKmh: lerpChannel(
            this.prev.speedKmh,
            sample.speedKmh,
            crossing.t,
          ),
          gLon: lerpChannel(this.prev.gLon, sample.gLon, crossing.t),
        };

        // Both laps get the same anchor point: the outgoing lap closes exactly
        // at the line and the incoming one opens there. Without it consecutive
        // laps' traces start up to a fix-interval apart — 5 m at 185 km/h —
        // and every distance-aligned comparison carries that as phantom delta
        // before the driver has done anything.
        this.closeLap(anchor);
        this.lapNumber++;
        this.points = [{ ...anchor, distM: 0 }];
      }
    }

    this.append({
      timeMs,
      lat: sample.lat,
      lon: sample.lon,
      speedKmh: sample.speedKmh,
      gLon: sample.gLon,
    });
    this.prev = sample;
  }

  pushAll(samples: Iterable<AnalysisSample>): this {
    for (const sample of samples) {
      this.push(sample);
    }
    return this;
  }

  /**
   * The completed laps.
   *
   * The lap in progress when the samples ran out is **not** included: a session
   * almost always ends with the car slowing down somewhere mid-lap, and that
   * partial run has no lap time. It is still visible as `lap_number` on the raw
   * samples for anyone who wants the in-lap trace.
   */
  result(): DerivedLap[] {
    return this.laps;
  }

  /**
   * Debounce: a second crossing implausibly soon after the last one is the same
   * crossing seen twice — GPS jitter straddling the line on consecutive fixes.
   * Applies only once a lap is running; the arming crossing has nothing to be
   * too close to.
   */
  private acceptCrossing(crossMs: number): boolean {
    if (!this.points) {
      return true;
    }
    return crossMs - this.points[0].timeMs >= MIN_LAP_MS;
  }

  private append(point: Omit<LapPoint, 'distM'>): void {
    if (!this.points) {
      return;
    }

    const last = this.points[this.points.length - 1];
    this.points.push({ ...point, distM: last.distM + stepM(last, point) });
  }

  private closeLap(anchor: Omit<LapPoint, 'distM'>): void {
    if (!this.points) {
      return;
    }

    this.append(anchor);

    const points = this.points;
    const first = points[0];
    const last = points[points.length - 1];
    // Folded rather than `Math.max(...speeds)`: a lap is hundreds of points
    // normally, but a session whose gate only matched twice can put tens of
    // thousands into one, and spreading that many arguments is a stack
    // overflow rather than a slow answer.
    let maxSpeedKmh: number | null = null;
    let minSpeedKmh: number | null = null;
    for (const { speedKmh } of points) {
      if (speedKmh == null) {
        continue;
      }
      maxSpeedKmh =
        maxSpeedKmh == null ? speedKmh : Math.max(maxSpeedKmh, speedKmh);
      minSpeedKmh =
        minSpeedKmh == null ? speedKmh : Math.min(minSpeedKmh, speedKmh);
    }

    this.laps.push({
      lapNumber: this.lapNumber,
      startedAt: new Date(Math.round(first.timeMs)),
      endedAt: new Date(Math.round(last.timeMs)),
      lapMs: Math.round(last.timeMs - first.timeMs),
      distanceM: Math.round(last.distM),
      maxSpeedKmh,
      minSpeedKmh,
      sectorMs: sectorTimes(points, this.sectorCount),
      brakingPoints: detectBrakingPoints(points),
    });

    this.points = null;
  }
}

/** Convenience wrapper — the shape the analysis service actually wants. */
export function segmentLaps(
  samples: Iterable<AnalysisSample>,
  gate: Gate,
  options: { sectorCount?: number } = {},
): DerivedLap[] {
  return new LapSegmenter(gate, options).pushAll(samples).result();
}

const toFix = (sample: AnalysisSample) => ({
  timeMs: sample.time.getTime(),
  lat: sample.lat,
  lon: sample.lon,
  speedKmh: sample.speedKmh,
});
