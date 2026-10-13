import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Identify the real image type from magic bytes — never trust the file extension. */
export function detectImageType(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

export class ImageStore {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  /** Copies a user-chosen image into app storage under a generated name. */
  import(sourceFile: string): string {
    const stat = fs.statSync(sourceFile);
    if (!stat.isFile()) throw new Error('NOT_A_FILE');
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('IMAGE_TOO_LARGE');
    const buf = fs.readFileSync(sourceFile);
    const type = detectImageType(buf);
    if (!type) throw new Error('UNSUPPORTED_IMAGE');
    const name = `${crypto.randomUUID()}.${type}`;
    fs.writeFileSync(path.join(this.dir, name), buf, { flag: 'wx' });
    return name;
  }

  remove(fileName: string | null): void {
    if (!fileName || !this.isSafeName(fileName)) return;
    try {
      fs.unlinkSync(path.join(this.dir, fileName));
    } catch {
      /* already gone */
    }
  }

  isSafeName(name: string): boolean {
    return /^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(name);
  }

  /** Resolve a served file name to an absolute path, or null if the name is not one we generated. */
  resolve(name: string): string | null {
    if (!this.isSafeName(name)) return null;
    const full = path.join(this.dir, name);
    return fs.existsSync(full) ? full : null;
  }
}
