import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';

import { CarsService } from './cars.service';
import { AuthService } from './auth.service';
import { User } from '../models/user.model';

/**
 * Regression guard for a cross-tenant disclosure in the UI.
 *
 * `CarsService` is root-provided, so it outlives every view, and an
 * `httpResource` with a constant request fetches once per tab. Logging out and
 * back in is an SPA route change rather than a page load — so before this was
 * keyed on identity, the car picker kept showing the previous account's cars to
 * whoever logged in next. The API was always correct; the leak was entirely in
 * what the tab still had in memory.
 */
describe('CarsService', () => {
  const userA = { id: 'user-a', email: 'a@test.local' } as User;
  const userB = { id: 'user-b', email: 'b@test.local' } as User;

  let current: ReturnType<typeof signal<User | null>>;
  let http: HttpTestingController;
  let cars: CarsService;

  beforeEach(() => {
    current = signal<User | null>(null);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // Only `user` is read by CarsService; the rest of AuthService is not
        // this test's concern.
        { provide: AuthService, useValue: { user: current.asReadonly() } },
      ],
    });

    http = TestBed.inject(HttpTestingController);
    cars = TestBed.inject(CarsService);
  });

  afterEach(() => http.verify());

  // Async, and the trailing await is load-bearing — do not "simplify" it away.
  // HttpTestingController.flush() delivers the response synchronously, but the
  // resource writes its value from a microtask, so without yielding the turn
  // every assertion below reads the still-empty defaultValue.
  const flush = async (names: string[]) => {
    TestBed.tick();
    const req = http.expectOne((r) => r.url.endsWith('/cars'));
    req.flush(names.map((name, i) => ({ id: `car-${i}`, name, deviceId: name })));
    TestBed.tick();
    await Promise.resolve();
  };

  it('makes no request while logged out', () => {
    TestBed.tick();
    http.expectNone((r) => r.url.endsWith('/cars'));
    expect(cars.value()).toEqual([]);
  });

  it('fetches once a user is authenticated', async () => {
    current.set(userA);
    await flush(['A Car']);

    expect(cars.value().map((c) => c.name)).toEqual(['A Car']);
  });

  it('drops the previous user list on logout', async () => {
    current.set(userA);
    await flush(['A Car']);
    expect(cars.value()).toHaveLength(1);

    current.set(null);
    TestBed.tick();

    // The whole point: nothing of user A survives in the tab.
    expect(cars.value()).toEqual([]);
  });

  it('re-fetches for a different user after a re-login', async () => {
    current.set(userA);
    await flush(['A Car']);

    current.set(null);
    TestBed.tick();

    current.set(userB);
    await flush(['B Car']);

    expect(cars.value().map((c) => c.name)).toEqual(['B Car']);
  });
});
