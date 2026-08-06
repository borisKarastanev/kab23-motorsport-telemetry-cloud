import { Component, computed, input } from '@angular/core';
import { LiveFrame } from '../../core/models/live-telemetry.model';
import { lapTime } from '../../core/format';

interface Reading {
  label: string;
  value: string;
  /** Absent for the dimensionless channels; the template omits the span. */
  unit?: string;
}

/**
 * A channel reading, or an em dash.
 *
 * An em dash rather than 0: a channel the car is not sending and a channel
 * reading zero are different things, and a driver reads them differently.
 *
 * Module scope, not rebuilt inside the computed — it depends on nothing but its
 * arguments, and the computed re-runs on every frame at 10 Hz.
 */
const show = (value?: number, digits = 0): string =>
  value == null ? '—' : value.toFixed(digits);

/**
 * The current reading of each channel.
 *
 * Numbers only, no dials: this view exists to show the live path works and to
 * be read at a glance from a pit wall. Charts are Phase 4's job, against stored
 * data rather than a stream.
 */
@Component({
  selector: 'app-gauges',
  template: `
    <dl class="gauges">
      @for (gauge of readings(); track gauge.label) {
        <div class="gauge">
          <dt>{{ gauge.label }}</dt>
          <dd>
            <span class="value">{{ gauge.value }}</span>
            @if (gauge.unit) {
              <span class="unit">{{ gauge.unit }}</span>
            }
          </dd>
        </div>
      }
    </dl>
  `,
  styles: `
    .gauges {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
      gap: 0.75rem;
      margin: 0;
    }
    .gauge {
      background: #1b1f24;
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
    }
    dt {
      color: var(--muted);
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    dd {
      margin: 0.25rem 0 0;
    }
    .value {
      font-size: 1.75rem;
      font-variant-numeric: tabular-nums;
    }
    .unit {
      color: var(--muted);
      margin-inline-start: 0.25rem;
      font-size: 0.85rem;
    }
  `,
})
export class Gauges {
  readonly frame = input<LiveFrame | null>(null);

  readonly readings = computed<Reading[]>(() => {
    const frame = this.frame();

    return [
      { label: 'Speed', value: show(frame?.speed), unit: 'km/h' },
      { label: 'RPM', value: show(frame?.rpm) },
      { label: 'Coolant', value: show(frame?.coolant, 1), unit: '°C' },
      { label: 'Oil', value: show(frame?.oil, 1), unit: '°C' },
      { label: 'Lap', value: show(frame?.lap) },
      { label: 'Lap time', value: lapTime(frame?.lapMs, 1) },
      { label: 'G lat', value: show(frame?.gx, 2), unit: 'g' },
      { label: 'G long', value: show(frame?.gy, 2), unit: 'g' },
    ];
  });
}
