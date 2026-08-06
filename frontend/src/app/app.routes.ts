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
  // `sessions/:id` before `sessions`: the router takes the first full match,
  // and both are static prefixes, so ordering is what keeps them distinct.
  {
    path: 'sessions/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/sessions/session-analysis').then(
        (m) => m.SessionAnalysis,
      ),
  },
  {
    path: 'sessions',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/sessions/sessions').then((m) => m.Sessions),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./features/dashboard/dashboard').then((m) => m.Dashboard),
  },
  { path: '**', redirectTo: '' },
];
