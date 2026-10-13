import { Injectable } from '@angular/core';
import type { ErrorCode, IpcResult, MaisonApi } from '@shared/api';

declare global {
  interface Window {
    /** Typed bridge exposed by the preload script. Undefined outside Electron. */
    maison?: MaisonApi;
  }
}

/** Error raised for any failed IPC call. `message` is always safe to show to the user. */
export class ApiError extends Error {
  constructor(public readonly code: ErrorCode | 'UNAVAILABLE', message: string, public readonly field?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turns `(…) => Promise<IpcResult<T>>` into `(…) => Promise<T>` (throws ApiError on failure). */
export type Unwrapped<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<IpcResult<infer R>>
    ? (...args: A) => Promise<R>
    : Unwrapped<T[K]>;
};

export type Api = Unwrapped<MaisonApi>;

type Listener = (error: ApiError) => void;
const errorListeners = new Set<Listener>();

/** Subscribe to every failed call (used to react to expired sessions). */
export function onApiError(listener: Listener): () => void {
  errorListeners.add(listener);
  return () => errorListeners.delete(listener);
}

function wrap(fn: (...args: unknown[]) => Promise<IpcResult<unknown>>) {
  return async (...args: unknown[]) => {
    let result: IpcResult<unknown>;
    try {
      result = await fn(...args);
    } catch {
      const err = new ApiError('INTERNAL', 'Something went wrong talking to the application. Please try again.');
      errorListeners.forEach((l) => l(err));
      throw err;
    }
    if (result.ok) return result.data;
    const err = new ApiError(result.error.code, result.error.message, result.error.field);
    errorListeners.forEach((l) => l(err));
    throw err;
  };
}

function unwrapGroup(group: object): object {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(group)) {
    out[name] = typeof value === 'function' ? wrap(value as never) : unwrapGroup(value as object);
  }
  return out;
}

function unavailable(): Api {
  const fail = () => Promise.reject(new ApiError('UNAVAILABLE', 'Vetora POS must be opened as the desktop application.'));
  const handler: ProxyHandler<object> = {
    get: (_t, prop) => (typeof prop === 'string' ? new Proxy(fail, handler) : undefined),
  };
  return new Proxy(fail, handler) as unknown as Api;
}

/** Injectable, promise-based, error-throwing facade over the preload bridge. */
@Injectable({ providedIn: 'root' })
export class ApiService {
  readonly api: Api = window.maison ? (unwrapGroup(window.maison) as Api) : unavailable();
}

/** Human-friendly message for any thrown value. */
export function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
}
