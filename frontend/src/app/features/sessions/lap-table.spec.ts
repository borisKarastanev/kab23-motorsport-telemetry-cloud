import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LapTable } from './lap-table';
import { Lap } from '../../core/models/analysis.model';

function makeLap(overrides: Partial<Lap> = {}): Lap {
  return {
    id: `lap-${overrides.lapNumber ?? 1}`,
    sessionId: 'session-1',
    lapNumber: 1,
    startedAt: '2026-08-14T09:00:00Z',
    endedAt: '2026-08-14T09:01:32Z',
    lapMs: 92000,
    distanceM: 2100,
    maxSpeedKmh: 210,
    minSpeedKmh: 40,
    sectorMs: [30000, 31000, 31000],
    brakingPoints: [],
    isBest: false,
    ...overrides,
  };
}

describe('LapTable', () => {
  let fixture: ComponentFixture<LapTable>;

  const rowsEl = () => fixture.nativeElement.querySelectorAll('tr.row') as NodeListOf<HTMLElement>;
  const pickButton = (row: HTMLElement) => row.querySelector('.pick') as HTMLButtonElement;
  const vsButton = (row: HTMLElement) => row.querySelector('.vs') as HTMLButtonElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LapTable] });
    fixture = TestBed.createComponent(LapTable);
  });

  it('renders one row per lap, with time, sectors and top speed', () => {
    fixture.componentRef.setInput('laps', [
      makeLap({ lapNumber: 1, lapMs: 92184, isBest: true }),
    ]);
    fixture.detectChanges();

    const row = rowsEl()[0];
    expect(row.querySelector('.pick')?.textContent).toContain('1');
    expect(row.querySelectorAll('td.num')[0].textContent).toContain('1:32.184');
    // Best lap's own delta column reads as a dash, not "+0.000".
    expect(row.querySelectorAll('td.num')[1].textContent?.trim()).toBe('—');
    const sectorCells = Array.from(row.querySelectorAll('td.num')).slice(2, 5);
    expect(sectorCells.map((c) => c.textContent?.trim())).toEqual(['30.00', '31.00', '31.00']);
    expect(row.querySelector('.best')).toBeTruthy();
  });

  it('renders a signed delta to the best lap for every other row', () => {
    fixture.componentRef.setInput('laps', [
      makeLap({ lapNumber: 1, lapMs: 90000, isBest: true }),
      makeLap({ lapNumber: 2, lapMs: 90500, isBest: false }),
    ]);
    fixture.detectChanges();

    const second = rowsEl()[1];
    expect(second.querySelectorAll('td.num')[1].textContent?.trim()).toBe('+0.500');
  });

  it('always renders three sector cells, dashing missing splits so columns never shift', () => {
    fixture.componentRef.setInput('laps', [
      makeLap({ lapNumber: 1, sectorMs: [], isBest: true }),
    ]);
    fixture.detectChanges();

    const sectorCells = Array.from(rowsEl()[0].querySelectorAll('td.num')).slice(2, 5);
    expect(sectorCells.map((c) => c.textContent?.trim())).toEqual(['—', '—', '—']);
  });

  it('dashes top speed when the lap has none', () => {
    fixture.componentRef.setInput('laps', [
      makeLap({ lapNumber: 1, maxSpeedKmh: null, isBest: true }),
    ]);
    fixture.detectChanges();

    const topSpeedCell = rowsEl()[0].querySelectorAll('td.num')[5];
    expect(topSpeedCell.textContent?.trim()).toBe('—');
  });

  it('marks the active and reference rows', () => {
    fixture.componentRef.setInput('laps', [makeLap({ lapNumber: 1 }), makeLap({ lapNumber: 2 })]);
    fixture.componentRef.setInput('activeLap', 2);
    fixture.componentRef.setInput('referenceLap', 1);
    fixture.detectChanges();

    const [first, second] = Array.from(rowsEl());
    expect(first.classList.contains('reference')).toBe(true);
    expect(first.classList.contains('active')).toBe(false);
    expect(second.classList.contains('active')).toBe(true);
    expect(second.classList.contains('reference')).toBe(false);
  });

  it('emits select once when a row is clicked', () => {
    fixture.componentRef.setInput('laps', [makeLap({ lapNumber: 1 }), makeLap({ lapNumber: 2 })]);
    fixture.detectChanges();

    const emitted: number[] = [];
    fixture.componentInstance.select.subscribe((n: number) => emitted.push(n));

    rowsEl()[1].dispatchEvent(new Event('click', { bubbles: true }));

    expect(emitted).toEqual([2]);
  });

  it('emits select exactly once when the pick button is clicked, not doubled by row bubbling', () => {
    fixture.componentRef.setInput('laps', [makeLap({ lapNumber: 1 })]);
    fixture.detectChanges();

    const emitted: number[] = [];
    fixture.componentInstance.select.subscribe((n: number) => emitted.push(n));

    pickButton(rowsEl()[0]).click();

    expect(emitted).toEqual([1]);
  });

  it('emits compare when the vs button is clicked, without also emitting select', () => {
    fixture.componentRef.setInput('laps', [
      makeLap({ lapNumber: 1 }),
      makeLap({ lapNumber: 2 }),
    ]);
    fixture.componentRef.setInput('activeLap', 1);
    fixture.detectChanges();

    const selected: number[] = [];
    const compared: number[] = [];
    fixture.componentInstance.select.subscribe((n: number) => selected.push(n));
    fixture.componentInstance.compare.subscribe((n: number) => compared.push(n));

    vsButton(rowsEl()[1]).click();

    expect(compared).toEqual([2]);
    expect(selected).toEqual([]);
  });

  it('disables the vs button for the currently active lap', () => {
    fixture.componentRef.setInput('laps', [makeLap({ lapNumber: 1 })]);
    fixture.componentRef.setInput('activeLap', 1);
    fixture.detectChanges();

    expect(vsButton(rowsEl()[0]).disabled).toBe(true);
  });

  it('marks the vs button "on" for the reference lap', () => {
    fixture.componentRef.setInput('laps', [makeLap({ lapNumber: 1 }), makeLap({ lapNumber: 2 })]);
    fixture.componentRef.setInput('activeLap', 2);
    fixture.componentRef.setInput('referenceLap', 1);
    fixture.detectChanges();

    expect(vsButton(rowsEl()[0]).classList.contains('on')).toBe(true);
    expect(vsButton(rowsEl()[1]).classList.contains('on')).toBe(false);
  });

  it('highlights no row when the active or reference ref is "optimal"', () => {
    fixture.componentRef.setInput('laps', [makeLap({ lapNumber: 1 }), makeLap({ lapNumber: 2 })]);
    fixture.componentRef.setInput('activeLap', 'optimal');
    fixture.componentRef.setInput('referenceLap', 'optimal');
    fixture.detectChanges();

    for (const row of Array.from(rowsEl())) {
      expect(row.classList.contains('active')).toBe(false);
      expect(row.classList.contains('reference')).toBe(false);
    }
  });

  it('disables no vs button when "optimal" is active — no row equals it', () => {
    fixture.componentRef.setInput('laps', [makeLap({ lapNumber: 1 })]);
    fixture.componentRef.setInput('activeLap', 'optimal');
    fixture.detectChanges();

    expect(vsButton(rowsEl()[0]).disabled).toBe(false);
  });

  describe('caption', () => {
    it('names the legacy scheme and points at Re-analyze when sectors are distance-fraction', () => {
      fixture.componentRef.setInput('laps', [makeLap()]);
      fixture.componentRef.setInput('sectorScheme', 'distance');
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('caption').textContent).toContain(
        'Re-analyze re-derives them against fixed sector gates',
      );
    });

    it('says the same for an undefined scheme — a session derived before the column existed', () => {
      fixture.componentRef.setInput('laps', [makeLap()]);
      fixture.detectChanges();

      expect(fixture.nativeElement.querySelector('caption').textContent).toContain(
        'Re-analyze re-derives them against fixed sector gates',
      );
    });

    it('names fixed gates once the session is gate-derived', () => {
      fixture.componentRef.setInput('laps', [makeLap()]);
      fixture.componentRef.setInput('sectorScheme', 'gates');
      fixture.detectChanges();

      const caption = fixture.nativeElement.querySelector('caption').textContent;
      expect(caption).toContain('fixed gates on the track');
      expect(caption).not.toContain('Re-analyze');
    });
  });
});
