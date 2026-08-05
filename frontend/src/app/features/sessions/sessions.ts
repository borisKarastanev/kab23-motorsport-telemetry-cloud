import { Component, computed, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CarsService } from '../../core/services/cars.service';
import { SessionsService } from '../../core/services/sessions.service';
import { duration, lapTime } from './format';

/**
 * Every session the caller can see, newest first.
 *
 * Lap count and best lap come off the list endpoint as a single grouped
 * rollup rather than a request per row. Both read "—" for a session nobody has
 * opened: derivation is lazy, so a completed session genuinely has no laps
 * until someone looks at it, and inventing a number here would be a lie that
 * changes when clicked.
 */
@Component({
  selector: 'app-sessions',
  imports: [DatePipe, RouterLink],
  templateUrl: './sessions.html',
  styleUrl: './sessions.scss',
})
export class Sessions {
  private readonly sessions = inject(SessionsService);
  private readonly cars = inject(CarsService);

  protected readonly loading = this.sessions.loading;
  protected readonly error = this.sessions.error;

  protected readonly rows = computed(() => {
    // Cars arrive on their own request; until they do, the id is the honest
    // label. It is never shown as a blank.
    const carNames = new Map(this.cars.value().map((car) => [car.id, car.name]));

    return this.sessions.value().map((session) => ({
      ...session,
      car: carNames.get(session.carId) ?? session.carId,
      started: new Date(session.startedAt),
      length: duration(session.startedAt, session.endedAt),
      best: session.bestLapMs == null ? '—' : lapTime(session.bestLapMs),
      laps: session.lapCount ? `${session.lapCount}` : '—',
      // A live session has nothing to analyze yet, and the row says so instead
      // of offering a link to an empty view.
      analysable: session.status !== 'LIVE',
    }));
  });
}
