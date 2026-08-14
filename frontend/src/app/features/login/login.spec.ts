import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { Login } from './login';
import { AuthService } from '../../core/services/auth.service';
import { User } from '../../core/models/user.model';

describe('Login', () => {
  let fixture: ComponentFixture<Login>;
  let login: ReturnType<typeof vi.fn>;
  let router: Router;

  beforeEach(() => {
    login = vi.fn();

    TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), { provide: AuthService, useValue: { login } }],
    });

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);

    fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
  });

  it('submits the entered credentials and navigates home on success', async () => {
    login.mockResolvedValue({ id: 'user-1' } as User);
    fixture.componentInstance.email.set('driver@test.local');
    fixture.componentInstance.password.set('hunter2');

    await fixture.componentInstance.submit();

    expect(login).toHaveBeenCalledWith({
      email: 'driver@test.local',
      password: 'hunter2',
    });
    expect(router.navigate).toHaveBeenCalledWith(['/']);
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('shows a generic error and does not navigate on failure', async () => {
    login.mockRejectedValue(new Error('401'));

    await fixture.componentInstance.submit();

    expect(fixture.componentInstance.error()).toBe('Invalid email or password');
    expect(router.navigate).not.toHaveBeenCalled();
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('sets loading while the request is in flight', async () => {
    let resolveLogin!: (user: User) => void;
    login.mockReturnValue(
      new Promise<User>((resolve) => {
        resolveLogin = resolve;
      }),
    );

    const submitPromise = fixture.componentInstance.submit();
    expect(fixture.componentInstance.loading()).toBe(true);

    resolveLogin({ id: 'user-1' } as User);
    await submitPromise;

    expect(fixture.componentInstance.loading()).toBe(false);
  });
});
