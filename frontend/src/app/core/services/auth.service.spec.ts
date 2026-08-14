import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

import { AuthService } from './auth.service';
import { User } from '../models/user.model';
import { environment } from '../../../environments/environment';

describe('AuthService', () => {
  let http: HttpTestingController;
  let auth: AuthService;

  const user: User = {
    id: 'user-1',
    email: 'driver@test.local',
    role: 'DRIVER',
    createdAt: '2026-08-14T09:00:00Z',
    updatedAt: '2026-08-14T09:00:00Z',
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => http.verify());

  it('starts logged out', () => {
    expect(auth.user()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('register posts credentials with cookies but does not touch session state', async () => {
    const promise = auth.register({ email: user.email, password: 'hunter2' });

    const req = http.expectOne(`${environment.apiUrl}/auth/register`);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    expect(req.request.body).toEqual({ email: user.email, password: 'hunter2' });
    req.flush(user);

    expect(await promise).toEqual(user);
    // Registering does not log the caller in.
    expect(auth.user()).toBeNull();
  });

  it('login sets the current user on success', async () => {
    const promise = auth.login({ email: user.email, password: 'hunter2' });

    const req = http.expectOne(`${environment.apiUrl}/auth/login`);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    req.flush(user);

    expect(await promise).toEqual(user);
    expect(auth.user()).toEqual(user);
    expect(auth.isAuthenticated()).toBe(true);
  });

  it('login leaves the session unset when the request fails', async () => {
    const promise = auth.login({ email: user.email, password: 'wrong' });

    http
      .expectOne(`${environment.apiUrl}/auth/login`)
      .flush('nope', { status: 401, statusText: 'Unauthorized' });

    await expect(promise).rejects.toBeTruthy();
    expect(auth.user()).toBeNull();
  });

  it('refresh resolves the session from the cookie', async () => {
    const promise = auth.refresh();

    const req = http.expectOne(`${environment.apiUrl}/auth/me`);
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush(user);

    expect(await promise).toEqual(user);
    expect(auth.user()).toEqual(user);
  });

  it('logout clears the current user on success', async () => {
    const loginPromise = auth.login({ email: user.email, password: 'hunter2' });
    http.expectOne(`${environment.apiUrl}/auth/login`).flush(user);
    await loginPromise;
    expect(auth.isAuthenticated()).toBe(true);

    const promise = auth.logout();
    const req = http.expectOne(`${environment.apiUrl}/auth/logout`);
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBe(true);
    req.flush({});

    await promise;
    expect(auth.user()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it('logout clears the local session even when the server call fails', async () => {
    const loginPromise = auth.login({ email: user.email, password: 'hunter2' });
    http.expectOne(`${environment.apiUrl}/auth/login`).flush(user);
    await loginPromise;

    const promise = auth.logout();
    http
      .expectOne(`${environment.apiUrl}/auth/logout`)
      .flush('boom', { status: 500, statusText: 'Server Error' });

    await expect(promise).rejects.toBeTruthy();
    // The local session goes away even if the server call failed.
    expect(auth.user()).toBeNull();
  });
});
