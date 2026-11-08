import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { RESERVATION_STATES } from '../shared/types.js';

export type Db = Database.Database;

const states = RESERVATION_STATES.map((s) => `'${s}'`).join(',');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  product_name TEXT NOT NULL,
  unit_price TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  is_template INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  duration INTEGER NOT NULL CHECK (duration >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('work','ship_batch')),
  batch_number INTEGER,
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS dependency (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  id INTEGER NOT NULL,
  from_task INTEGER NOT NULL,
  to_task INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'FS' CHECK (type = 'FS'),
  PRIMARY KEY (workspace_id, id)
);
CREATE TABLE IF NOT EXISTS batch (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  number INTEGER NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity > 0),
  PRIMARY KEY (workspace_id, number)
);
CREATE TABLE IF NOT EXISTS reservation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  batch_number INTEGER,
  state TEXT NOT NULL CHECK (state IN (${states})),
  message TEXT,
  buyer_email TEXT,
  buyer_name TEXT,
  paypal_customer_id TEXT,
  vault_id TEXT,
  setup_token_id TEXT UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  charged_at TEXT,
  order_id TEXT,
  capture_id TEXT UNIQUE,
  refund_id TEXT
);
CREATE INDEX IF NOT EXISTS reservation_ws ON reservation(workspace_id, state);
CREATE TABLE IF NOT EXISTS charge_attempt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  reservation_id TEXT NOT NULL REFERENCES reservation(id),
  attempt_no INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  amount TEXT NOT NULL,
  ship_date TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('PENDING','COMPLETED','DECLINED','FAILED','REVOKED','UNKNOWN','SKIPPED')),
  http_status INTEGER,
  paypal_debug_id TEXT,
  order_id TEXT,
  capture_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (reservation_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS charge_attempt_ws ON charge_attempt(workspace_id, id);
`;

/** Columns added after the first schema shipped. Applied idempotently on open. */
const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'task', column: 'constraint_type', ddl: 'ALTER TABLE task ADD COLUMN constraint_type TEXT' },
  { table: 'task', column: 'constraint_date', ddl: 'ALTER TABLE task ADD COLUMN constraint_date TEXT' },
  { table: 'workspace', column: 'plan_version', ddl: 'ALTER TABLE workspace ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 1' },
];

export function openDb(file = process.env.DATABASE_PATH ?? 'data/batchday.db'): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  for (const m of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl);
  }
  return db;
}
