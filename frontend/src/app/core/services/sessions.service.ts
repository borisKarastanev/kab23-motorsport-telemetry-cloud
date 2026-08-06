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
 *
 * **Provided per view, not in root.** An `httpResource` fetches once per
 * instance, and a root-provided one lives as long as the tab does — so a row
 * would still read "— laps" after opening that session had derived twelve of
 * them, until a hard reload. Lap counts change as a *side effect of looking at
 * a session*, because derivation is lazy, and that is precisely the staleness a
 * tab-lifetime snapshot cannot see. Scoped to the view, the list is re-read
 * every time somebody navigates back to it.
 */
@Injectable()
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
}
