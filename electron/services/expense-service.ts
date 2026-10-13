import type { Db } from '../db/connection';
import { writeAudit } from '../db/audit';
import { AppError } from '../main/errors';
import type { ExpenseCategoryDto, ExpenseDto, ExpenseInput, ExpensePage, ExpenseQuery } from '../shared/api';
import { assertCan, type Actor } from './permissions';
import { dateRange, isoDate, pageParams, positiveMinor, text } from './validate';

const EXPENSE_SELECT = `
  SELECT e.id, e.category_id AS categoryId, c.name AS categoryName, e.expense_date AS expenseDate,
         e.amount_minor AS amountMinor, e.payment_method_code AS paymentMethodCode, pm.name AS paymentMethodName,
         e.notes, e.voided_at AS voidedAt, COALESCE(u.username, '') AS createdBy
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    LEFT JOIN payment_methods pm ON pm.code = e.payment_method_code
    LEFT JOIN users u ON u.id = e.created_by`;

export class ExpenseService {
  constructor(private readonly db: Db) {}

  list(actor: Actor, query: ExpenseQuery = {}): ExpensePage {
    assertCan(actor, 'expenses.manage');
    const { page, pageSize, offset } = pageParams(query.page, query.pageSize);
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.from && query.to) {
      const r = dateRange(query.from, query.to);
      where.push('e.expense_date BETWEEN ? AND ?');
      params.push(r.from, r.to);
    }
    if (query.categoryId) {
      where.push('e.category_id = ?');
      params.push(query.categoryId);
    }
    if (!query.includeVoided) where.push('e.voided_at IS NULL');
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const agg = this.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN e.voided_at IS NULL THEN e.amount_minor ELSE 0 END), 0) AS total FROM expenses e ${w}`)
      .get(...params) as { n: number; total: number };
    const items = this.db
      .prepare(`${EXPENSE_SELECT} ${w} ORDER BY e.expense_date DESC, e.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset) as Array<Omit<ExpenseDto, never>>;
    return { items, total: agg.n, page, pageSize, totalMinor: agg.total };
  }

  private get(id: number): ExpenseDto {
    const e = this.db.prepare(`${EXPENSE_SELECT} WHERE e.id = ?`).get(id) as ExpenseDto | undefined;
    if (!e) throw new AppError('NOT_FOUND', 'Expense not found.');
    return e;
  }

  save(actor: Actor, req: ExpenseInput): ExpenseDto {
    assertCan(actor, 'expenses.manage');
    const date = isoDate(req.expenseDate, 'Date');
    const amount = positiveMinor(req.amountMinor, 'Amount');
    const notes = text(req.notes, 'Notes', 300);
    const cat = this.db.prepare('SELECT is_active FROM expense_categories WHERE id = ?').get(req.categoryId) as { is_active: number } | undefined;
    if (!cat) throw new AppError('VALIDATION', 'Choose a category.', 'categoryId');
    if (!cat.is_active && req.id === undefined) throw new AppError('VALIDATION', 'That category is inactive.', 'categoryId');
    if (req.paymentMethodCode && !this.db.prepare('SELECT 1 FROM payment_methods WHERE code = ?').get(req.paymentMethodCode)) {
      throw new AppError('VALIDATION', 'Unknown payment method.', 'paymentMethodCode');
    }

    const id = this.db.transaction((): number => {
      if (req.id === undefined) {
        const newId = Number(
          this.db
            .prepare('INSERT INTO expenses (category_id, expense_date, amount_minor, payment_method_code, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
            .run(req.categoryId, date, amount, req.paymentMethodCode ?? null, notes, actor.userId).lastInsertRowid,
        );
        writeAudit(this.db, actor, 'expense.create', 'expense', newId, { amount, date, categoryId: req.categoryId });
        return newId;
      }
      const existing = this.db.prepare('SELECT amount_minor, expense_date, voided_at FROM expenses WHERE id = ?').get(req.id) as
        | { amount_minor: number; expense_date: string; voided_at: string | null }
        | undefined;
      if (!existing) throw new AppError('NOT_FOUND', 'Expense not found.');
      if (existing.voided_at) throw new AppError('IMMUTABLE', 'A voided expense cannot be edited.');
      this.db
        .prepare(
          `UPDATE expenses SET category_id = ?, expense_date = ?, amount_minor = ?, payment_method_code = ?, notes = ?,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        )
        .run(req.categoryId, date, amount, req.paymentMethodCode ?? null, notes, req.id);
      writeAudit(this.db, actor, 'expense.update', 'expense', req.id, {
        amount: { from: existing.amount_minor, to: amount },
        date: { from: existing.expense_date, to: date },
      });
      return req.id;
    })();
    return this.get(id);
  }

  /** Expenses are voided, never deleted, so reports stay reconcilable. */
  void(actor: Actor, id: number): ExpenseDto {
    assertCan(actor, 'expenses.manage');
    this.db.transaction(() => {
      const e = this.db.prepare('SELECT amount_minor, voided_at FROM expenses WHERE id = ?').get(id) as
        | { amount_minor: number; voided_at: string | null }
        | undefined;
      if (!e) throw new AppError('NOT_FOUND', 'Expense not found.');
      if (e.voided_at) throw new AppError('CONFLICT', 'This expense is already voided.');
      this.db.prepare(`UPDATE expenses SET voided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(id);
      writeAudit(this.db, actor, 'expense.void', 'expense', id, { amount: e.amount_minor });
    })();
    return this.get(id);
  }

  listCategories(actor: Actor): ExpenseCategoryDto[] {
    assertCan(actor, 'expenses.manage');
    const rows = this.db.prepare('SELECT id, name, is_active FROM expense_categories ORDER BY name COLLATE NOCASE').all() as Array<{
      id: number; name: string; is_active: number;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, isActive: r.is_active === 1 }));
  }

  saveCategory(actor: Actor, req: { id?: number; name: string; isActive?: boolean }): ExpenseCategoryDto[] {
    assertCan(actor, 'expenses.manage');
    const name = text(req.name, 'Name', 60, true);
    if (this.db.prepare('SELECT 1 FROM expense_categories WHERE name = ? AND id IS NOT ?').get(name, req.id ?? null)) {
      throw new AppError('DUPLICATE', 'A category with that name already exists.', 'name');
    }
    this.db.transaction(() => {
      if (req.id === undefined) {
        const id = Number(this.db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(name).lastInsertRowid);
        writeAudit(this.db, actor, 'expense_category.create', 'expense_category', id, { name });
      } else {
        if (!this.db.prepare('SELECT 1 FROM expense_categories WHERE id = ?').get(req.id)) throw new AppError('NOT_FOUND', 'Category not found.');
        this.db
          .prepare('UPDATE expense_categories SET name = ?, is_active = COALESCE(?, is_active) WHERE id = ?')
          .run(name, req.isActive === undefined ? null : req.isActive ? 1 : 0, req.id);
        writeAudit(this.db, actor, 'expense_category.update', 'expense_category', req.id, { name, isActive: req.isActive });
      }
    })();
    return this.listCategories(actor);
  }
}
