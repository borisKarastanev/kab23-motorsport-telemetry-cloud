import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { signal } from '@angular/core';

import { Dashboard } from './dashboard';
import { AuthService } from '../../core/services/auth.service';
import { User } from '../../core/models/user.model';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'driver@test.local',
    role: 'DRIVER',
    createdAt: '2026-08-14T09:00:00Z',
    updatedAt: '2026-08-14T09:00:00Z',
    ...overrides,
  };
}

describe('Dashboard', () => {
  let fixture: ComponentFixture<Dashboard>;
  let currentUser: ReturnType<typeof signal<User | null>>;
  let logout: ReturnType<typeof vi.fn>;
  let router: Router;

  beforeEach(() => {
    currentUser = signal<User | null>(null);
    logout = vi.fn().mockResolvedValue(undefined);

    TestBed.configureTestingModule({
      imports: [Dashboard],
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { user: currentUser.asReadonly(), logout } },
      ],
    });

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture = TestBed.createComponent(Dashboard);
    fixture.detectChanges();
  });

  it('does not show the team-manager panel for a driver', () => {
    currentUser.set(makeUser({ role: 'DRIVER' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.isManager()).toBe(false);
  });

  it('shows the team-manager panel for a manager', () => {
    currentUser.set(makeUser({ role: 'MANAGER' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.isManager()).toBe(true);
  });

  it('shows the team-manager panel for an admin too', () => {
    currentUser.set(makeUser({ role: 'ADMIN' }));
    fixture.detectChanges();

    expect(fixture.componentInstance.isManager()).toBe(true);
  });

  it('logs out and navigates to /login', async () => {
    await fixture.componentInstance.logout();

    expect(logout).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('still navigates to /login when the logout call fails', async () => {
    logout.mockRejectedValue(new Error('network error'));

    // The component itself has no catch — only try/finally — so the
    // rejection propagates. The finally-driven navigate must still happen.
    await expect(fixture.componentInstance.logout()).rejects.toThrow('network error');

    expect(router.navigate).toHaveBeenCalledWith(['/login']);
  });
});
