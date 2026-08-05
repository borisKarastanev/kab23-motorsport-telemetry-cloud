import { Injectable } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { SessionListItem } from '../models/analysis.model';

/**
 * The caller's visible sessions, newest first.
 *
 * A declarative, request-shaped read, so `httpResource` — the same shape
 * `CarsService` uses. The API scopes the list to the caller and orders it; there
 * is no client-side filtering or sorting to get wrong here.
 */
@Injectable({ providedIn: 'root' })
export class SessionsService {
  private readonly sessions = httpResource<SessionListItem[]>(
    () => ({
      url: `${environment.apiUrl}/sessions`,
      // The JWT is httpOnly; every call carries the cookie or gets a 401.
      withCredentials: true,
    }),
    { defaultValue: [] },
  );

  readonly value = this.sessions.value;
  readonly loading = this.sessions.isLoading;
  readonly error = this.sessions.error;

  /** After closing a session elsewhere, the list is stale until this runs. */
  reload(): void {
    this.sessions.reload();
  }
}
