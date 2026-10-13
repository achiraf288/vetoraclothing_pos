import * as path from 'node:path';
import type { Db } from '../db/connection';
import { writeAudit } from '../db/audit';
import { SettingsRepo } from '../db/settings-repo';
import { AppError } from '../main/errors';
import type { DiscountCodeDto, DisplaySettings, PaymentMethodDto, SettingsDto } from '../shared/api';
import { assertCan, type Actor } from './permissions';
import { text } from './validate';

const DEFAULT_SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

function parseSizes(raw: string | undefined): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  } catch {
    /* fall through */
  }
  return DEFAULT_SIZES;
}

export class SettingsService {
  private readonly repo: SettingsRepo;

  constructor(private readonly db: Db) {
    this.repo = new SettingsRepo(db);
  }

  /** Any signed-in user may read what the UI needs to render money and receipts. */
  getDisplay(): DisplaySettings {
    const s = this.repo.getAll();
    return {
      shopName: s['shop.name'] ?? '',
      shopAddress: s['shop.address'] ?? '',
      shopPhone: s['shop.phone'] ?? '',
      shopEmail: s['shop.email'] ?? '',
      receiptFooter: s['receipt.footer'] ?? '',
      receiptPaperWidthMm: Number(s['receipt.paper_width_mm'] ?? 80),
      taxEnabled: s['tax.enabled'] === '1',
      taxLabel: s['tax.label'] ?? 'Tax',
      taxRateBps: Number(s['tax.rate_bps'] ?? 0),
      currencyCode: s['currency.code'] ?? 'LKR',
      currencySymbol: s['currency.symbol'] ?? 'Rs',
      currencyDecimals: Number(s['currency.decimals'] ?? 2),
      locale: s['locale'] ?? 'en-LK',
      sizes: parseSizes(s['inventory.sizes']),
      lowStockDefault: Number(s['inventory.low_stock_default'] ?? 5),
      allowNegativeStock: s['inventory.allow_negative_stock'] === '1',
    };
  }

  get(actor: Actor): SettingsDto {
    assertCan(actor, 'settings.read');
    const s = this.repo.getAll();
    const d = this.getDisplay();
    return {
      shopName: d.shopName,
      shopAddress: d.shopAddress,
      shopPhone: d.shopPhone,
      shopEmail: d.shopEmail,
      currencyCode: d.currencyCode,
      currencySymbol: d.currencySymbol,
      currencyDecimals: d.currencyDecimals,
      receiptFooter: d.receiptFooter,
      receiptPaperWidthMm: d.receiptPaperWidthMm,
      taxEnabled: d.taxEnabled,
      taxLabel: d.taxLabel,
      taxRateBps: d.taxRateBps,
      allowNegativeStock: d.allowNegativeStock,
      lowStockDefault: d.lowStockDefault,
      sizes: d.sizes,
      backupAutoEnabled: s['backup.auto_enabled'] === '1',
      backupIntervalHours: Number(s['backup.interval_hours'] ?? 24),
      backupKeepCount: Number(s['backup.keep_count'] ?? 14),
      backupDirectory: s['backup.directory'] ?? '',
    };
  }

