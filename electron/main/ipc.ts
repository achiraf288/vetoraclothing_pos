import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ZodType } from 'zod';
import { AppError, toPublicError, type IpcResult } from './errors';
import type { Logger } from './logger';

export interface IpcContext {
  logger: Logger;
  /** Origin the renderer is allowed to call from, e.g. maison://app */
  allowedOrigin: () => string;
}

/**
 * Registers an IPC handler that:
 *  1. rejects calls that do not originate from our own renderer frame;
 *  2. validates the payload with a zod schema before any logic runs;
 *  3. converts every failure into a safe, typed IpcResult (never a raw stack).
 */
export function handle<I, O>(
  ctx: IpcContext,
  channel: string,
  schema: ZodType<I>,
  fn: (input: I, event: IpcMainInvokeEvent) => O | Promise<O>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcResult<O>> => {
    try {
      const url = event.senderFrame?.url ?? '';
      if (!url.startsWith(ctx.allowedOrigin())) {
        throw new AppError('FORBIDDEN', 'Request rejected.');
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new AppError('VALIDATION', issue?.message ?? 'Invalid input.', issue?.path.join('.') || undefined);
      }
      const data = await fn(parsed.data, event);
      return { ok: true, data };
    } catch (err) {
      const { error, unexpected } = toPublicError(err);
      if (unexpected) ctx.logger.error(`IPC ${channel} failed`, err instanceof Error ? err : String(err));
      return { ok: false, error };
    }
  });
}
