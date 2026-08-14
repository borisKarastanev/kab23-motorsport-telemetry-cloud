import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { LapAnalysisService } from './lap-analysis.service';

/**
 * Every public read here is guarded with `hasValue()`, and this is the spec
 * that keeps it that way.
 *
 * `httpResource.value()` throws `ResourceValueError` in the error state —
 * `defaultValue` does not cover it. `session-analysis.html` binds
 * `analysis.analyzedAt()` in its topbar, *above* the `@else if
 * (analysis.error())` branch that renders failures, so an unguarded read threw
 * during change detection and took down the whole analysis view instead of
 * showing the error state that already existed for the case. All three status
 * codes below are states this feature produces normally: 401 once the 1 h JWT
 * expires on a long-open tab, 403 for another team's session, 404 for one that
 * has been deleted.
 */
describe('LapAnalysisService', () => {
  let http: HttpTestingController;
  let service: LapAnalysisService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), LapAnalysisService],
    });

    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(LapAnalysisService);
  });

  afterEach(() => http.verify());

  const failAllWith = async (status: number, statusText: string) => {
    TestBed.tick();
    for (const req of http.match(() => true)) {
      req.flush('nope', { status, statusText });
    }
    TestBed.tick();
    await Promise.resolve();
  };

  const failureCases: [string, number, string][] = [
    ['401 after the JWT expires on a long-open tab', 401, 'Unauthorized'],
    ["403 for another team's session", 403, 'Forbidden'],
    ['404 for a deleted session', 404, 'Not Found'],
  ];

  for (const [name, status, statusText] of failureCases) {
    it(`survives a ${name}`, async () => {
      service.open('session-1');
      await failAllWith(status, statusText);

      // Read in the order the template does: `analyzedAt` is the topbar pill,
      // and it is evaluated before anything checks `error()`.
      expect(() => service.analyzedAt()).not.toThrow();
      expect(service.analyzedAt()).toBeNull();
      expect(service.laps()).toEqual([]);
      expect(service.reason()).toBeNull();
      expect(service.activeTrace()).toBeNull();
      expect(service.referenceTrace()).toBeNull();
      expect(service.compare()).toBeNull();
      expect(service.error()).toBeTruthy();
    });
  }

  it('exposes laps and the analysed timestamp on a normal response', async () => {
    service.open('session-1');
    TestBed.tick();

    http
      .match((r) => r.url.endsWith('/laps'))
      .forEach((req) =>
        req.flush({
          analyzedAt: '2026-08-14T09:00:00Z',
          laps: [{ lapNumber: 1, lapTimeMs: 92000, isBest: true }],
        }),
      );
    // The trace requests are this view's other reads; the laps response above
    // is the one under test.
    http.match(() => true).forEach((req) => req.flush({ points: [] }));
    TestBed.tick();
    await Promise.resolve();

    expect(service.analyzedAt()).toBe('2026-08-14T09:00:00Z');
    expect(service.laps()).toHaveLength(1);
    expect(service.bestLap()).toBe(1);
  });
});
