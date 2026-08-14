import { Injectable, inject } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { Car } from '../models/live-telemetry.model';
import { guarded } from '../resource';
import { AuthService } from './auth.service';

/**
 * The caller's visible cars — their own, plus any their teams run.
 *
 * A declarative, request-shaped read, so `httpResource` rather than a manual
 * call: it owns its own loading and error state. The API scopes the list to the
 * caller; there is no client-side filtering to get wrong here.
 *
 * **Keyed on the authenticated user, and that is load-bearing.** This service is
 * `providedIn: 'root'`, so it outlives every view — and an `httpResource` with a
 * constant request fetches once and never again for the lifetime of the tab.
 * Logging out and back in is an SPA route change, not a page load, so without a
 * reactive dependency on identity the picker kept showing the *previous* user's
 * cars to whoever logged in next. On a shared pit-wall laptop that is one
 * account reading another's garage.
 *
 * Reading `auth.user()` fixes both halves of that. Logging out sets it to null,
 * the request function returns `undefined`, and the resource goes idle and
 * resets to `defaultValue` — so the old list is dropped rather than sitting in
 * memory. Logging in makes it defined again and a fresh request goes out.
 *
 * (`SessionsService` avoids the same hazard by not being root-provided at all;
 * see its docblock. That is not an option here — the car picker is shared by the
 * live view and the sessions view, and both want the same list.)
 */
@Injectable({ providedIn: 'root' })
export class CarsService {
  private readonly auth = inject(AuthService);

  private readonly cars = httpResource<Car[]>(
    () => {
      // Undefined means "make no request": the resource idles and its value
      // falls back to defaultValue. Anything else would leave a logged-out tab
      // holding a list it is no longer entitled to.
      if (!this.auth.user()) {
        return undefined;
      }

      return {
        url: `${environment.apiUrl}/cars`,
        // The JWT is httpOnly; every call carries the cookie or gets a 401.
        withCredentials: true,
      };
    },
    { defaultValue: [] },
  );

  /** Empty rather than thrown when `/cars` fails; see `guarded`. */
  readonly value = guarded(this.cars, [] as Car[]);
  readonly loading = this.cars.isLoading;
}
