import { Component, input, output } from '@angular/core';
import { Lap, LapRef, OptimalLap } from '../../core/models/analysis.model';
import { lapTime as formatLapTime } from './format';

/**
 * A lap-or-optimal dropdown — "Showing" and "Compare with" on the map controls.
 *
 * Plain `<select>` with `(change)`, deliberately **not** `[(ngModel)]`:
 * `LapAnalysisService` keeps its selection signals private behind commands
 * (`selectRef`/`setCompare`), `ngModel` cannot write to a `computed`, and a
 * plain select needs no `FormsModule` on the page for one control.
 *
 * Presentational, in the style of `lap-table.ts` — inline template, no state
 * of its own beyond what its inputs already carry.
 */
@Component({
  selector: 'app-lap-picker',
  template: `
    <label class="field">
      <span class="label">{{ label() }}</span>
      <!-- selected set per option, not value bound on the select itself: with
           no value accessor (no ngModel/formControl) a plain value binding on
           the select is applied before its options exist in the DOM on first
           render and the browser silently ignores it, leaving the first
           option showing regardless of the bound value. Per-option selected
           has no such ordering dependency. -->
      <select class="select" (change)="onChange($event)">
        @if (allowNone()) {
          <option value="" [selected]="value() == null">—</option>
        }
        @if (optimal(); as o) {
          <option value="optimal" [selected]="value() === 'optimal'">
            Optimal — {{ lapTime(o.lapMs) }}
          </option>
        }
        @for (lap of laps(); track lap.lapNumber) {
          <option [value]="lap.lapNumber" [selected]="value() === lap.lapNumber">
            Lap {{ lap.lapNumber }} — {{ lapTime(lap.lapMs) }}{{ lap.isBest ? ' ★' : '' }}
          </option>
        }
      </select>
    </label>
  `,
  styles: `
    .field {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
    }
    .select {
      font: inherit;
      font-size: 0.8rem;
      padding: 0.3rem 0.6rem;
      border: 1px solid var(--border);
      border-radius: 0.4rem;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;

      &:hover {
        border-color: var(--accent);
      }
    }
  `,
})
export class LapPicker {
  readonly label = input.required<string>();
  readonly laps = input.required<Lap[]>();
  /** Omitted from the list entirely when null — nothing to offer yet. */
  readonly optimal = input<OptimalLap | null>(null);
  /**
   * Must be one of the options this picker actually renders — a lap in
   * `laps()`, `'optimal'` while `optimal()` is non-null, or `null` under
   * `allowNone()`.
   *
   * A value with no matching option cannot be displayed: per-option `selected`
   * is the only thing positioning the control, so the browser falls back to
   * showing the first option and the picker then contradicts the state it is
   * bound to. `LapAnalysisService.activeLap`/`referenceLap` hold up that end by
   * dropping an `'optimal'` ref as soon as there is no optimal lap.
   */
  readonly value = input<LapRef | null>(null);
  /** Whether a "—" (no selection) option is offered — "Compare with" only. */
  readonly allowNone = input(false);

  readonly valueChange = output<LapRef | null>();

  protected readonly lapTime = formatLapTime;

  protected onChange(event: Event): void {
    this.valueChange.emit(decode((event.target as HTMLSelectElement).value));
  }
}

/** `'optimal'` / `'9'` / `''` — the wire spelling a change event hands back. */
function decode(raw: string): LapRef | null {
  if (raw === '') {
    return null;
  }
  return raw === 'optimal' ? 'optimal' : Number(raw);
}
