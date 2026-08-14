import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { SessionsService } from './sessions.service';

describe('SessionsService', () => {
  let http: HttpTestingController;
  let sessions: SessionsService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      // Provided per view, not in root — see the service's docblock.
      providers: [provideHttpClient(), provideHttpClientTesting(), SessionsService],
    });

    http = TestBed.inject(HttpTestingController);
    sessions = TestBed.inject(SessionsService);
  });

  afterEach(() => http.verify());

  it('exposes the fetched list', async () => {
    TestBed.tick();
    http
      .expectOne((r) => r.url.endsWith('/sessions'))
      .flush([{ id: 'session-1', carId: 'car-1', startedAt: '2026-08-14T09:00:00Z' }]);
    TestBed.tick();
    await Promise.resolve();

    expect(sessions.value()).toHaveLength(1);
  });

  it('degrades to an empty list on a failed request, without throwing', async () => {
    // The error state is exactly where a bare `value()` throws, and it is the
    // state this view has an `error()` branch for — the throw happened first,
    // during change detection, so that branch was unreachable.
    TestBed.tick();
    http
      .expectOne((r) => r.url.endsWith('/sessions'))
      .flush('nope', { status: 401, statusText: 'Unauthorized' });
    TestBed.tick();
    await Promise.resolve();

    expect(() => sessions.value()).not.toThrow();
    expect(sessions.value()).toEqual([]);
    expect(sessions.error()).toBeTruthy();
  });
});
