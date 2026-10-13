import { app, BrowserWindow, dialog } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkIntegrity } from '../db/connection';
import type { AppInfo, BackupPick, ProductDetail } from '../shared/api';
import { ImageStore } from '../services/image-store';
import type { Runtime } from '../services/runtime';
import { assertCan } from '../services/permissions';
import { AppError } from './errors';
import { handle, type IpcContext } from './ipc';
import * as S from './schemas';

interface Env {
  ctx: IpcContext;
  runtime: Runtime;
  images: ImageStore;
  paths: { logDir: string; backupDir: string };
}

const parentWindow = (): BrowserWindow | undefined => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

/**
 * Registers every IPC channel. Each handler: validates input (zod) → resolves the
 * signed-in actor from the main-process session → calls a service, which enforces
 * permissions and business rules. The renderer never supplies its own identity.
 */
export function registerAllIpc(env: Env): void {
  const { ctx, runtime: rt, images } = env;
  const actor = () => rt.actor();
  // Backup files the renderer may act on: those we list, plus ones the user picked in a dialog.
  const pickedBackups = new Set<string>();
  const allowedBackup = (file: string): string => {
    const resolved = path.resolve(file);
    const known = rt.backup.list().some((b) => path.resolve(b.file) === resolved);
    if (!known && !pickedBackups.has(resolved)) {
      throw new AppError('FORBIDDEN', 'Choose the backup file from the list or with the file picker.');
    }
    return resolved;
  };

  // ───────────── app ─────────────
  handle(ctx, 'app:getInfo', S.none, (): AppInfo => {
    const h = rt.handle;
    const sqlite = (h.db.prepare('select sqlite_version() as v').get() as { v: string }).v;
    const schemaVersion = (h.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations').get() as { v: number }).v;
    return {
      name: app.getName(), version: app.getVersion(), platform: process.platform, arch: process.arch,
      electron: process.versions.electron, sqlite, schemaVersion,
      databasePath: h.file, logPath: env.paths.logDir, backupDirectory: rt.backup.directory(),
      upgradedFromVersion: h.migration.applied.length ? h.migration.fromVersion : null,
    };
  });

  // ───────────── auth ─────────────
  handle(ctx, 'auth:status', S.none, () => rt.auth.status());
  handle(ctx, 'auth:setupAdmin', S.auth.setupAdmin, (i) => rt.auth.setupAdmin(i));
  handle(ctx, 'auth:login', S.auth.login, (i) => rt.auth.login(i));
  handle(ctx, 'auth:logout', S.none, () => { rt.auth.logout(); return null; });
  handle(ctx, 'auth:changePassword', S.auth.changePassword, (i) => { rt.auth.changePassword(actor(), i); return null; });
  handle(ctx, 'auth:listUsers', S.none, () => rt.auth.listUsers(actor()));
  handle(ctx, 'auth:createUser', S.auth.createUser, (i) => rt.auth.createUser(actor(), i));
  handle(ctx, 'auth:updateUser', S.auth.updateUser, (i) => rt.auth.updateUser(actor(), i));
  handle(ctx, 'auth:resetPassword', S.auth.resetPassword, (i) => { rt.auth.resetPassword(actor(), i); return null; });

  // ───────────── settings ─────────────
  handle(ctx, 'settings:getDisplay', S.none, () => { actor(); return rt.settings.getDisplay(); });
  handle(ctx, 'settings:get', S.none, () => rt.settings.get(actor()));
  handle(ctx, 'settings:update', S.settings.update, (i) => rt.settings.update(actor(), i));
  handle(ctx, 'settings:listPaymentMethods', S.optBool, (i) => rt.settings.listPaymentMethods(actor(), i ?? false));
  handle(ctx, 'settings:savePaymentMethod', S.settings.savePaymentMethod, (i) => rt.settings.savePaymentMethod(actor(), i));
  handle(ctx, 'settings:listDiscountCodes', S.none, () => rt.settings.listDiscountCodes(actor()));
  handle(ctx, 'settings:saveDiscountCode', S.settings.saveDiscountCode, (i) => rt.settings.saveDiscountCode(actor(), i));

  // ───────────── dashboard ─────────────
  handle(ctx, 'dashboard:get', S.none, () => rt.dashboard.get(actor()));

  // ───────────── catalogue ─────────────
  handle(ctx, 'catalog:listCategories', S.none, () => rt.catalog.listCategories(actor()));
  handle(ctx, 'catalog:saveCategory', S.catalog.saveCategory, (i) => rt.catalog.saveCategory(actor(), i));
  handle(ctx, 'catalog:listProducts', S.catalog.listProducts, (i) => rt.catalog.listProducts(actor(), i));
  handle(ctx, 'catalog:getProduct', S.idOnly, (i) => rt.catalog.getProduct(actor(), i));
  handle(ctx, 'catalog:checkSku', S.catalog.checkSku, (i) => ({ available: rt.catalog.checkSku(actor(), i.sku, i.excludeProductId ?? null) }));
  handle(ctx, 'catalog:createProduct', S.catalog.createProduct, (i) => rt.catalog.createProduct(actor(), i));
  handle(ctx, 'catalog:updateProduct', S.catalog.updateProduct, (i) => rt.catalog.updateProduct(actor(), i.id, i.product));
  handle(ctx, 'catalog:setProductArchived', S.catalog.setArchived, (i) => rt.catalog.setProductArchived(actor(), i.id, i.archived));
  handle(ctx, 'catalog:createVariant', S.catalog.createVariant, (i) => rt.catalog.createVariant(actor(), i.productId, i.variant));
  handle(ctx, 'catalog:updateVariant', S.catalog.updateVariant, (i) => rt.catalog.updateVariant(actor(), i.id, i.variant));
  handle(ctx, 'catalog:setVariantArchived', S.catalog.setArchived, (i) => rt.catalog.setVariantArchived(actor(), i.id, i.archived));
  handle(ctx, 'catalog:getHistory', S.idOnly, (i) => rt.catalog.getHistory(actor(), i));

  handle(ctx, 'catalog:pickProductImage', S.idOnly, async (productId): Promise<ProductDetail | null> => {
    const a = actor();
    assertCan(a, 'catalog.write');
    const win = parentWindow();
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a product image',
      properties: ['openFile'],
      filters: [{ name: 'Images (PNG, JPG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    let stored: string;
    try {
      stored = images.import(res.filePaths[0]);
    } catch (err) {
      const code = (err as Error).message;
      if (code === 'IMAGE_TOO_LARGE') throw new AppError('VALIDATION', 'That image is larger than 5 MB.');
      if (code === 'UNSUPPORTED_IMAGE') throw new AppError('VALIDATION', 'Only PNG, JPG and WebP images are supported.');
      throw new AppError('VALIDATION', 'That file could not be used as an image.');
    }
    try {
      const { previous } = rt.catalog.setImagePath(a, productId, stored);
      images.remove(previous);
    } catch (err) {
      images.remove(stored); // do not leave an orphan file behind
      throw err;
    }
    return rt.catalog.getProduct(a, productId);
  });
  handle(ctx, 'catalog:removeProductImage', S.idOnly, (productId) => {
    const a = actor();
    const { previous } = rt.catalog.setImagePath(a, productId, null);
    images.remove(previous);
    return rt.catalog.getProduct(a, productId);
  });

  // ───────────── inventory ─────────────
  handle(ctx, 'inventory:listStock', S.inventory.listStock, (i) => rt.inventory.listStock(actor(), i));
  handle(ctx, 'inventory:listMovements', S.inventory.listMovements, (i) => rt.inventory.listMovements(actor(), i));
  handle(ctx, 'inventory:adjust', S.inventory.adjust, (i) => rt.inventory.adjust(actor(), i));
  handle(ctx, 'inventory:valuation', S.none, () => rt.inventory.valuation(actor()));

  // ───────────── suppliers & purchases ─────────────
  handle(ctx, 'suppliers:list', S.optBool, (i) => rt.purchasing.listSuppliers(actor(), i ?? false));
  handle(ctx, 'suppliers:save', S.suppliers.save, (i) => rt.purchasing.saveSupplier(actor(), i));
  handle(ctx, 'purchases:list', S.purchases.list, (i) => rt.purchasing.listPurchases(actor(), i));
  handle(ctx, 'purchases:get', S.idOnly, (i) => rt.purchasing.getPurchase(actor(), i));
  handle(ctx, 'purchases:saveDraft', S.purchases.saveDraft, (i) => rt.purchasing.saveDraft(actor(), i));
  handle(ctx, 'purchases:receive', S.purchases.receive, (i) => rt.purchasing.receive(actor(), i));
  handle(ctx, 'purchases:cancel', S.idOnly, (i) => rt.purchasing.cancel(actor(), i));
  handle(ctx, 'purchases:createSupplierReturn', S.purchases.supplierReturn, (i) => rt.purchasing.createSupplierReturn(actor(), i));
  handle(ctx, 'purchases:listSupplierReturns', S.purchases.listSupplierReturns, (i) => rt.purchasing.listSupplierReturns(actor(), i));

  // ───────────── sales ─────────────
  handle(ctx, 'sales:previewDiscount', S.sales.previewDiscount, (i) => rt.sales.previewDiscount(actor(), i));
  handle(ctx, 'sales:lookup', S.sales.lookup, (i) => rt.sales.lookup(actor(), i));
  handle(ctx, 'sales:scan', S.sales.scan, (i) => rt.sales.scan(actor(), i));
  handle(ctx, 'sales:checkout', S.sales.checkout, (i) => rt.sales.checkout(actor(), i));
  handle(ctx, 'sales:list', S.sales.list, (i) => rt.sales.list(actor(), i));
  handle(ctx, 'sales:get', S.idOnly, (i) => rt.sales.get(actor(), i));
  handle(ctx, 'sales:receipt', S.idOnly, (i) => rt.sales.receipt(actor(), i));
  handle(ctx, 'sales:cancel', S.sales.cancel, (i) => rt.sales.cancel(actor(), i));

  // ───────────── online and phone orders ─────────────
  handle(ctx, 'orders:list', S.orders.list, (i) => rt.orders.list(actor(), i));
  handle(ctx, 'orders:create', S.orders.create, (i) => rt.orders.create(actor(), i));
  handle(ctx, 'orders:updateStatus', S.orders.updateStatus, (i) => rt.orders.updateStatus(actor(), i));
  handle(ctx, 'orders:settleCourier', S.orders.settleCourier, (i) => rt.orders.settleCourier(actor(), i));

  // ───────────── returns ─────────────
  handle(ctx, 'returns:getReturnable', S.idOnly, (i) => rt.returns.getReturnable(actor(), i));
  handle(ctx, 'returns:create', S.returns.create, (i) => rt.returns.create(actor(), i));
  handle(ctx, 'returns:list', S.returns.list, (i) => rt.returns.list(actor(), i));

  // ───────────── expenses ─────────────
  handle(ctx, 'expenses:list', S.expenses.list, (i) => rt.expenses.list(actor(), i));
  handle(ctx, 'expenses:save', S.expenses.save, (i) => rt.expenses.save(actor(), i));
  handle(ctx, 'expenses:void', S.idOnly, (i) => rt.expenses.void(actor(), i));
  handle(ctx, 'expenses:listCategories', S.none, () => rt.expenses.listCategories(actor()));
  handle(ctx, 'expenses:saveCategory', S.expenses.saveCategory, (i) => rt.expenses.saveCategory(actor(), i));

  // ───────────── reports ─────────────
  handle(ctx, 'reports:sales', S.reports.sales, (i) => rt.reports.sales(actor(), i));
  handle(ctx, 'reports:bestSellers', S.reports.bestSellers, (i) => rt.reports.bestSellers(actor(), i));
  handle(ctx, 'reports:lowStock', S.none, () => rt.reports.lowStock(actor()));
  handle(ctx, 'reports:purchases', S.reports.purchases, (i) => rt.reports.purchases(actor(), i));
  handle(ctx, 'reports:operations', S.reports.operations, (i) => rt.reports.operations(actor(), i));
  handle(ctx, 'reports:exportCsv', S.reports.exportCsv, async (i) => {
    const { fileName, content } = rt.reports.buildCsv(actor(), i);
    const win = parentWindow();
    const opts: Electron.SaveDialogOptions = {
      title: 'Save report as CSV',
      defaultPath: path.join(app.getPath('documents'), fileName),
      filters: [{ name: 'CSV file', extensions: ['csv'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { saved: false };
    // UTF-8 BOM so Excel opens non-ASCII text correctly.
    fs.writeFileSync(res.filePath, '﻿' + content, 'utf8');
    return { saved: true, path: res.filePath };
  });

  // ───────────── audit ─────────────
  handle(ctx, 'audit:list', S.audit.list, (i) => rt.audit.list(actor(), i));

  // ───────────── backup ─────────────
  handle(ctx, 'backup:list', S.none, () => rt.backup.list(actor()));
  handle(ctx, 'backup:create', S.none, () => rt.backup.createBackup('manual', actor()));
  handle(ctx, 'backup:chooseDirectory', S.none, async () => {
    assertCan(actor(), 'backup.manage');
    const win = parentWindow();
    const opts: Electron.OpenDialogOptions = { title: 'Choose a backup folder', properties: ['openDirectory', 'createDirectory'] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });
  handle(ctx, 'backup:pickFile', S.none, async (): Promise<BackupPick | null> => {
    assertCan(actor(), 'backup.manage');
    const win = parentWindow();
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a backup to restore',
      defaultPath: rt.backup.directory(),
      properties: ['openFile'],
      filters: [{ name: 'Vetora POS backup', extensions: ['sqlite'] }],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || res.filePaths.length === 0) return null;
    const file = path.resolve(res.filePaths[0]);
    pickedBackups.add(file);
    const { validateBackupFile } = await import('../services/backup-service');
    return { file, name: path.basename(file), validation: validateBackupFile(file) };
  });
  handle(ctx, 'backup:validate', S.backup.file, async (file) => {
    assertCan(actor(), 'backup.manage');
    const { validateBackupFile } = await import('../services/backup-service');
    return validateBackupFile(allowedBackup(file));
  });
  handle(ctx, 'backup:restore', S.backup.file, (file) => {
    const a = actor();
    assertCan(a, 'backup.manage');
    const result = rt.restore(allowedBackup(file), a);
    ctx.logger.info('Database restored from backup', { from: path.basename(result.restoredFrom) });
    return result;
  });
  handle(ctx, 'backup:runIntegrityCheck', S.none, () => {
    assertCan(actor(), 'backup.manage');
    return checkIntegrity(rt.handle.db, 'full');
  });
}

