import type { Db } from '../db/index.js'

/**
 * جداول المراجعة الذاتية والتقييم — مملوكة لهذه الوحدة (لا تعدّل schema.sql المشترك).
 * idempotent: تُنفّذ مرة لكل اتصال عند أول حاجة.
 */
export const SELFREVIEW_SCHEMA = `
CREATE TABLE IF NOT EXISTS eval_cases (
  id             SERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner_message  TEXT NOT NULL,
  context_turns  JSONB NOT NULL DEFAULT '[]',
  expected       JSONB NOT NULL DEFAULT '{}',
  source         TEXT NOT NULL CHECK (source IN ('selfreview','manual','seed')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','draft','retired')),
  modality       TEXT NOT NULL DEFAULT 'text' CHECK (modality IN ('text','voice'))
);
CREATE UNIQUE INDEX IF NOT EXISTS eval_cases_dedupe ON eval_cases (source, md5(owner_message || context_turns::text));

-- مخرجات النموذج المرفوضة (JSON/schema) — لقياس نسبة الرفض لكل نموذج (كانت في السجل فقط)
CREATE TABLE IF NOT EXISTS llm_rejections (
  id         SERIAL PRIMARY KEY,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider   TEXT,
  model      TEXT,
  purpose    TEXT NOT NULL,
  attempt    INT NOT NULL,
  error      TEXT NOT NULL,
  raw        TEXT
);
CREATE INDEX IF NOT EXISTS llm_rejections_ts_idx ON llm_rejections (ts);

CREATE TABLE IF NOT EXISTS self_reviews (
  id             SERIAL PRIMARY KEY,
  day            TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversations  INT NOT NULL,
  failures       INT NOT NULL,
  items          JSONB NOT NULL DEFAULT '[]',
  message        TEXT NOT NULL,
  pending_nos    JSONB NOT NULL DEFAULT '[]',
  clustered_by   TEXT NOT NULL DEFAULT 'rules'
);
CREATE INDEX IF NOT EXISTS self_reviews_day_idx ON self_reviews (day);
`

const ready = new WeakSet<Db>()

export async function ensureSelfReviewSchema(db: Db): Promise<void> {
  if (ready.has(db)) return
  await db.exec(SELFREVIEW_SCHEMA)
  ready.add(db)
}
