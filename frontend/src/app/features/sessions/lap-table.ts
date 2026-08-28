import { Component, computed, input, output } from '@angular/core';
import { Lap, LapRef, SectorScheme } from '../../core/models/analysis.model';
import { lapTime, signedSeconds } from './format';

/**
 * The lap table — the view's index. Selecting a row drives the map and every
 * chart; the "vs" toggle picks what it is measured against.
 *
 * Sector times are shown because the plan asks for them, labelled S1/S2/S3.
 * What that label implies depends on `sectorScheme`: fixed gates, identical
 * for every lap and every session at the track (`'gates'`), or the legacy
 * equal-thirds-by-distance fallback (`'distance'`, or absent on a row derived
 * before the column existed) — the caption below says which, rather than
 * leaving a driver to find out by disagreeing with the organiser's timing
 * screen.
 */
@Component({
  selector: 'app-lap-table',
  template: `
    <table>
      <caption>
        {{ caption() }}
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
            class="row"
            [class.active]="row.lap.lapNumber === activeLap()"
            [class.reference]="row.lap.lapNumber === referenceLap()"
            (click)="select.emit(row.lap.lapNumber)"
          >
            <td>
              <button
                type="button"
                class="pick"
                (click)="$event.stopPropagation(); select.emit(row.lap.lapNumber)"
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
                (click)="$event.stopPropagation(); compare.emit(row.lap.lapNumber)"
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
    /*
     * All three row states paint on the cell, not a mix of cell and row. A
     * cell background renders *over* its row's, so a hover rule on the cell
     * and an active rule on the row means hovering the selected lap replaces
     * its highlight with the generic hover colour — the row reads as having
     * deselected itself under the cursor.
     */
    tr.row {
      cursor: pointer;
    }
    tr.row:hover td {
      background: #1a1f27;
    }
    tr.active td {
      background: #1d2530;
    }
    tr.active:hover td {
      background: #232c39;
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
  readonly activeLap = input<LapRef | null>(null);
  readonly referenceLap = input<LapRef | null>(null);
  readonly sectorScheme = input<SectorScheme | undefined>(undefined);

  readonly select = output<number>();
  readonly compare = output<number>();

  protected readonly caption = computed(() =>
    this.sectorScheme() === 'gates'
      ? 'Sectors are fixed gates on the track, identical for every lap'
      : 'Sectors are equal thirds of the lap by distance, not timing-loop splits. ' +
        'Re-analyze re-derives them against fixed sector gates.',
  );

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
