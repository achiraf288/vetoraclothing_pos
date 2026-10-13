import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}
export interface ConfirmState extends ConfirmOptions { resolve: (ok: boolean) => void; }

/** Promise-based confirmation dialog rendered once by the app shell. */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly current = signal<ConfirmState | null>(null);

  ask(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      this.current.set({ ...options, resolve: (ok) => { this.current.set(null); resolve(ok); } });
    });
  }
}