  update(actor: Actor, patch: Partial<SettingsDto>): SettingsDto {
    assertCan(actor, 'settings.write');
    const before = this.get(actor);
    const writes: Array<[string, string]> = [];
    const changed: Record<string, { from: unknown; to: unknown }> = {};

    const set = (field: keyof SettingsDto, key: string, value: string | number | boolean | string[]): void => {
      const stored = typeof value === 'boolean' ? (value ? '1' : '0') : Array.isArray(value) ? JSON.stringify(value) : String(value);
      writes.push([key, stored]);
      changed[field] = { from: before[field], to: value };
    };
    const intIn = (v: unknown, label: string, min: number, max: number): number => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
        throw new AppError('VALIDATION', `${label} must be a whole number between ${min} and ${max}.`, label);
      }
      return v;
    };

    if (patch.shopName !== undefined) set('shopName', 'shop.name', text(patch.shopName, 'Shop name', 80, true));
    if (patch.shopAddress !== undefined) set('shopAddress', 'shop.address', text(patch.shopAddress, 'Address', 200));
    if (patch.shopPhone !== undefined) set('shopPhone', 'shop.phone', text(patch.shopPhone, 'Phone', 40));
    if (patch.shopEmail !== undefined) set('shopEmail', 'shop.email', text(patch.shopEmail, 'Email', 120));
    if (patch.receiptFooter !== undefined) set('receiptFooter', 'receipt.footer', text(patch.receiptFooter, 'Receipt footer', 200));
    if (patch.currencyCode !== undefined) {
      const code = text(patch.currencyCode, 'Currency code', 5, true).toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) throw new AppError('VALIDATION', 'Currency code must be 3 letters, e.g. LKR.', 'currencyCode');
      set('currencyCode', 'currency.code', code);
    }
    if (patch.currencySymbol !== undefined) set('currencySymbol', 'currency.symbol', text(patch.currencySymbol, 'Currency symbol', 8));
    if (patch.currencyDecimals !== undefined && patch.currencyDecimals !== before.currencyDecimals) {
      const decimals = intIn(patch.currencyDecimals, 'Decimal places', 0, 4);
      // Stored amounts are integer minor units: changing the scale later would silently re-price everything.
      const hasMoney =
        (this.db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n > 0 ||
        (this.db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n > 0 ||
        (this.db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number }).n > 0;
      if (hasMoney) {
        throw new AppError(
          'CONFLICT',
          'Decimal places cannot be changed once products, sales or expenses exist, because stored amounts would be misread.',
          'currencyDecimals',
        );
      }
      set('currencyDecimals', 'currency.decimals', decimals);
    }
    if (patch.receiptPaperWidthMm !== undefined) {
      if (patch.receiptPaperWidthMm !== 58 && patch.receiptPaperWidthMm !== 80) {
        throw new AppError('VALIDATION', 'Receipt paper width must be 58 mm or 80 mm.', 'receiptPaperWidthMm');
      }
      set('receiptPaperWidthMm', 'receipt.paper_width_mm', patch.receiptPaperWidthMm);
    }
    if (patch.taxEnabled !== undefined) set('taxEnabled', 'tax.enabled', Boolean(patch.taxEnabled));
    if (patch.taxLabel !== undefined) set('taxLabel', 'tax.label', text(patch.taxLabel, 'Tax label', 20, true));
    if (patch.taxRateBps !== undefined) set('taxRateBps', 'tax.rate_bps', intIn(patch.taxRateBps, 'Tax rate', 0, 10_000));
    if (patch.allowNegativeStock !== undefined) set('allowNegativeStock', 'inventory.allow_negative_stock', Boolean(patch.allowNegativeStock));
    if (patch.lowStockDefault !== undefined) set('lowStockDefault', 'inventory.low_stock_default', intIn(patch.lowStockDefault, 'Low-stock default', 0, 100_000));
    if (patch.sizes !== undefined) {
      const sizes = patch.sizes.map((s) => text(s, 'Size', 20, true));
      if (sizes.length === 0 || sizes.length > 30) throw new AppError('VALIDATION', 'Provide between 1 and 30 sizes.', 'sizes');
      if (new Set(sizes.map((s) => s.toLowerCase())).size !== sizes.length) {
        throw new AppError('VALIDATION', 'Sizes must be unique.', 'sizes');
      }
      set('sizes', 'inventory.sizes', sizes);
    }
    if (patch.backupAutoEnabled !== undefined) set('backupAutoEnabled', 'backup.auto_enabled', Boolean(patch.backupAutoEnabled));
    if (patch.backupIntervalHours !== undefined) set('backupIntervalHours', 'backup.interval_hours', intIn(patch.backupIntervalHours, 'Backup interval', 1, 720));
    if (patch.backupKeepCount !== undefined) set('backupKeepCount', 'backup.keep_count', intIn(patch.backupKeepCount, 'Backups to keep', 1, 365));
    if (patch.backupDirectory !== undefined) {
      const dir = text(patch.backupDirectory, 'Backup folder', 500);
      if (dir && !path.isAbsolute(dir)) throw new AppError('VALIDATION', 'Backup folder must be an absolute path.', 'backupDirectory');
      set('backupDirectory', 'backup.directory', dir);
    }

    this.db.transaction(() => {
      for (const [key, value] of writes) this.repo.set(key, value);
      if (writes.length) writeAudit(this.db, actor, 'settings.update', 'settings', '', changed);
    })();
    return this.get(actor);
  }

  // ───────────── payment methods ─────────────
  listPaymentMethods(actor: Actor, includeInactive = false): PaymentMethodDto[] {
    if (includeInactive) assertCan(actor, 'settings.read');
    const rows = this.db
      .prepare(
        `SELECT code, name, is_cash, reference_mode, is_active, sort_order FROM payment_methods
          ${includeInactive ? '' : 'WHERE is_active = 1'} ORDER BY sort_order, name COLLATE NOCASE`,
      )
      .all() as Array<{ code: string; name: string; is_cash: number; reference_mode: PaymentMethodDto['referenceMode']; is_active: number; sort_order: number }>;
    return rows.map((r) => ({
      code: r.code,
      name: r.name,
      isCash: r.is_cash === 1,
      referenceMode: r.reference_mode,
      isActive: r.is_active === 1,
      sortOrder: r.sort_order,
    }));
  }

  savePaymentMethod(actor: Actor, req: Omit<PaymentMethodDto, 'sortOrder'> & { sortOrder?: number }): PaymentMethodDto[] {
    assertCan(actor, 'settings.write');
    const name = text(req.name, 'Name', 40, true);
    const code = text(req.code, 'Code', 30).toLowerCase() || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!/^[a-z0-9_]{2,30}$/.test(code)) throw new AppError('VALIDATION', 'Code may use lowercase letters, numbers and underscores.', 'code');
    if (!['none', 'optional', 'required'].includes(req.referenceMode)) {
      throw new AppError('VALIDATION', 'Choose how payment references are handled.', 'referenceMode');
    }
    const existing = this.db.prepare('SELECT code, is_cash FROM payment_methods WHERE code = ?').get(code) as
      | { code: string; is_cash: number }
      | undefined;

    this.db.transaction(() => {
      if (existing) {
        if (req.isActive === false) {
          const active = (this.db.prepare('SELECT COUNT(*) AS n FROM payment_methods WHERE is_active = 1 AND code <> ?').get(code) as { n: number }).n;
          if (active === 0) throw new AppError('CONFLICT', 'At least one payment method must stay active.');
        }
        // `is_cash` decides whether change is calculated; don't let history change meaning.
        this.db
          .prepare('UPDATE payment_methods SET name = ?, reference_mode = ?, is_active = ?, sort_order = COALESCE(?, sort_order) WHERE code = ?')
          .run(name, req.referenceMode, req.isActive ? 1 : 0, req.sortOrder ?? null, code);
        writeAudit(this.db, actor, 'payment_method.update', 'payment_method', code, { name, isActive: req.isActive });
      } else {
        const next = (this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM payment_methods').get() as { n: number }).n;
        this.db
          .prepare('INSERT INTO payment_methods (code, name, is_cash, reference_mode, is_active, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
          .run(code, name, req.isCash ? 1 : 0, req.referenceMode, req.isActive ? 1 : 0, req.sortOrder ?? next);
        writeAudit(this.db, actor, 'payment_method.create', 'payment_method', code, { name, isCash: req.isCash });
      }
    })();
    return this.listPaymentMethods(actor, true);
  }

  listDiscountCodes(actor: Actor): DiscountCodeDto[] {
    assertCan(actor, 'settings.read');
    return (this.db.prepare('SELECT code,kind,amount,minimum_minor AS minimumMinor,usage_limit AS usageLimit,usage_count AS usageCount,is_active AS isActive FROM discount_codes ORDER BY code COLLATE NOCASE').all() as Array<Omit<DiscountCodeDto,'isActive'> & {isActive:number}>).map(r=>({...r,isActive:r.isActive===1}));
  }

  saveDiscountCode(actor: Actor, req: Omit<DiscountCodeDto,'usageCount'>): DiscountCodeDto[] {
    assertCan(actor, 'settings.write');
    const code=text(req.code,'Code',32,true).toUpperCase();
    if(!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new AppError('VALIDATION','Use 2–32 letters, numbers, hyphens or underscores for a code.','code');
    if(!Number.isInteger(req.amount)||req.amount<=0||(req.kind==='percent'&&req.amount>10000)) throw new AppError('VALIDATION','Discount amount is invalid.','amount');
    if(req.kind==='fixed'&&req.amount>100_000_000_000) throw new AppError('VALIDATION','Discount amount is too large.','amount');
    if(req.usageLimit!==null&&(!Number.isInteger(req.usageLimit)||req.usageLimit<1)) throw new AppError('VALIDATION','Usage limit must be a positive whole number or unlimited.','usageLimit');
    this.db.prepare(`INSERT INTO discount_codes(code,kind,amount,minimum_minor,usage_limit,is_active) VALUES(?,?,?,?,?,?)
      ON CONFLICT(code) DO UPDATE SET kind=excluded.kind,amount=excluded.amount,minimum_minor=excluded.minimum_minor,usage_limit=excluded.usage_limit,is_active=excluded.is_active,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(code,req.kind,req.amount,req.minimumMinor,req.usageLimit,req.isActive?1:0);
    writeAudit(this.db,actor,'discount_code.save','discount_code',code,{kind:req.kind,amount:req.amount,isActive:req.isActive});
    return this.listDiscountCodes(actor);
  }
}
