import { Component, computed, input, output } from '@angular/core';
import { Lap } from '../../core/models/analysis.model';
import { lapTime, signedSeconds } from './format';

/**
 * The lap table — the view's index. Selecting a row drives the map and every
 * chart; the "vs" toggle picks what it is measured against.
 *
 * Sector times are shown because the plan asks for them, and labelled S1/S2/S3
 * *without* implying they are timing-loop splits: no track database this
 * platform can reach carries split points, so these are equal fractions of the
 * lap's distance. Comparable between laps of the same session, meaningless
 * against anybody else's timing screen. The header note says so rather than
 * leaving a driver to find out by disagreeing with the organiser.
 */
@Component({
  selector: 'app-lap-table',
  template: `
    <table>
      <caption>
        Sectors are equal thirds of the lap by distance, not timing-loop splits
      </caption>
      <thead>
        <tr>
          <th scope="col">Lap</th>
          <th scope="col">Time</th>
          <th scope="col">Δ best</th>
          <th scope="col">S1</th>
          <th scope="col">S2</th>
          <th scope="col">S3</th>
          <th scope="col">Top</th>
          <th scope="col">Brake</th>
          <th scope="col"><span class="sr-only">Compare</span></th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.lap.lapNumber) {
          <tr
            [class.active]="row.lap.lapNumber === activeLap()"
            [class.reference]="row.lap.lapNumber === referenceLap()"
          >
            <td>
              <button
                type="button"
                class="pick"
                (click)="select.emit(row.lap.lapNumber)"
                [attr.aria-pressed]="row.lap.lapNumber === activeLap()"
              >
                {{ row.lap.lapNumber }}
                @if (row.lap.isBest) {
                  <span class="best" title="Fastest lap">★</span>
                }
              </button>
            </td>
            <td class="num">{{ row.time }}</td>
            <td class="num delta" [class.zero]="row.lap.isBest">
              {{ row.deltaToBest }}
            </td>
            @for (sector of row.sectors; track $index) {
              <td class="num">{{ sector }}</td>
            }
            <td class="num">{{ row.topSpeed }}</td>
            <td class="num">{{ row.lap.brakingPoints.length }}</td>
            <td>
              <button
                type="button"
                class="vs"
                [class.on]="row.lap.lapNumber === referenceLap()"
                [disabled]="row.lap.lapNumber === activeLap()"
                (click)="compare.emit(row.lap.lapNumber)"
              >
                vs
              </button>
            </td>
          </tr>
        }
      </tbody>
    </table>
  `,
  styles: `
    :host {
      display: block;
      overflow-x: auto;
    }
    table {
      inline-size: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    caption {
      caption-side: bottom;
      padding-block-start: 0.5rem;
      font-size: 0.7rem;
      color: var(--muted);
      text-align: start;
    }
    th {
      text-align: end;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      font-weight: 500;
      padding: 0.35rem 0.5rem;
      border-block-end: 1px solid var(--border);
    }
    th:first-child {
      text-align: start;
    }
    td {
      padding: 0.3rem 0.5rem;
      border-block-end: 1px solid var(--border);
    }
    .num {
      text-align: end;
      font-variant-numeric: tabular-nums;
    }
    tr.active {
      background: #1d2530;
    }
    tr.reference td {
      border-block-end-color: var(--muted);
    }
    .pick {
      background: none;
      border: 0;
      color: inherit;
      font: inherit;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      gap: 0.3rem;
    }
    tr.active .pick {
      font-weight: 700;
    }
    .best {
      color: #e8c14a;
    }
    .delta {
      color: var(--muted);
    }
    .delta.zero {
      color: #6bd18a;
    }
    .vs {
      font: inherit;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 0.1rem 0.45rem;
      border: 1px solid var(--border);
      border-radius: 1rem;
      background: none;
      color: var(--muted);
      cursor: pointer;
    }
    .vs.on {
      border-color: var(--accent);
      color: var(--accent);
    }
    .vs:disabled {
      opacity: 0.3;
      cursor: default;
    }
    .sr-only {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class LapTable {
  readonly laps = input.required<Lap[]>();
  readonly activeLap = input<number | null>(null);
  readonly referenceLap = input<number | null>(null);

  readonly select = output<number>();
  readonly compare = output<number>();

  protected readonly rows = computed(() => {
    const laps = this.laps();
    const best = laps.find((lap) => lap.isBest)?.lapMs ?? null;

    return laps.map((lap) => ({
      lap,
      time: lapTime(lap.lapMs),
      deltaToBest:
        best == null || lap.isBest ? '—' : signedSeconds(lap.lapMs - best),
      // Always three cells, so a lap that could not be split does not shift
      // every column after it.
      sectors: [0, 1, 2].map((i) =>
        lap.sectorMs[i] == null ? '—' : (lap.sectorMs[i] / 1000).toFixed(2),
      ),
      topSpeed:
        lap.maxSpeedKmh == null ? '—' : `${lap.maxSpeedKmh.toFixed(0)}`,
    }));
  });
}
