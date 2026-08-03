import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Resolves the session from the httpOnly cookie via /auth/me. If already
 * loaded, passes immediately; otherwise asks the API and redirects to /login
 * on failure.
 */
export const authGuard: CanActivateFn = async () => {
  // inject() must run before the first await, while the injection context is alive.
  const auth = inject(AuthService);
  const router = inject(Router);

  if (auth.isAuthenticated()) {
    return true;
  }

  try {
    await auth.refresh();
    return true;
  } catch {
    return router.createUrlTree(['/login']);
  }
};
