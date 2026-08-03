import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { User } from './user.model';

interface Credentials {
  email: string;
  password: string;
}

interface RegisterPayload extends Credentials {
  displayName?: string;
  role?: 'DRIVER' | 'MANAGER';
}

/**
 * Talks to the NestJS `api` monolith. The JWT lives in an httpOnly cookie, so
 * every call uses `withCredentials` and we never touch the token in JS.
 *
 * State is exposed as signals and requests are awaited as promises — no
 * Observable leaves this service and nothing subscribes.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiUrl;

  /** Current user, or null when logged out. Populated by refresh()/login(). */
  private readonly currentUser = signal<User | null>(null);
  readonly user = this.currentUser.asReadonly();
  readonly isAuthenticated = computed(() => this.currentUser() !== null);

  async register(payload: RegisterPayload): Promise<User> {
    return firstValueFrom(
      this.http.post<User>(`${this.base}/auth/register`, payload, {
        withCredentials: true,
      }),
    );
  }

  async login(credentials: Credentials): Promise<User> {
    const user = await firstValueFrom(
      this.http.post<User>(`${this.base}/auth/login`, credentials, {
        withCredentials: true,
      }),
    );
    this.currentUser.set(user);
    return user;
  }

  /** Used by the route guard to resolve the session from the cookie on load. */
  async refresh(): Promise<User> {
    const user = await firstValueFrom(
      this.http.get<User>(`${this.base}/auth/me`, { withCredentials: true }),
    );
    this.currentUser.set(user);
    return user;
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post(
          `${this.base}/auth/logout`,
          {},
          { withCredentials: true },
        ),
      );
    } finally {
      // The local session goes away even if the server call failed.
      this.currentUser.set(null);
    }
  }
}
