import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ChartSeries, LineChart } from './line-chart';

/** Normalises a CSS colour the same way the browser's CSSOM would, so a
 * comparison against a swatch's inline style is not tripped up by jsdom
 * rewriting '#4aa3df' to 'rgb(74, 163, 223)' or leaving it as-is. */
function cssColour(value: string): string {
  const probe = document.createElement('div');
  probe.style.background = value;
  return probe.style.background;
}

function series(
  points: { x: number; y: number | null }[],
  overrides: Partial<ChartSeries> = {},
): ChartSeries {
  return { label: 'Speed', colour: '#4aa3df', points, ...overrides };
}

describe('LineChart', () => {
  let fixture: ComponentFixture<LineChart>;

  const set = (inputs: {
    title?: string;
    series: ChartSeries[];
    unit?: string;
    signed?: boolean;
    showXAxis?: boolean;
    xUnit?: string;
    resetKey?: unknown;
  }) => {
    fixture.componentRef.setInput('title', inputs.title ?? 'Speed');
    fixture.componentRef.setInput('series', inputs.series);
    if (inputs.unit !== undefined) fixture.componentRef.setInput('unit', inputs.unit);
    if (inputs.signed !== undefined) fixture.componentRef.setInput('signed', inputs.signed);
    if (inputs.showXAxis !== undefined)
      fixture.componentRef.setInput('showXAxis', inputs.showXAxis);
    if (inputs.xUnit !== undefined) fixture.componentRef.setInput('xUnit', inputs.xUnit);
    if (inputs.resetKey !== undefined) fixture.componentRef.setInput('resetKey', inputs.resetKey);
    fixture.detectChanges();
  };

  const svg = () => fixture.nativeElement.querySelector('svg') as SVGSVGElement;
  const geometry = () =>
    (fixture.componentInstance as unknown as { geometry: () => unknown }).geometry() as {
      yTicks: { value: number; zero: boolean; label: string }[];
      xTicks: { value: number; label: string }[];
      lines: { label: string; d: string; muted: boolean }[];
      left: number;
      visibleSpan: number;
    } | null;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LineChart] });
    fixture = TestBed.createComponent(LineChart);
  });

  describe('no data', () => {
    it('shows "No data" with no series at all', () => {
      set({ series: [] });

      expect(fixture.nativeElement.querySelector('.empty')?.textContent).toContain('No data');
      expect(fixture.nativeElement.querySelector('.reset')).toBeFalsy();
    });

    it('shows "No data" when every series has zero points', () => {
      set({ series: [series([]), series([], { label: 'RPM' })] });

      expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
    });

    it('shows "No data" when every reading is null — a channel the car is not sending', () => {
      set({
        series: [
          series([
            { x: 0, y: null },
            { x: 10, y: null },
          ]),
        ],
      });

      expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
    });

    it('shows "No data" for a single point at x=0, which has no domain to draw', () => {
      set({ series: [series([{ x: 0, y: 50 }])] });

      expect(fixture.nativeElement.querySelector('.empty')).toBeTruthy();
    });
  });

  describe('legend', () => {
    it('renders one key per series, with the series colour on its swatch', () => {
      set({
        series: [
          series(
            [
              { x: 0, y: 1 },
              { x: 10, y: 2 },
            ],
            { label: 'Lap 3', colour: '#4aa3df' },
          ),
          series(
            [
              { x: 0, y: 1 },
              { x: 10, y: 2 },
            ],
            { label: 'Lap 1', colour: '#8b93a1', muted: true },
          ),
        ],
      });

      const keys = fixture.nativeElement.querySelectorAll('.key');
      expect(keys).toHaveLength(2);
      expect(keys[0].textContent).toContain('Lap 3');
      expect(keys[1].textContent).toContain('Lap 1');
      expect((keys[0].querySelector('.swatch') as HTMLElement).style.background).toBe(
        cssColour('#4aa3df'),
      );
      expect((keys[1].querySelector('.swatch') as HTMLElement).style.background).toBe(
        cssColour('#8b93a1'),
      );
    });
  });

  describe('path drawing', () => {
    it('draws a single path for a series with no gaps', () => {
      set({
        series: [
          series([
            { x: 0, y: 10 },
            { x: 10, y: 20 },
            { x: 20, y: 15 },
          ]),
        ],
      });

      const d = geometry()!.lines[0].d;
      expect(d.match(/M/g)).toHaveLength(1);
      expect(d.match(/L/g)).toHaveLength(2);
    });

    it('lifts the pen at a null reading rather than bridging the gap', () => {
      set({
        series: [
          series([
            { x: 0, y: 10 },
            { x: 10, y: null },
            { x: 20, y: 15 },
          ]),
        ],
      });

      const d = geometry()!.lines[0].d;
      // Two separate sub-paths — the dropout is a break, not an interpolated line.
      expect(d.match(/M/g)).toHaveLength(2);
    });

    it('marks a muted series as such, for the ghost-lap dashed style', () => {
      set({
        series: [
          series(
            [
              { x: 0, y: 1 },
              { x: 10, y: 2 },
            ],
            { muted: true },
          ),
        ],
      });

      expect(geometry()!.lines[0].muted).toBe(true);
      expect(fixture.nativeElement.querySelector('path.series.muted')).toBeTruthy();
    });
  });

  describe('y axis', () => {
    it('keeps zero on the axis, and never below it, for an unsigned channel', () => {
      // Data well clear of zero — left to itself this range would not reach
      // it, so a zero low tick is only explained by the forced inclusion, and
      // by the clamp that stops the 8% padding taking it negative.
      set({
        series: [
          series([
            { x: 0, y: 1000 },
            { x: 10, y: 1010 },
          ]),
        ],
      });

      expect(geometry()!.yTicks[0].value).toBeCloseTo(0);
    });

    it('lets the axis float for a signed channel', () => {
      set({
        series: [
          series([
            { x: 0, y: 1000 },
            { x: 10, y: 1010 },
          ]),
        ],
        signed: true,
      });

      expect(geometry()!.yTicks[0].value).toBeGreaterThan(0);
    });

    it('pads a flat channel by ±1 rather than dividing by zero', () => {
      set({
        series: [
          series([
            { x: 0, y: 50 },
            { x: 10, y: 50 },
          ]),
        ],
        signed: true,
      });

      const g = geometry()!;
      expect(g.yTicks[0].value).toBeCloseTo(48.84, 1);
      expect(g.yTicks[g.yTicks.length - 1].value).toBeCloseTo(51.16, 1);
    });

    it('appends the unit to every y tick label', () => {
      set({
        series: [
          series([
            { x: 0, y: 50 },
            { x: 10, y: 100 },
          ]),
        ],
        unit: ' km/h',
      });

      for (const tick of geometry()!.yTicks) {
        expect(tick.label.endsWith(' km/h')).toBe(true);
      }
    });
  });

  describe('x axis', () => {
    it('draws no x ticks and no x-axis labels unless asked to', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
      });

      expect(geometry()!.xTicks).toEqual([]);
      expect(fixture.nativeElement.querySelectorAll('text.label.mid:not(.empty)')).toHaveLength(0);
    });

    it('labels x ticks with the unit suffix, across the full domain when not zoomed', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
        showXAxis: true,
        xUnit: ' m',
      });

      const labels = geometry()!.xTicks.map((t) => t.label);
      expect(labels).toEqual(['0 m', '25 m', '50 m', '75 m', '100 m']);
      expect(fixture.nativeElement.querySelectorAll('text.label.mid')).toHaveLength(5);
    });

    it('scales to a domain that does not start at zero', () => {
      // The live view's x is session-elapsed seconds and its buffer rolls, so
      // once it has trimmed anything the oldest point is far from zero.
      // Assuming a zero origin left the plot's left half empty and squeezed
      // the trace into a sliver on the right.
      set({
        series: [
          series([
            { x: 300, y: 1 },
            { x: 400, y: 2 },
          ]),
        ],
        showXAxis: true,
        xUnit: ' s',
      });

      const g = geometry()!;
      expect(g.left).toBeCloseTo(300);
      expect(g.visibleSpan).toBeCloseTo(100);
      expect(g.xTicks.map((t) => t.label)).toEqual(['300 s', '325 s', '350 s', '375 s', '400 s']);
    });
  });

  describe('reset zoom control', () => {
    it('is shown whenever there is data to draw', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 10, y: 2 },
          ]),
        ],
      });

      expect(fixture.nativeElement.querySelector('.reset')).toBeTruthy();
    });
  });

  describe('zoom and pan', () => {
    const mockRect = () => {
      Object.defineProperty(svg(), 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          width: 500,
          height: 80,
          top: 0,
          left: 0,
          right: 500,
          bottom: 80,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      });
    };

    it('ignores a plain wheel, with no ctrl/meta key held', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
        showXAxis: true,
        xUnit: ' m',
      });
      mockRect();
      const before = geometry()!.xTicks.map((t) => t.value);

      const event = new WheelEvent('wheel', {
        deltaY: -100,
        ctrlKey: false,
        bubbles: true,
        cancelable: true,
      });
      svg().dispatchEvent(event);
      fixture.detectChanges();

      expect(event.defaultPrevented).toBe(false);
      expect(geometry()!.xTicks.map((t) => t.value)).toEqual(before);
    });

    it('zooms in on ctrl+wheel, narrowing the visible x window', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
        showXAxis: true,
        xUnit: ' m',
      });
      mockRect();

      const event = new WheelEvent('wheel', {
        deltaY: -200,
        ctrlKey: true,
        clientX: 250,
        clientY: 40,
        bubbles: true,
        cancelable: true,
      });
      svg().dispatchEvent(event);
      fixture.detectChanges();

      expect(event.defaultPrevented).toBe(true);
      expect(geometry()!.visibleSpan).toBeLessThan(100);
    });

    it('zooms by a usable amount when the wheel reports lines, not pixels', () => {
      // Firefox reports `deltaMode: 1` with ~3 lines per notch, where Chrome
      // reports ~100 pixels. Treating the two numbers alike made one notch
      // zoom 0.3% instead of 10% — a wheel that looks broken. jsdom defaults
      // `deltaMode` to 0, which is why every other test here missed it.
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
      });
      mockRect();

      const event = new WheelEvent('wheel', {
        deltaY: -3,
        deltaMode: 1,
        ctrlKey: true,
        clientX: 250,
        clientY: 40,
        bubbles: true,
        cancelable: true,
      });
      svg().dispatchEvent(event);
      fixture.detectChanges();

      // One notch is a visible step, not a rounding error.
      expect(geometry()!.visibleSpan).toBeLessThan(96);
    });

    it('zooms a domain that does not start at zero, toward the cursor', () => {
      // The live view's shape: x is session-elapsed seconds, so the domain
      // starts wherever the rolling buffer currently does — never at 0.
      set({
        series: [
          series([
            { x: 300, y: 1 },
            { x: 400, y: 2 },
          ]),
        ],
        showXAxis: true,
        xUnit: ' s',
      });
      mockRect();

      const event = new WheelEvent('wheel', {
        deltaY: -200,
        ctrlKey: true,
        clientX: 250,
        clientY: 40,
        bubbles: true,
        cancelable: true,
      });
      svg().dispatchEvent(event);
      fixture.detectChanges();

      const g = geometry()!;
      expect(g.visibleSpan).toBeLessThan(100);
      // Still inside the real domain, not rebased onto zero.
      expect(g.left).toBeGreaterThanOrEqual(300);
      expect(g.left + g.visibleSpan).toBeLessThanOrEqual(400.001);
    });

    it('restores the fitted view on "Reset zoom"', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
        showXAxis: true,
        xUnit: ' m',
      });
      mockRect();
      const original = geometry()!.xTicks.map((t) => t.label);

      svg().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -200,
          ctrlKey: true,
          clientX: 250,
          bubbles: true,
          cancelable: true,
        }),
      );
      fixture.detectChanges();
      expect(geometry()!.xTicks.map((t) => t.label)).not.toEqual(original);

      (fixture.nativeElement.querySelector('.reset') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(geometry()!.xTicks.map((t) => t.label)).toEqual(original);
    });

    it('resets zoom/pan whenever resetKey changes', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
        xUnit: ' m',
        resetKey: 'session-1',
      });
      mockRect();

      svg().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -200,
          ctrlKey: true,
          clientX: 250,
          bubbles: true,
          cancelable: true,
        }),
      );
      fixture.detectChanges();
      expect(geometry()!.visibleSpan).toBeLessThan(100);

      fixture.componentRef.setInput('resetKey', 'session-2');
      fixture.detectChanges();

      expect(geometry()!.visibleSpan).toBe(100);
    });

    it('toggles the dragging class across a pointer drag', () => {
      set({
        series: [
          series([
            { x: 0, y: 1 },
            { x: 100, y: 2 },
          ]),
        ],
      });
      mockRect();
      const el = svg();
      const capture = vi.fn();
      el.setPointerCapture = capture as unknown as typeof el.setPointerCapture;

      el.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, bubbles: true }),
      );
      fixture.detectChanges();
      expect(el.classList.contains('dragging')).toBe(true);

      el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
      fixture.detectChanges();
      expect(el.classList.contains('dragging')).toBe(false);
    });
  });
});
