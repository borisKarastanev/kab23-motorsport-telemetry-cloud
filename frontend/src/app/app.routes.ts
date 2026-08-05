import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/login/login').then((m) => m.Login),
  },
  {
    path: 'live/:carId',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/live-telemetry/live-telemetry').then(
        (m) => m.LiveTelemetry,
      ),
  },
  {
    path: 'live',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/live-telemetry/live-telemetry').then(
        (m) => m.LiveTelemetry,
      ),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard').then((m) => m.Dashboard),
  },
  { path: '**', redirectTo: '' },
];
