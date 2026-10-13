import type { Migration } from '../migrator';
import { migration001 } from './001_initial';
import { migration002 } from './002_orders';
import { migration003 } from './003_discount_codes';
import { migration004 } from './004_order_financials';
import { migration005 } from './005_order_discount_codes';
import { migration006 } from './006_order_refunds';
import { migration007 } from './007_local_report_dates';

/** Ordered, append-only. Never edit a migration once released; add a new one. */
export const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007];
