import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { SessionDto } from '@shared/api';
import { ApiService, onApiError } from './api.service';
import { SettingsStore } from './settings.store';

/** Signed-in user and permissions (the main process owns the real session). */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly api = inject(ApiService).api;
  private readonly settings = inject(SettingsStore);
  private readonly router = inject(Router);

  private readonly _session = signal<SessionDto | null>(null);
  readonly session = this._session.asReadonly();
  readonly user = computed(() => this._session()?.user ?? null);
  readonly isAdmin = computed(() => this._session()?.user.role === 'admin');
  readonly needsSetup = signal(false);
  readonly ready = signal(false);

  constructor() {
    onApiError((err) => {
      if (err.code === 'UNAUTHENTICATED' && this._session()) {
        this._session.set(null);
        void this.router.navigateByUrl('/login');
      }
    });
  }

  /** Loads auth state once at startup. */
  async init(): Promise<void> {
    try {
      const status = await this.api.auth.status();
      this.needsSetup.set(status.needsSetup);
      this._session.set(status.session);
      if (status.session) await this.settings.refresh();
    } catch {
      this._session.set(null);
    } finally {
      this.ready.set(true);
    }
  }

  can(permission: string): boolean {
    return this._session()?.permissions.includes(permission) ?? false;
  }

  async login(username: string, password: string): Promise<void> {
    const s = await this.api.auth.login({ username, password });
    this._session.set(s);
    await this.settings.refresh();
  }

  async setupAdmin(req: { username: string; displayName: string; password: string }): Promise<void> {
    const s = await this.api.auth.setupAdmin(req);
    this.needsSetup.set(false);
    this._session.set(s);
    await this.settings.refresh();
  }

  async logout(): Promise<void> {
    try { await this.api.auth.logout(); } finally {
      this._session.set(null);
      await this.router.navigateByUrl('/login');
    }
  }
}
