import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { TrackMapService } from './track-map.service';
import { TrackMapResponse } from '../models/track-map.model';

describe('TrackMapService', () => {
  let http: HttpTestingController;
  let service: TrackMapService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    http = TestBed.inject(HttpTestingController);
    service = TestBed.inject(TrackMapService);
  });

  afterEach(() => http.verify());

  // Trailing await is load-bearing, as in CarsService's spec: the resource
  // writes its value from a microtask after `flush()` delivers it.
  const flush = async (body: TrackMapResponse) => {
    TestBed.tick();
    const req = http.expectOne((r) => r.url.includes('/tracks/'));
    req.flush(body);
    TestBed.tick();
    await Promise.resolve();
  };

  it('makes no request while no track is open', () => {
    TestBed.tick();
    http.expectNone(() => true);
    expect(service.map()).toBeNull();
  });

  it('fetches and exposes the map for an opened, ready track', async () => {
    service.open('serres-automotive');
    await flush({
      status: 'ready',
      map: { type: 'FeatureCollection', features: [] },
      attribution: 'Map data © OpenStreetMap contributors, ODbL 1.0',
    });

    expect(service.status()).toBe('ready');
    expect(service.map()).toEqual({ type: 'FeatureCollection', features: [] });
    expect(service.attribution()).toBe('Map data © OpenStreetMap contributors, ODbL 1.0');
  });

  it('URL-encodes the track and requests /tracks/:track/map', () => {
    service.open('serres-automotive');
    TestBed.tick();

    const req = http.expectOne(() => true);
    expect(req.request.url).toContain('/tracks/serres-automotive/map');
    req.flush({ status: 'unavailable' } satisfies TrackMapResponse);
  });

  it('exposes no map for an unavailable track, without erroring', async () => {
    service.open('kaloyanovo');
    await flush({ status: 'unavailable', failureReason: 'no-raceway-ways' });

    expect(service.status()).toBe('unavailable');
    expect(service.map()).toBeNull();
  });

  it('does not re-fetch when opened again with the same track', async () => {
    service.open('serres-automotive');
    await flush({
      status: 'ready',
      map: { type: 'FeatureCollection', features: [] },
    });

    service.open('serres-automotive');
    TestBed.tick();

    http.expectNone(() => true);
  });

  it('re-fetches for a different track', async () => {
    service.open('kaloyanovo');
    await flush({ status: 'unavailable' });

    service.open('a1-motor-park');
    TestBed.tick();

    const req = http.expectOne((r) => r.url.includes('a1-motor-park'));
    req.flush({
      status: 'ready',
      map: { type: 'FeatureCollection', features: [] },
    });
  });

  it('drops the previous track map when reopened for a new one', async () => {
    service.open('kaloyanovo');
    await flush({
      status: 'ready',
      map: { type: 'FeatureCollection', features: [] },
    });

    service.open('a1-motor-park');
    TestBed.tick();

    // The old map must not linger while the new track's request is in flight.
    expect(service.map()).toBeNull();
    http
      .expectOne((r) => r.url.includes('a1-motor-park'))
      .flush({
        status: 'unavailable',
      });
  });

  it('retries a pending response and gives up after the retry cap', async () => {
    vi.useFakeTimers();
    try {
      service.open('serres-automotive');
      TestBed.tick();
      http.expectOne(() => true).flush({ status: 'pending' });
      TestBed.tick();

      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.advanceTimersByTimeAsync(5000);
        TestBed.tick();
        http.expectOne(() => true).flush({ status: 'pending' });
        TestBed.tick();
      }

      // The cap is 3 retries — a fourth is never scheduled.
      await vi.advanceTimersByTimeAsync(5000);
      TestBed.tick();
      http.expectNone(() => true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying once a pending track resolves to ready', async () => {
    vi.useFakeTimers();
    try {
      service.open('serres-automotive');
      TestBed.tick();
      http.expectOne(() => true).flush({ status: 'pending' });
      TestBed.tick();

      await vi.advanceTimersByTimeAsync(5000);
      TestBed.tick();
      http
        .expectOne(() => true)
        .flush({
          status: 'ready',
          map: { type: 'FeatureCollection', features: [] },
        });
      TestBed.tick();

      await vi.advanceTimersByTimeAsync(10000);
      TestBed.tick();
      http.expectNone(() => true);
      expect(service.status()).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the retry budget after a settled answer, so a later pending still retries', async () => {
    // The cap used to be per-service-lifetime rather than per-attempt-run: once
    // three pending responses had been spent, a track that went pending again
    // later was never retried and its overlay never appeared, even though the
    // server had finished the fetch seconds after.
    vi.useFakeTimers();
    try {
      service.open('serres-automotive');
      TestBed.tick();
      for (let attempt = 0; attempt < 3; attempt++) {
        http.expectOne(() => true).flush({ status: 'pending' });
        TestBed.tick();
        await vi.advanceTimersByTimeAsync(5000);
        TestBed.tick();
      }
      // The budget is spent; settle it so the counter resets.
      http.expectOne(() => true).flush({ status: 'unavailable' });
      TestBed.tick();

      // A fresh pending on the same track must be retried again.
      service.open('kaloyanovo');
      TestBed.tick();
      http.expectOne((r) => r.url.includes('kaloyanovo')).flush({ status: 'pending' });
      TestBed.tick();

      await vi.advanceTimersByTimeAsync(5000);
      TestBed.tick();
      http.expectOne((r) => r.url.includes('kaloyanovo')).flush({ status: 'unavailable' });
      TestBed.tick();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('openForSession', () => {
    // Both views arrive holding a session id rather than a track, and both
    // used to fetch `GET /sessions/:id` themselves just to read one string
    // off it. Resolving it here is what removed that duplicate.
    it('resolves a session to its track, then fetches that track', async () => {
      service.openForSession('session-1');
      TestBed.tick();

      http
        .expectOne((r) => r.url.endsWith('/sessions/session-1'))
        .flush({
          track: 'serres-automotive',
        });
      TestBed.tick();
      await Promise.resolve();
      // A second turn: the first settles the session read, the effect then
      // calls `open`, and only then does the map resource issue its request.
      TestBed.tick();
      await Promise.resolve();

      const req = http.expectOne((r) => r.url.includes('/tracks/'));
      expect(req.request.url).toContain('/tracks/serres-automotive/map');
      req.flush({
        status: 'ready',
        map: { type: 'FeatureCollection', features: [] },
      } satisfies TrackMapResponse);
      TestBed.tick();
      await Promise.resolve();

      expect(service.map()).toEqual({ type: 'FeatureCollection', features: [] });
    });

    it('idles both reads for a null session', () => {
      service.openForSession(null);
      TestBed.tick();

      http.expectNone(() => true);
      expect(service.map()).toBeNull();
    });

    it('asks for no track map when the session lookup fails', async () => {
      service.openForSession('session-1');
      TestBed.tick();
      http
        .expectOne((r) => r.url.endsWith('/sessions/session-1'))
        .flush('nope', { status: 403, statusText: 'Forbidden' });
      TestBed.tick();
      await Promise.resolve();

      // A failed decoration lookup must stay silent, not fire a request at
      // `/tracks/null/map`.
      http.expectNone(() => true);
      expect(service.map()).toBeNull();
    });
  });

  describe('failed requests degrade to no overlay, never a thrown error', () => {
    // `httpResource.value()` throws ResourceValueError in the error state, and
    // `defaultValue` does not cover it. Both templates bind `trackMap.map()`
    // directly, so an unguarded read took the whole view down during change
    // detection. A 404 here is an expected state, not an exceptional one:
    // `GET /tracks/:track/map` 404s for any track the cloud has not seeded,
    // which a car can legitimately report.
    const failureCases: [string, number, string][] = [
      ['404 for a track the cloud never seeded', 404, 'Not Found'],
      ['401 after the JWT expires on a long-open tab', 401, 'Unauthorized'],
      ['500 from the API', 500, 'Server Error'],
    ];

    for (const [name, status, statusText] of failureCases) {
      it(`survives a ${name}`, async () => {
        service.open('serres-automotive');
        TestBed.tick();
        http.expectOne(() => true).flush('failed', { status, statusText });
        TestBed.tick();
        await Promise.resolve();

        expect(() => service.map()).not.toThrow();
        expect(service.map()).toBeNull();
        expect(service.attribution()).toBeNull();
        expect(service.status()).toBeNull();
      });
    }

    it('recovers when a later track resolves normally', async () => {
      service.open('serres-automotive');
      TestBed.tick();
      http.expectOne(() => true).flush('nope', { status: 404, statusText: 'Not Found' });
      TestBed.tick();
      await Promise.resolve();
      expect(service.map()).toBeNull();

      service.open('kaloyanovo');
      await flush({
        status: 'ready',
        map: { type: 'FeatureCollection', features: [] },
      });

      expect(service.map()).toEqual({ type: 'FeatureCollection', features: [] });
    });
  });
});
