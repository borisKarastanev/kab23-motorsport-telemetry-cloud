import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LapPicker } from './lap-picker';
import { Lap, OptimalLap } from '../../core/models/analysis.model';

function makeLap(overrides: Partial<Lap> = {}): Lap {
  return {
    id: `lap-${overrides.lapNumber ?? 1}`,
    sessionId: 'session-1',
    lapNumber: 1,
    startedAt: '2026-08-14T09:00:00Z',
    endedAt: '2026-08-14T09:01:32Z',
    lapMs: 92460,
    distanceM: 2100,
    maxSpeedKmh: 210,
    minSpeedKmh: 40,
    sectorMs: [30000, 31000, 31460],
    brakingPoints: [],
    isBest: false,
    ...overrides,
  };
}

const OPTIMAL: OptimalLap = {
  lapMs: 85000,
  distanceM: 2100,
  sectors: [
    { sector: 0, lapNumber: 1, sectorMs: 28000 },
    { sector: 1, lapNumber: 2, sectorMs: 30000 },
    { sector: 2, lapNumber: 2, sectorMs: 27000 },
  ],
  brakingPoints: [],
  matchesLapNumber: null,
  seams: [],
};

describe('LapPicker', () => {
  let fixture: ComponentFixture<LapPicker>;

  const select = () => fixture.nativeElement.querySelector('select') as HTMLSelectElement;
  const optionTexts = () =>
    Array.from(select().querySelectorAll('option')).map((o) => o.textContent?.trim());

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LapPicker] });
    fixture = TestBed.createComponent(LapPicker);
    fixture.componentRef.setInput('label', 'Showing');
    fixture.componentRef.setInput('laps', [
      makeLap({ lapNumber: 1, isBest: true }),
      makeLap({ lapNumber: 2, lapMs: 93000 }),
    ]);
  });

  it('renders the label', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.label').textContent).toBe('Showing');
  });

  it('lists every lap with its time, starring the best', () => {
    fixture.detectChanges();

    expect(optionTexts()).toEqual(['Lap 1 — 1:32.460 ★', 'Lap 2 — 1:33.000']);
  });

  it('omits the "—" option when allowNone is not set', () => {
    fixture.detectChanges();
    expect(optionTexts()).not.toContain('—');
  });

  it('offers a "—" option when allowNone is set', () => {
    fixture.componentRef.setInput('allowNone', true);
    fixture.detectChanges();

    expect(optionTexts()[0]).toBe('—');
  });

  it('omits the optimal entry when there is no optimal lap', () => {
    fixture.detectChanges();
    expect(optionTexts().some((t) => t?.startsWith('Optimal'))).toBe(false);
  });

  it('lists the optimal lap first, with its time, when there is one', () => {
    fixture.componentRef.setInput('optimal', OPTIMAL);
    fixture.detectChanges();

    expect(optionTexts()[0]).toBe('Optimal — 1:25.000');
  });

  it('reflects the current value in the select', () => {
    fixture.componentRef.setInput('value', 2);
    fixture.detectChanges();

    expect(select().value).toBe('2');
  });

  it('reflects an "optimal" value', () => {
    fixture.componentRef.setInput('optimal', OPTIMAL);
    fixture.componentRef.setInput('value', 'optimal');
    fixture.detectChanges();

    expect(select().value).toBe('optimal');
  });

  it('emits the chosen lap number as a LapRef', () => {
    fixture.detectChanges();
    const emitted: (number | string | null)[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));

    select().value = '2';
    select().dispatchEvent(new Event('change'));

    expect(emitted).toEqual([2]);
  });

  it('emits "optimal" as the literal string, not a number', () => {
    fixture.componentRef.setInput('optimal', OPTIMAL);
    fixture.detectChanges();
    const emitted: (number | string | null)[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));

    select().value = 'optimal';
    select().dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['optimal']);
  });

  it('emits null when "—" is chosen', () => {
    fixture.componentRef.setInput('allowNone', true);
    fixture.componentRef.setInput('value', 1);
    fixture.detectChanges();
    const emitted: (number | string | null)[] = [];
    fixture.componentInstance.valueChange.subscribe((v) => emitted.push(v));

    select().value = '';
    select().dispatchEvent(new Event('change'));

    expect(emitted).toEqual([null]);
  });
});
