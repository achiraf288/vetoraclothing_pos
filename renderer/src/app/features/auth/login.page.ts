import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { messageOf } from '../../core/api.service';
import { SessionService } from '../../core/session.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <form class="card card-pad panel" (ngSubmit)="submit()" autocomplete="off">
        <div class="brand"><span class="mark">V</span><h1>Vetora POS</h1></div>
        <p class="muted lead">Sign in to continue.</p>
        <div class="field">
          <label for="u">Username</label>
          <input id="u" class="input" name="username" [(ngModel)]="username" required autofocus autocomplete="username" />
        </div>
        <div class="field">
          <label for="p">Password</label>
          <input id="p" class="input" type="password" name="password" [(ngModel)]="password" required autocomplete="current-password" />
        </div>
        @if (error()) { <div class="notice notice-bad" role="alert">{{ error() }}</div> }
        <button class="btn btn-primary btn-lg btn-block" type="submit" [disabled]="busy() || !username || !password">{{ busy() ? 'Signing in…' : 'Sign in' }}</button>
      </form>
    </div>
  `,
  styleUrl: './auth.scss',
})
export class LoginPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  username = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.session.login(this.username.trim(), this.password);
      this.password = '';
      await this.router.navigateByUrl(this.session.can('dashboard.read') ? '/dashboard' : '/pos');
    } catch (e) {
      this.error.set(messageOf(e));
    } finally {
      this.busy.set(false);
    }
  }
}
