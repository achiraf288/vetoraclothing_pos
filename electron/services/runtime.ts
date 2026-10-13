import type { DatabaseHandle } from '../db/database-service';
import type { RestoreResult } from '../shared/api';
import { AuthService } from './auth-service';
import { BackupService, restoreDatabase } from './backup-service';
import { CatalogService } from './catalog-service';
import { DashboardService } from './dashboard-service';
import { ExpenseService } from './expense-service';
import { InventoryService } from './inventory-service';
import type { Actor } from './permissions';
import { PurchasingService } from './purchasing-service';
import { AuditService, ReportService } from './report-service';
import { ReturnsService } from './returns-service';
import { SalesService } from './sales-service';
import { SettingsService } from './settings-service';
import { OrdersService } from './orders-service';

/**
 * Owns the database connection and every service built on it. A restore swaps
 * the underlying database file, so all services are rebuilt afterwards (also
 * after a failed restore, because the old connection was closed).
 */
export class Runtime {
  auth!: AuthService;
  settings!: SettingsService;
  catalog!: CatalogService;
  dashboard!: DashboardService;
  inventory!: InventoryService;
  purchasing!: PurchasingService;
  sales!: SalesService;
  returns!: ReturnsService;
  orders!: OrdersService;
  expenses!: ExpenseService;
  reports!: ReportService;
  audit!: AuditService;
  readonly backup: BackupService;

  constructor(
    public handle: DatabaseHandle,
    private readonly dirs: { dataDir: string; backupDir: string },
  ) {
    this.backup = new BackupService(() => this.handle.db, dirs.backupDir);
    this.build();
  }

  private build(): void {
    const db = this.handle.db;
    this.auth = new AuthService(db);
    this.settings = new SettingsService(db);
    this.catalog = new CatalogService(db);
    this.dashboard = new DashboardService(db);
    this.inventory = new InventoryService(db);
    this.purchasing = new PurchasingService(db);
    this.sales = new SalesService(db, this.auth);
    this.returns = new ReturnsService(db);
    this.orders = new OrdersService(db);
    this.expenses = new ExpenseService(db);
    this.reports = new ReportService(db, this.inventory);
    this.audit = new AuditService(db);
  }

  /** Signed-in user, or throws UNAUTHENTICATED. */
  actor(): Actor {
    return this.auth.requireActor();
  }

  restore(sourceFile: string, actor: Actor): RestoreResult {
    try {
      const { handle, result } = restoreDatabase({
        live: this.handle,
        dataDir: this.dirs.dataDir,
        backupDir: this.dirs.backupDir,
        sourceFile,
        backups: this.backup,
        actor,
      });
      this.handle = handle;
      return result;
    } finally {
      // Always rebuild: the previous connection is closed. The session is dropped,
      // so the user signs in again against the restored data.
      this.build();
    }
  }

  close(): void {
    try {
      this.handle.db.close();
    } catch {
      /* already closed */
    }
  }
}
