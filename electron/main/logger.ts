import * as fs from 'node:fs';
import * as path from 'node:path';
import { redact } from '../db/audit';

export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

const MAX_BYTES = 1_000_000;

/** Minimal file logger. Credentials in structured data are redacted. */
export function createLogger(dir: string, name = 'maison-pos.log'): Logger {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);

  function write(level: string, msg: string, data?: unknown): void {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, file + '.1');
      }
      let extra = '';
      if (data instanceof Error) {
        extra = ` ${data.name}: ${data.message}`;
      } else if (data !== undefined) {
        extra = ' ' + JSON.stringify(redact(data));
      }
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${msg}${extra}\n`);
    } catch {
      /* logging must never crash the app */
    }
  }

  return {
    info: (m, d) => write('INFO', m, d),
    warn: (m, d) => write('WARN', m, d),
    error: (m, d) => write('ERROR', m, d),
  };
}
