import { Injectable } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { Car } from '../models/live-telemetry.model';

/**
 * The caller's visible cars — their own, plus any their teams run.
 *
 * A declarative, request-shaped read, so `httpResource` rather than a manual
 * call: it owns its own loading and error state. The API scopes the list to the
 * caller; there is no client-side filtering to get wrong here.
 */
@Injectable({ providedIn: 'root' })
export class CarsService {
  private readonly cars = httpResource<Car[]>(
    () => ({
      url: `${environment.apiUrl}/cars`,
      // The JWT is httpOnly; every call carries the cookie or gets a 401.
      withCredentials: true,
    }),
    { defaultValue: [] },
  );

  readonly value = this.cars.value;
  readonly loading = this.cars.isLoading;
}
