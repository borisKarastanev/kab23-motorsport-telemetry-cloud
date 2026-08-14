import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { Sessions } from './sessions';
import { SessionsService } from '../../core/services/sessions.service';
import { CarsService } from '../../core/services/cars.service';
import { SessionListItem } from '../../core/models/analysis.model';
import { Car } from '../../core/models/live-telemetry.model';

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'session-1',
    carId: 'car-1',
    driverId: 'driver-1',
    track: 'Serres Automotive Park',
    startedAt: '2026-08-14T09:00:00Z',
    endedAt: '2026-08-14T09:32:07Z',
    status: 'COMPLETED',
    analyzedAt: null,
    lapCount: 12,
    bestLapMs: 92184,
    ...overrides,
  };
}

describe('Sessions', () => {
  let fixture: ComponentFixture<Sessions>;
  let sessionsValue: ReturnType<typeof signal<SessionListItem[]>>;
  let sessionsLoading: ReturnType<typeof signal<boolean>>;
  let sessionsError: ReturnType<typeof signal<unknown>>;
  let carsValue: ReturnType<typeof signal<Car[]>>;

  const create = () => {
    fixture = TestBed.createComponent(Sessions);
    fixture.detectChanges();
  };

  beforeEach(() => {
    sessionsValue = signal<SessionListItem[]>([]);
    sessionsLoading = signal(false);
    sessionsError = signal<unknown>(null);
    carsValue = signal<Car[]>([]);

    const sessionsServiceStub = {
      value: sessionsValue.asReadonly(),
      loading: sessionsLoading.asReadonly(),
      error: sessionsError.asReadonly(),
    } as unknown as SessionsService;

    TestBed.configureTestingModule({
      imports: [Sessions],
      providers: [
        provideRouter([]),
        { provide: CarsService, useValue: { value: carsValue.asReadonly() } },
      ],
    });

    // SessionsService is provided on the component itself (per-view lifetime),
    // so the module-level provider above cannot reach it — it has to be
    // overridden on the component's own provider list.
    TestBed.overrideComponent(Sessions, {
      set: { providers: [{ provide: SessionsService, useValue: sessionsServiceStub }] },
    });
  });

  it('shows a loading message while sessions are loading', () => {
    sessionsLoading.set(true);
    create();

    expect(fixture.nativeElement.textContent).toContain('Loading…');
  });

  it('shows an error message when the sessions request fails', () => {
    sessionsError.set(new Error('nope'));
    create();

    expect(fixture.nativeElement.textContent).toContain('Could not load sessions.');
  });

  it('shows an empty state when there are no sessions', () => {
    create();

    expect(fixture.nativeElement.textContent).toContain('No sessions yet.');
  });

  it('resolves the car name from CarsService, falling back to the id when unknown', () => {
    carsValue.set([{ id: 'car-1', name: 'Car One', deviceId: 'dev-1' }]);
    sessionsValue.set([
      makeSession({ id: 's1', carId: 'car-1' }),
      makeSession({ id: 's2', carId: 'car-unknown' }),
    ]);
    create();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('Car One');
    expect(rows[1].textContent).toContain('car-unknown');
  });

  it('formats length, laps and best lap, dashing what a live session has none of yet', () => {
    sessionsValue.set([
      makeSession({ id: 's1', lapCount: 12, bestLapMs: 92184 }),
      makeSession({ id: 's2', status: 'LIVE', endedAt: undefined, lapCount: 0, bestLapMs: null }),
    ]);
    create();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('32m 7s');
    expect(rows[0].textContent).toContain('12');
    expect(rows[0].textContent).toContain('1:32.184');

    const liveCells = Array.from(rows[1].querySelectorAll('td.num')).map((c) =>
      (c as HTMLElement).textContent?.trim(),
    );
    expect(liveCells).toEqual(['—', '—', '—']);
  });

  it('links to the session only when it is analysable, and marks a live one with the live pill', () => {
    sessionsValue.set([
      makeSession({ id: 'done', status: 'COMPLETED' }),
      makeSession({ id: 'live', status: 'LIVE' }),
    ]);
    create();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr');
    expect(rows[0].querySelector('a')).toBeTruthy();
    expect(rows[0].querySelector('.pill.live')).toBeFalsy();

    expect(rows[1].querySelector('a')).toBeFalsy();
    expect(rows[1].querySelector('.pill.live')).toBeTruthy();
  });
});
