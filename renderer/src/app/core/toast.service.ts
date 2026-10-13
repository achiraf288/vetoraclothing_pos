import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; kind: 'ok' | 'bad' | 'info'; text: string; }

@Injectable({ providedIn: 'root' })
export class ToastService {
  private seq = 0;
  readonly toasts = signal<Toast[]>([]);

  success(text: string): void { this.push('ok', text, 3500); }
  error(text: string): void { this.push('bad', text, 7000); }
  info(text: string): void { this.push('info', text, 4000); }
  dismiss(id: number): void { this.toasts.update((l) => l.filter((t) => t.id !== id)); }

  private push(kind: Toast['kind'], text: string, ms: number): void {
    const id = ++this.seq;
    this.toasts.update((l) => [...l, { id, kind, text }]);
    setTimeout(() => this.dismiss(id), ms);
  }
}
