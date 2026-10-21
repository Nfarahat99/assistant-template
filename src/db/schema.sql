-- مساعد سراج — كل الجداول قابلة لإعادة التنفيذ

-- منع التكرار: الوسيط قد يعيد إرسال نفس الرسالة
CREATE TABLE IF NOT EXISTS inbound_seen (
  message_id  TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- المحادثة: آخر الأدوار تُعطى للنموذج كسياق
CREATE TABLE IF NOT EXISTS turns (
  id         SERIAL PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  notes       TEXT,
  priority    TEXT,                 -- low | normal | high
  source      TEXT,
  due_at      TIMESTAMPTZ,
  remind_at   TIMESTAMPTZ,          -- التذكير = مهمة لها موعد تنبيه
  reminded_at TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tasks_remind_idx ON tasks (remind_at) WHERE status='open' AND reminded_at IS NULL;

CREATE TABLE IF NOT EXISTS contacts (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,  -- دائماً بالصيغة الدولية 9665...
  aliases    TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- كل ما يحتاج موافقة صريحة من المالك: إرسال لطرف ثالث، طلب تعديل كود، دمج PR، تغيير جهة محفوظة
-- short_no من تسلسل لا يُعاد استخدامه أبداً: "نعم 3" لا يمكن أن تصيب طلباً غير الذي رآه المالك
CREATE SEQUENCE IF NOT EXISTS pending_short_no_seq;
CREATE TABLE IF NOT EXISTS pending (
  id            SERIAL PRIMARY KEY,
  short_no      INT NOT NULL UNIQUE DEFAULT nextval('pending_short_no_seq'),
  kind          TEXT NOT NULL CHECK (kind IN ('send_whatsapp','code_change','merge_pr','save_contact','railway_redeploy','db_write','group_reply','project_items')),
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','expired')),
  origin_msg_id TEXT,               -- رسالة المالك التي أنشأته (null = أنشأه مؤقت، مثل PR جاهز)
  preview_gw_id TEXT,               -- معرّف رسالة المعاينة في الوسيط
  preview_wa_id TEXT,               -- معرّفها في واتساب (للرد بالاقتباس) — يُجلب عند الحاجة
  preview_sent_at TIMESTAMPTZ,      -- متى أُرسلت المعاينة فعلاً — الموافقة يجب أن تأتي بعده
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  decided_at    TIMESTAMPTZ
);

-- رسائل الأطراف الثالثة: نتابع حالتها في الوسيط حتى الوصول أو الفشل
ALTER TABLE pending ADD COLUMN IF NOT EXISTS preview_sent_at TIMESTAMPTZ;

-- إعادة نشر Railway نوع جديد من الطلبات المعلّقة: نوسّع القيد (idempotent)
ALTER TABLE pending DROP CONSTRAINT IF EXISTS pending_kind_check;
ALTER TABLE pending ADD CONSTRAINT pending_kind_check
  CHECK (kind IN ('send_whatsapp','code_change','merge_pr','save_contact','railway_redeploy','db_write','group_reply','project_items'));

CREATE TABLE IF NOT EXISTS outbound (
  id          SERIAL PRIMARY KEY,
  gateway_id  TEXT,
  to_phone    TEXT NOT NULL,
  to_name     TEXT,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
  eta_notified BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- طلبات تعديل الكود عبر GitHub Actions — تُستأنف بعد إعادة التشغيل
CREATE TABLE IF NOT EXISTS code_jobs (
  request_id     TEXT PRIMARY KEY,
  project        TEXT NOT NULL,
  repo           TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  request        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'dispatched',
    -- dispatched | awaiting_merge | merged | closed | failed | timeout
  run_id         BIGINT,
  run_url        TEXT,
  pr_number      INT,
  pr_url         TEXT,
  dispatched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- إعدادات صغيرة وحالة المجدول
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- محادثات الأطراف الثالثة (وارد وصادر) — "وش قال أحمد؟" تقرأ من هنا.
-- نصوصهم بيانات فقط: لا تدخل سياق فهم أوامر المالك أبداً.
CREATE TABLE IF NOT EXISTS contact_messages (
  id           SERIAL PRIMARY KEY,
  phone        TEXT NOT NULL,
  name         TEXT,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind         TEXT NOT NULL DEFAULT 'text',
  text         TEXT NOT NULL,
  message_id   TEXT,
  known        BOOLEAN NOT NULL DEFAULT true,   -- جهة محفوظة أو راسلناها خلال ٣٠ يوماً
  created_at   TIMESTAMPTZ NOT NULL,
  forwarded_at TIMESTAMPTZ,                      -- متى حُوّلت للمالك (للمعروفين)
  digested_at  TIMESTAMPTZ                       -- متى ذُكرت في الملخص المسائي (للمجهولين)
);
CREATE INDEX IF NOT EXISTS contact_messages_phone_idx ON contact_messages (phone, created_at);

-- "تبي أرد؟" — آخر رسالة محوّلة يمكن الرد عليها برقم الاقتراح أو "رد: نص"
CREATE TABLE IF NOT EXISTS reply_prompts (
  id          SERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  name        TEXT NOT NULL,
  contact_id  INT,
  suggestions JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at  TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- رسائل للمالك أثناء انقطاع واتساب — تُرسل مجمّعة عند الرجوع (لا نكدّس طابور الوسيط)
CREATE TABLE IF NOT EXISTS owner_outbox (
  id         SERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at    TIMESTAMPTZ
);

-- استهلاك الذكاء الاصطناعي: كل استدعاء LLM/STT/بحث (لوحة التحكم + تنبيهات الحصة)
CREATE TABLE IF NOT EXISTS usage_events (
  id            SERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  input_tokens  INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  audio_seconds REAL,
  latency_ms    INT NOT NULL DEFAULT 0,
  ok            BOOLEAN NOT NULL,
  error         TEXT,
  est_list_usd  REAL NOT NULL DEFAULT 0,
  est_cost_usd  REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events (ts);

-- رسائل المالك التي وصلت والحصة خالصة — تُعالج بعد تجدّد الحصة
CREATE TABLE IF NOT EXISTS deferred_messages (
  id           SERIAL PRIMARY KEY,
  text         TEXT NOT NULL,
  channel      TEXT NOT NULL,
  task_id      INT,
  created_at   TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ
);

-- عدّاد الرسائل لكل قناة (لوحة التحكم)
CREATE TABLE IF NOT EXISTS msg_events (
  id        SERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL,
  channel   TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind      TEXT NOT NULL DEFAULT 'text'
);
CREATE INDEX IF NOT EXISTS msg_events_ts_idx ON msg_events (ts);

ALTER TABLE turns ADD COLUMN IF NOT EXISTS channel TEXT;

-- التحقق من النشر بعد الدمج (Railway)
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS merge_sha TEXT;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS deploy_status TEXT;      -- pending | deploying | success | failed | not_connected | timeout | none
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS deploy_state JSONB;      -- لكل خدمة: {status, deploymentId, notified...}
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS deploy_id TEXT;
ALTER TABLE code_jobs ADD COLUMN IF NOT EXISTS deploy_url TEXT;


-- سجل الوصول لقواعد بيانات المشاريع: كل قراءة ومعاينة وتنفيذ (بدون نتائج — SQL وعدد الصفوف فقط)
CREATE TABLE IF NOT EXISTS db_audit (
  id        SERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL,
  db_key    TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('read','preview','write')),
  sql       TEXT NOT NULL,
  row_count INT,
  ok        BOOLEAN NOT NULL,
  error     TEXT
);
CREATE INDEX IF NOT EXISTS db_audit_ts_idx ON db_audit (ts);

-- مسودات المهام التي تحتاج اللابتوب (Claude Code محلياً): تُجهَّز بتوجيه جاهز للمراجعة ثم التنفيذ
CREATE TABLE IF NOT EXISTS laptop_drafts (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL,
  details    TEXT,
  project    TEXT,
  agent      TEXT,                       -- مفتاح الوكيل المقترح (mohammed | sami | ...)
  brief      TEXT,                       -- التوجيه الجاهز للصق
  status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('draft','ready','done','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- موجز AI: الروابط المرسلة (مطبّعة) — منع التكرار بين الأيام وبين التشغيل المجدول وعند الطلب
CREATE TABLE IF NOT EXISTS news_sent (
  url_norm TEXT PRIMARY KEY,
  title    TEXT NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_sent_at_idx ON news_sent (sent_at);

-- متتبّع مشاريع البزنس: بنود كل مشروع (إطلاق، دومين، تسويق…) — project_key = المستودع (owner/name) أو custom:<اسم>
CREATE TABLE IF NOT EXISTS project_items (
  id            SERIAL PRIMARY KEY,
  project_key   TEXT NOT NULL,
  project_label TEXT NOT NULL,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('launch','domain','marketing','feature','sales','content','admin','other')),
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','dropped')),
  priority      INT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),   -- 1 عالية، 2 عادية، 3 منخفضة
  due_date      DATE,
  notes         TEXT,
  position      INT,                                                       -- ترتيب قبله المالك داخل المشروع
  source        TEXT NOT NULL DEFAULT 'owner',                             -- owner | suggestion | checklist
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS project_items_open_idx ON project_items (project_key) WHERE status IN ('todo','doing');

-- ملف المشروع التجاري: المرحلة والجمهور ونموذج الدخل (كلها اختيارية)
CREATE TABLE IF NOT EXISTS project_profiles (
  project_key   TEXT PRIMARY KEY,
  project_label TEXT NOT NULL,
  stage         TEXT CHECK (stage IN ('idea','building','ready','launched','growing','paused')),
  audience      TEXT,
  revenue_model TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- بوابة قواعد البيانات لـ Claude في GitHub Actions (قراءة فقط): مصدر الاستعلام والمستودع ورقم الطلب والغرض
ALTER TABLE db_audit ADD COLUMN IF NOT EXISTS source     TEXT NOT NULL DEFAULT 'owner';   -- owner | ci
ALTER TABLE db_audit ADD COLUMN IF NOT EXISTS repo       TEXT;
ALTER TABLE db_audit ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE db_audit ADD COLUMN IF NOT EXISTS purpose    TEXT;
CREATE INDEX IF NOT EXISTS db_audit_ci_repo_idx ON db_audit (repo, ts) WHERE source = 'ci';
CREATE INDEX IF NOT EXISTS db_audit_ci_req_idx ON db_audit (request_id) WHERE source = 'ci';

-- التذكيرات المتكررة (عادات يومية: ورد، قراءة كتاب…): JSON مثل {"kind":"daily","time":"21:00"} — انظر src/lib/recurrence.ts
-- المهمة المتكررة تبقى مفتوحة، وremind_at/due_at = الموعد القادم دائماً
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence TEXT;

-- إنجازات المواعيد المتكررة (يوم بيوم) — للسلسلة (streak) والتقرير الأسبوعي
CREATE TABLE IF NOT EXISTS task_occurrences (
  id        SERIAL PRIMARY KEY,
  task_id   INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  occ_date  DATE NOT NULL,                      -- تاريخ الموعد بتوقيت المالك
  status    TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','skipped')),
  done_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (task_id, occ_date)
);

