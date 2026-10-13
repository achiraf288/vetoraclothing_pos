import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { messageOf } from '../../core/api.service';
import { SessionService } from '../../core/session.service';

@Component({
  selector: 'app-setup',
  imports: [FormsModule],
  template: `
    <div class="wrap">
      <form class="card card-pad panel" (ngSubmit)="submit()" autocomplete="off">
        <div class="brand"><span class="mark">V</span><h1>Welcome to Vetora POS</h1></div>
        <p class="muted lead">Create the administrator account. This account manages settings, users, stock and reports. You can add cashiers afterwards.</p>
        <div class="field">
          <label for="dn">Your name</label>
          <input id="dn" class="input" name="displayName" [(ngModel)]="displayName" required autofocus />
        </div>
        <div class="field">
          <label for="un">Username</label>
          <input id="un" class="input" name="username" [(ngModel)]="username" required autocomplete="off" />
        </div>
        <div class="field">
          <label for="pw">Password</label>
          <input id="pw" class="input" type="password" name="password" [(ngModel)]="password" required autocomplete="new-password" />
          <span class="help">At least 10 characters. Keep it somewhere safe: there is no cloud recovery.</span>
        </div>
        <div class="field">
          <label for="pw2">Confirm password</label>
          <input id="pw2" class="input" type="password" name="confirm" [(ngModel)]="confirm" required autocomplete="new-password" />
          @if (confirm && confirm !== password) { <span class="error">Passwords do not match.</span> }
        </div>
        @if (error()) { <div class="notice notice-bad" role="alert">{{ error() }}</div> }
        <button class="btn btn-primary btn-lg btn-block" type="submit" [disabled]="busy() || !valid()">{{ busy() ? 'Creating…' : 'Create administrator' }}</button>
        <p class="small muted">Local sign-in protects against casual access on a shared till. It does not replace disk encryption or a locked-down computer.</p>
      </form>
    </div>
  `,
  styleUrl: './auth.scss',
})
export class SetupPage {
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);
  displayName = '';
  username = '';
  password = '';
  confirm = '';
  readonly busy = signal(false);
  readonly error = signal('');

  valid(): boolean {
    return !!this.displayName.trim() && !!this.username.trim() && this.password.length >= 10 && this.password === this.confirm;
  }

  async submit(): Promise<void> {
    if (this.busy() || !this.valid()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.session.setupAdmin({ username: this.username.trim(), displayName: this.displayName.trim(), password: this.password });
      this.password = this.confirm = '';
      await this.router.navigateByUrl('/dashboard');
    } catch (e) {
      this.error.set(messageOf(e));
    } finally {
      this.busy.set(false);
    }
  }
}
