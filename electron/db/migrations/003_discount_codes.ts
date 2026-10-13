export const migration003 = {
  version: 3,
  name: 'discount_codes',
  sql: `
ALTER TABLE sales ADD COLUMN discount_code TEXT NOT NULL DEFAULT '';
CREATE TABLE discount_codes (
  code TEXT PRIMARY KEY COLLATE NOCASE CHECK (length(trim(code)) BETWEEN 2 AND 32),
  kind TEXT NOT NULL CHECK (kind IN ('fixed','percent')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  minimum_minor INTEGER NOT NULL DEFAULT 0 CHECK (minimum_minor >= 0),
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind <> 'percent' OR amount <= 10000)
) STRICT, WITHOUT ROWID;
`,
};
