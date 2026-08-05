import {
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CarsService } from '../../core/services/cars.service';
import { LiveTelemetryService } from '../../core/services/live-telemetry.service';
import { Gauges } from './gauges';
import { TrackTrace } from './track-trace';

/**
 * Team-manager live view: pick a car, watch it.
 *
 * The car id lives in the URL so a manager can bookmark one car, and the
 * component keeps the socket in step with it. Authorization is entirely the
 * gateway's — a car id typed into the address bar that the caller may not see
 * comes back as an error, not as data.
 */
@Component({
  selector: 'app-live-telemetry',
  imports: [Gauges, RouterLink, TrackTrace],
  templateUrl: './live-telemetry.html',
  styleUrl: './live-telemetry.scss',
  // One socket per view, not one per application: see the service's own note.
  providers: [LiveTelemetryService],
})
export class LiveTelemetry implements OnDestroy {
  private readonly router = inject(Router);
  private readonly cars = inject(CarsService);
  protected readonly live = inject(LiveTelemetryService);

  protected readonly carList = this.cars.value;
  protected readonly carsLoading = this.cars.loading;

  /**
   * The `:carId` route segment, bound by `withComponentInputBinding()` — a
   * signal, so navigating between cars re-runs the effect below without
   * anything observing the router.
   */
  readonly carId = input<string>();

  protected readonly selected = computed(() =>
    this.carList().find((car) => car.id === this.carId()),
  );

  constructor() {
    // The URL is the single source of truth for what is being watched, so the
    // socket follows it rather than the other way round.
    effect(() => {
      const carId = this.carId();
      if (carId) {
        this.live.connect(carId);
      } else {
        this.live.disconnect();
      }
    });
  }

  ngOnDestroy(): void {
    // Leaving the view must close the socket, or the gateway keeps this car
    // subscribed for a viewer who is no longer looking.
    this.live.disconnect();
  }

  protected async select(carId: string): Promise<void> {
    await this.router.navigate(['/live', carId]);
  }
}
