import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { signal } from '@angular/core';

import { authGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';
import { User } from '../models/user.model';

describe('authGuard', () => {
  let refresh: ReturnType<typeof vi.fn>;
  let authenticated: ReturnType<typeof signal<boolean>>;
  let createUrlTree: ReturnType<typeof vi.fn>;

  const run = () =>
    TestBed.runInInjectionContext(() =>
      authGuard({} as never, { url: '/live' } as never),
    );

  beforeEach(() => {
    authenticated = signal(false);
    refresh = vi.fn();
    createUrlTree = vi.fn((commands: string[]) => ({ commands }) as unknown as UrlTree);

    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: { isAuthenticated: authenticated, refresh },
        },
        { provide: Router, useValue: { createUrlTree } },
      ],
    });
  });

  it('passes straight through when already authenticated, without calling refresh', async () => {
    authenticated.set(true);

    expect(await run()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('resolves the session via refresh when not yet authenticated', async () => {
    refresh.mockResolvedValue({ id: 'user-1' } as User);

    expect(await run()).toBe(true);
    expect(refresh).toHaveBeenCalled();
  });

  it('redirects to /login when refresh fails', async () => {
    refresh.mockRejectedValue(new Error('401'));

    const result = await run();

    expect(createUrlTree).toHaveBeenCalledWith(['/login']);
    expect(result).toEqual({ commands: ['/login'] });
  });
});
