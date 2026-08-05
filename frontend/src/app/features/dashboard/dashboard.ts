import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly user = this.auth.user;
  readonly isManager = computed(
    () => this.user()?.role === 'MANAGER' || this.user()?.role === 'ADMIN',
  );

  async logout(): Promise<void> {
    try {
      await this.auth.logout();
    } finally {
      // Local session is cleared regardless, so always land on /login.
      await this.router.navigate(['/login']);
    }
  }
}
