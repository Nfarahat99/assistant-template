import type { Db } from './db/index.js'
import { normalizeMsisdn } from './lib/phone.js'
import { bestMatches, normalizeArabic } from './lib/arabic.js'
import { maskSecrets } from './lib/secrets.js'

/** كل الوصول لقاعدة البيانات في مكان واحد — SQL صريح بلا ORM */

export interface Task {
  id: number; title: string; notes: string | null; priority: string | null; source: string | null
  due_at: Date | null; remind_at: Date | null; reminded_at: Date | null
  status: 'open' | 'done'; created_at: Date; done_at: Date | null
  /** تكرار (JSON — src/lib/recurrence.ts) أو null لمهمة لمرة واحدة */
  recurrence?: string | null
}
export interface Contact { id: number; name: string; phone: string; aliases: string[] }
export type PendingKind = 'send_whatsapp' | 'code_change' | 'merge_pr' | 'save_contact' | 'railway_redeploy' | 'db_write' | 'group_reply' | 'project_items'
export interface Pending {
  id: number; short_no: number; kind: PendingKind; payload: any; status: string
  origin_msg_id: string | null; preview_gw_id: string | null; preview_wa_id: string | null
  preview_sent_at: Date | null
  created_at: Date; expires_at: Date
}
const mapPending = (r: any): Pending => ({ ...r, payload: parseJson(r.payload), created_at: asDate(r.created_at)!, expires_at: asDate(r.expires_at)!, preview_sent_at: asDate(r.preview_sent_at) })
export interface CodeJob {
  request_id: string; project: string; repo: string; default_branch: string; request: string
  status: string; run_id: string | number | null; run_url: string | null; pr_number: number | null; pr_url: string | null
  dispatched_at: Date; updated_at: Date
  merge_sha?: string | null; merged_at?: Date | null
  deploy_status?: string | null; deploy_state?: any; deploy_id?: string | null; deploy_url?: string | null
}
const mapJob = (r: any): CodeJob => ({ ...r, dispatched_at: asDate(r.dispatched_at)!, updated_at: asDate(r.updated_at)!, merged_at: asDate(r.merged_at), deploy_state: parseJson(r.deploy_state) })
/** سؤال توضيحي مفتوح: كل خيار يحمل ما يكفي لاستئناف النية الأصلية */
export type ClarifyResume =
  | { kind: 'send_to_contact'; contact_id: number; text: string; direct?: boolean }
  | { kind: 'code_on_project'; repo: string; request: string }
  | { kind: 'complete_task'; task_id: number }
  | { kind: 'reprompt'; original: string; question: string; choice: string }
  | { kind: 'analyze_as'; phone: string; name: string; contact_id: number | null; text: string; source: string }
  | { kind: 'db_on'; key: string; mode: 'read' | 'write'; text: string }
  | { kind: 'code_search'; repo: string; term: string }
export interface ClarifyOption { label: string; resume: ClarifyResume }
export interface OpenClarify { question: string; options: ClarifyOption[]; created_at: string }
const CLARIFY_TTL_MS = 24 * 3600_000

export interface Outbound { id: number; gateway_id: string | null; to_phone: string; to_name: string | null; text: string; status: string; eta_notified: boolean; created_at: Date }

const asDate = (v: any) => (v == null ? null : v instanceof Date ? v : new Date(v))
const mapTask = (r: any): Task => ({ ...r, due_at: asDate(r.due_at), remind_at: asDate(r.remind_at), reminded_at: asDate(r.reminded_at), created_at: asDate(r.created_at)!, done_at: asDate(r.done_at) })
const mapDraft = (r: any): LaptopDraft => ({ ...r, created_at: asDate(r.created_at)!, updated_at: asDate(r.updated_at)! })
const parseJson = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v)

export interface DbAudit {
  id: number; ts: Date; db_key: string; kind: string; sql: string; row_count: number | null; ok: boolean; error: string | null
  source?: string; repo?: string | null; request_id?: string | null; purpose?: string | null
}
/** خطأ المحاولات المرفوضة لتجاوز حد بوابة CI — تُسجَّل لكنها لا تُحسب ضمن الحد نفسه */
export const CI_RATE_LIMITED = 'rate_limited'

export interface LaptopDraft {
  id: number; title: string; details: string | null; project: string | null; agent: string | null; brief: string | null
  status: 'draft' | 'ready' | 'done' | 'cancelled'; created_at: Date; updated_at: Date
}

export class Store {
  constructor(private db: Db) {}

  /** آخر نموذج ردّ بنجاح على محادثة — مصدر "على أي نموذج أنت؟" بعد إعادة التشغيل */
  async lastServedModel(): Promise<string | null> {
    const r = await this.db.query<{ provider: string; model: string }>(
      `SELECT provider, model FROM usage_events WHERE ok AND purpose IN ('chat','voice_chat') ORDER BY ts DESC LIMIT 1`)
    return r[0] ? `${r[0].provider} (${r[0].model})` : null
  }
  /** للوحدات التي تملك جداولها (متتبّع المشاريع) — نفس الاتصال */
  get conn(): Db { return this.db }

  // ───── سجل الوصول لقواعد المشاريع ─────
  /** كل قراءة/معاينة/تنفيذ على قواعد المشاريع — نجح أو فشل */
  async addDbAudit(a: {
    db_key: string; kind: 'read' | 'preview' | 'write'; sql: string; row_count?: number | null; ok: boolean; error?: string | null; ts: Date
    source?: 'owner' | 'ci'; repo?: string | null; request_id?: string | null; purpose?: string | null
  }) {
    await this.db.query(`INSERT INTO db_audit (ts, db_key, kind, sql, row_count, ok, error, source, repo, request_id, purpose) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [a.ts, a.db_key.slice(0, 60), a.kind, a.sql.slice(0, 4000), a.row_count ?? null, a.ok, a.error ? a.error.slice(0, 500) : null,
        a.source ?? 'owner', a.repo ?? null, a.request_id ?? null, a.purpose ? a.purpose.slice(0, 300) : null])
  }
  /** بوابة CI: الاستدعاءات المحسوبة على الحد — لرقم الطلب، وللمستودع منذ `since` (المرفوض لتجاوز الحد لا يُحسب) */
  async ciCallCounts(repo: string, requestId: string, since: Date): Promise<{ request: number; repoWindow: number }> {
    const [r] = await this.db.query<any>(
      `SELECT COUNT(*) FILTER (WHERE request_id = $2)::int AS request, COUNT(*) FILTER (WHERE ts >= $3)::int AS repo_window
         FROM db_audit WHERE source = 'ci' AND repo = $1 AND (error IS NULL OR error <> $4)`,
      [repo, requestId, since, CI_RATE_LIMITED])
    return { request: Number(r?.request ?? 0), repoWindow: Number(r?.repo_window ?? 0) }
  }
  /** كم مرة استعلم Claude (CI) لهذا الطلب ومن أي قواعد — لمعاينة الدمج (الاستعلامات الناجحة فقط، بلا طلبات المخطط) */
  async ciQueryStats(requestId: string): Promise<{ count: number; dbs: string[] }> {
    const rows = await this.db.query<any>(
      `SELECT db_key, COUNT(*)::int AS n FROM db_audit
        WHERE source = 'ci' AND request_id = $1 AND ok AND sql NOT LIKE '-- schema%' GROUP BY db_key ORDER BY db_key`, [requestId])
    return { count: rows.reduce((s, r) => s + Number(r.n), 0), dbs: rows.map((r) => String(r.db_key)) }
  }
  /** "استعلامات كلود": آخر استدعاءات CI */
  async recentCiAudit(n = 15): Promise<DbAudit[]> {
    const rows = await this.db.query<any>(`SELECT * FROM db_audit WHERE source = 'ci' ORDER BY id DESC LIMIT $1`, [n])
    return rows.map((r) => ({ ...r, ts: asDate(r.ts)! }))
  }
  async recentDbAudit(n = 50): Promise<DbAudit[]> {
    const rows = await this.db.query<any>(`SELECT * FROM db_audit ORDER BY id DESC LIMIT $1`, [n])
    return rows.map((r) => ({ ...r, ts: asDate(r.ts)! }))
  }

  // ───── مسودات اللابتوب ─────
  async addLaptopDraft(d: { title: string; details?: string | null; project?: string | null; agent?: string | null; brief?: string | null }): Promise<LaptopDraft> {
    const [r] = await this.db.query<any>(
      `INSERT INTO laptop_drafts (title, details, project, agent, brief, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.title, d.details ?? null, d.project ?? null, d.agent ?? null, d.brief ?? null, d.brief ? 'ready' : 'draft'])
    return mapDraft(r)
  }
  async getLaptopDraft(id: number): Promise<LaptopDraft | null> {
    const [r] = await this.db.query<any>(`SELECT * FROM laptop_drafts WHERE id=$1`, [id])
    return r ? mapDraft(r) : null
  }
  async laptopDrafts(includeClosed = false): Promise<LaptopDraft[]> {
    const rows = await this.db.query<any>(
      `SELECT * FROM laptop_drafts ${includeClosed ? '' : "WHERE status IN ('draft','ready')"} ORDER BY id ASC`)
    return rows.map(mapDraft)
  }
  async setLaptopDraftStatus(id: number, status: LaptopDraft['status']): Promise<LaptopDraft | null> {
    const [r] = await this.db.query<any>(`UPDATE laptop_drafts SET status=$2, updated_at=now() WHERE id=$1 RETURNING *`, [id, status])
    return r ? mapDraft(r) : null
  }

  // ───── منع التكرار ─────
  /** true = أول مرة نرى الرسالة */
  async markSeen(messageId: string): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO inbound_seen (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id`, [messageId])
    return rows.length === 1
  }

  // ───── المحادثة ─────
  async addTurn(role: 'user' | 'assistant', text: string) {
    // مفاتيح/توكنات (قراءة صورة، رد…) لا تُخزَّن في السجل أبداً — ولا تصل للنموذج منه
    await this.db.query(`INSERT INTO turns (role, text) VALUES ($1,$2)`, [role, maskSecrets(text).slice(0, 2000)])
  }
  async lastTurns(n = 10): Promise<{ role: 'user' | 'assistant'; text: string }[]> {
    const rows = await this.db.query<any>(`SELECT role, text FROM turns ORDER BY id DESC LIMIT $1`, [n])
    return rows.reverse()
  }

  /** رسائل المالك نفسه (لا ردود البوت) منذ since — الأقدم أولاً؛ بلا القروبات والمحتوى المحجوب */
  async ownerTurnsSince(since: Date, limit = 15): Promise<{ text: string; at: Date }[]> {
    const rows = await this.db.query<any>(
      `SELECT text, created_at FROM turns WHERE role='user' AND created_at >= $1
         AND text NOT LIKE '👥%' AND text NOT LIKE '↪️ (%' AND text NOT LIKE '🖼️ (%'
       ORDER BY id DESC LIMIT $2`, [since, limit])
    return rows.reverse().map((r) => ({ text: r.text, at: asDate(r.created_at)! }))
  }

  // ───── المهام ─────
  async addTask(t: { title: string; notes?: string; priority?: string; source?: string; due_at?: Date | null; remind_at?: Date | null; recurrence?: string | null }): Promise<Task> {
    const [r] = await this.db.query(
      `INSERT INTO tasks (title, notes, priority, source, due_at, remind_at, recurrence) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [t.title, t.notes ?? null, t.priority ?? null, t.source ?? null, t.due_at ?? null, t.remind_at ?? null, t.recurrence ?? null])
    return mapTask(r)
  }
  /** المهمة المتكررة: الموعد القادم (تذكير + استحقاق) ويُصفَّر "ذُكّر" — الموعد التالي يُذكَّر به من جديد */
  async rescheduleTask(id: number, next: Date) {
    await this.db.query(`UPDATE tasks SET remind_at=$2, due_at=$2, reminded_at=NULL WHERE id=$1 AND status='open'`, [id, next])
  }
  /** متكررة عالقة (ذُكّر بها ولم يُحسب موعدها التالي — توقف الخدمة بين الخطوتين مثلاً) */
  async stuckRecurring(): Promise<Task[]> {
    return (await this.db.query(`SELECT * FROM tasks WHERE status='open' AND recurrence IS NOT NULL AND reminded_at IS NOT NULL`)).map(mapTask)
  }
  /** يسجّل إنجاز موعد متكرر ليوم معيّن — true لأول تسجيل فقط */
  async addOccurrence(taskId: number, occDate: string, at: Date, status: 'done' | 'skipped' = 'done'): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO task_occurrences (task_id, occ_date, status, done_at) VALUES ($1,$2::date,$3,$4) ON CONFLICT (task_id, occ_date) DO NOTHING RETURNING id`,
      [taskId, occDate, status, at])
    return rows.length === 1
  }
  /** تواريخ المواعيد المنجزة (YYYY-MM-DD) منذ تاريخ */
  async occurrenceDates(taskId: number, since: string): Promise<string[]> {
    const rows = await this.db.query<{ d: string }>(
      `SELECT to_char(occ_date, 'YYYY-MM-DD') AS d FROM task_occurrences WHERE task_id=$1 AND status='done' AND occ_date >= $2::date ORDER BY occ_date`, [taskId, since])
    return rows.map((r) => r.d)
  }
  /** "وقف تذكير N": تُقفل المهمة (يبقى سجل إنجازاتها) ولا تذكيرات بعدها */
  async stopTask(id: number): Promise<Task | null> {
    const [r] = await this.db.query(
      `UPDATE tasks SET status='done', done_at=now(), remind_at=NULL, reminded_at=NULL WHERE id=$1 AND status='open' RETURNING *`, [id])
    return r ? mapTask(r) : null
  }
  async deleteTask(id: number): Promise<Task | null> {
    const [r] = await this.db.query(`DELETE FROM tasks WHERE id=$1 RETURNING *`, [id])
    return r ? mapTask(r) : null
  }
  async getTask(id: number): Promise<Task | null> {
    const [r] = await this.db.query(`SELECT * FROM tasks WHERE id=$1`, [id])
    return r ? mapTask(r) : null
  }
  /** المهام المفتوحة فقط — التذكيرات والمواعيد (source='reminder') لها قائمتها: openReminders */
  async openTasks(): Promise<Task[]> {
    return (await this.db.query(
      `SELECT * FROM tasks WHERE status='open' AND source IS DISTINCT FROM 'reminder' ORDER BY COALESCE(due_at, remind_at) ASC NULLS LAST, id ASC`)).map(mapTask)
  }
  async openReminders(): Promise<Task[]> {
    return (await this.db.query(
      `SELECT * FROM tasks WHERE status='open' AND source='reminder' ORDER BY COALESCE(due_at, remind_at) ASC NULLS LAST, id ASC`)).map(mapTask)
  }
  async completeTask(id: number): Promise<Task | null> {
    const [r] = await this.db.query(
      `UPDATE tasks SET status='done', done_at=now() WHERE id=$1 AND status='open' RETURNING *`, [id])
    return r ? mapTask(r) : null
  }
  /** مطابقة عنوان مهمة بكلمات من كلام المالك */
  async findOpenTasks(query: string): Promise<Task[]> {
    const q = normalizeArabic(query)
    const open = [...await this.openTasks(), ...await this.openReminders()]
    const byContains = open.filter((t) => normalizeArabic(t.title).includes(q))
    if (byContains.length) return byContains
    return bestMatches(query, open.map((t) => ({ t, names: [t.title] }))).map((x) => x.t)
  }
  /** يأخذ التذكيرات المستحقة ويعلّمها بنفس العبارة — نسختان من المجدول لا تذكّران مرتين */
  async claimDueReminders(now: Date): Promise<Task[]> {
    return (await this.db.query(
      `UPDATE tasks SET reminded_at=$1
        WHERE status='open' AND reminded_at IS NULL AND remind_at IS NOT NULL AND remind_at <= $1
        RETURNING *`, [now])).map(mapTask)
  }

  // ───── جهات الاتصال ─────
  async contacts(): Promise<Contact[]> {
    return this.db.query<Contact>(`SELECT id, name, phone, aliases FROM contacts ORDER BY name`)
  }
  /** يحفظ أو يحدّث (بالرقم) — الرقم يُطبّع دائماً للصيغة الدولية */
  async upsertContact(name: string, phoneRaw: string, aliases: string[] = [], cc = '966'): Promise<Contact | null> {
    const phone = normalizeMsisdn(phoneRaw, cc)
    if (!phone) return null
    const [r] = await this.db.query<Contact>(
      `INSERT INTO contacts (name, phone, aliases) VALUES ($1,$2,$3)
       ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name,
         aliases=(SELECT ARRAY(SELECT DISTINCT unnest(contacts.aliases || EXCLUDED.aliases)))
       RETURNING id, name, phone, aliases`,
      [name.trim(), phone, aliases])
    return r
  }
  async contactByPhone(phoneRaw: string, cc = '966'): Promise<Contact | null> {
    const phone = normalizeMsisdn(phoneRaw, cc)
    if (!phone) return null
    const [r] = await this.db.query<Contact>(`SELECT id, name, phone, aliases FROM contacts WHERE phone=$1`, [phone])
    return r ?? null
  }
  async getContact(id: number): Promise<Contact | null> {
    const [r] = await this.db.query<Contact>(`SELECT id, name, phone, aliases FROM contacts WHERE id=$1`, [id])
    return r ?? null
  }
  async matchContacts(query: string): Promise<Contact[]> {
    const all = await this.contacts()
    return bestMatches(query, all.map((c) => ({ c, names: [c.name, ...c.aliases] }))).map((x) => x.c)
  }

  // ───── الموافقات المعلّقة ─────
  /** ينقل المنتهية إلى expired ذرّياً ويعيدها — المجدول وحده يستدعيه (ليعالج انتهاء الدمج) */
  async expirePending(now: Date): Promise<Pending[]> {
    const rows = await this.db.query(
      `UPDATE pending SET status='expired', decided_at=$1 WHERE status='open' AND expires_at <= $1 RETURNING *`, [now])
    return rows.map(mapPending)
  }
  async addPending(kind: PendingKind, payload: unknown, now: Date, opts: { originMsgId?: string | null; ttlMs?: number } = {}): Promise<Pending> {
    const [r] = await this.db.query<any>(
      `INSERT INTO pending (kind, payload, origin_msg_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [kind, JSON.stringify(payload), opts.originMsgId ?? null, now, new Date(now.getTime() + (opts.ttlMs ?? 24 * 3600_000))])
    return mapPending(r)
  }
  /** المفتوحة وغير المنتهية — القراءة لا تغيّر الحالة */
  async openPending(now: Date): Promise<Pending[]> {
    const rows = await this.db.query<any>(`SELECT * FROM pending WHERE status='open' AND expires_at > $1 ORDER BY short_no`, [now])
    return rows.map(mapPending)
  }
  /** يغلق الطلب ذرّياً — لو سبقه ردّ آخر يرجع false فلا يُنفّذ مرتين */
  async decidePending(id: number, status: 'approved' | 'rejected', now: Date): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE pending SET status=$2, decided_at=$3 WHERE id=$1 AND status='open' AND expires_at > $3 RETURNING id`, [id, status, now])
    return rows.length === 1
  }
  /** التعديل يُعيد المعاينة، فيُعاد ضبط وقت الإنشاء والمصدر: الموافقة يجب أن تأتي بعد المعاينة الجديدة */
  async editPending(id: number, payload: unknown, now: Date, originMsgId: string | null) {
    await this.db.query(
      `UPDATE pending SET payload=$2, created_at=$3, origin_msg_id=$4, preview_gw_id=NULL, preview_wa_id=NULL, preview_sent_at=NULL WHERE id=$1`,
      [id, JSON.stringify(payload), now, originMsgId])
  }
  async setPreviewIds(ids: number[], gwId: string | null, sentAt: Date) {
    if (!ids.length) return
    await this.db.query(`UPDATE pending SET preview_gw_id=COALESCE($2, preview_gw_id), preview_sent_at=$3 WHERE id = ANY($1::int[])`, [ids, gwId, sentAt])
  }
  async setPreviewWaId(id: number, waId: string) {
    await this.db.query(`UPDATE pending SET preview_wa_id=$2 WHERE id=$1`, [id, waId])
  }

  // ───── رسائل الأطراف الثالثة ─────
  async addOutbound(o: { gateway_id: string | null; to_phone: string; to_name: string; text: string; status: string; created_at?: Date }): Promise<Outbound> {
    const [r] = await this.db.query<Outbound>(
      `INSERT INTO outbound (gateway_id, to_phone, to_name, text, status, created_at) VALUES ($1,$2,$3,$4,$5,COALESCE($6, now())) RETURNING *`,
      [o.gateway_id, o.to_phone, o.to_name, o.text, o.status, o.created_at ?? null])
    return r
  }
  async activeOutbound(): Promise<Outbound[]> {
    return this.db.query<Outbound>(`SELECT * FROM outbound WHERE status NOT IN ('sent','failed','unknown','link') ORDER BY id`)
  }
  /** ينهي الرسالة ذرّياً — true لأول من ينهيها فقط، فلا يُبلَّغ المالك مرتين */
  async finishOutbound(id: number, status: 'sent' | 'failed' | 'unknown'): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE outbound SET status=$2, updated_at=now() WHERE id=$1 AND status NOT IN ('sent','failed','unknown') RETURNING id`,
      [id, status])
    return rows.length === 1
  }
  async claimEtaNotice(id: number): Promise<boolean> {
    const rows = await this.db.query(`UPDATE outbound SET eta_notified=true WHERE id=$1 AND eta_notified=false RETURNING id`, [id])
    return rows.length === 1
  }
  async updateOutbound(id: number, fields: { status?: string; eta_notified?: boolean }) {
    await this.db.query(
      `UPDATE outbound SET status=COALESCE($2,status), eta_notified=COALESCE($3,eta_notified), updated_at=now() WHERE id=$1`,
      [id, fields.status ?? null, fields.eta_notified ?? null])
  }

  // ───── طلبات الكود ─────
  async addJob(j: { request_id: string; project: string; repo: string; default_branch: string; request: string; dispatched_at: Date }) {
    await this.db.query(
      `INSERT INTO code_jobs (request_id, project, repo, default_branch, request, dispatched_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [j.request_id, j.project, j.repo, j.default_branch, j.request, j.dispatched_at])
  }
  async getJob(id: string): Promise<CodeJob | null> {
    const [r] = await this.db.query<any>(`SELECT * FROM code_jobs WHERE request_id=$1`, [id])
    return r ? { ...r, dispatched_at: asDate(r.dispatched_at) } : null
  }
  /** بعد الدمج: نبدأ متابعة النشر */
  async startDeployWatch(id: string, sha: string, now: Date) {
    await this.db.query(
      `UPDATE code_jobs SET merge_sha=$2, merged_at=$3, deploy_status='pending', deploy_state='{}'::jsonb, updated_at=now() WHERE request_id=$1`, [id, sha, now])
  }
  async updateDeploy(id: string, f: { deploy_status?: string; deploy_state?: unknown; deploy_id?: string | null; deploy_url?: string | null }) {
    await this.db.query(
      `UPDATE code_jobs SET deploy_status=COALESCE($2,deploy_status), deploy_state=COALESCE($3::jsonb,deploy_state),
         deploy_id=COALESCE($4,deploy_id), deploy_url=COALESCE($5,deploy_url), updated_at=now() WHERE request_id=$1`,
      [id, f.deploy_status ?? null, f.deploy_state === undefined ? null : JSON.stringify(f.deploy_state), f.deploy_id ?? null, f.deploy_url ?? null])
  }
  async watchedDeploys(): Promise<CodeJob[]> {
    return (await this.db.query<any>(`SELECT * FROM code_jobs WHERE deploy_status IN ('pending','deploying') ORDER BY merged_at`)).map(mapJob)
  }
  async lastMergedJob(projectRepo?: string): Promise<CodeJob | null> {
    const [r] = await this.db.query<any>(
      `SELECT * FROM code_jobs WHERE status='merged' AND ($1::text IS NULL OR repo=$1) ORDER BY merged_at DESC NULLS LAST, updated_at DESC LIMIT 1`, [projectRepo ?? null])
    return r ? mapJob(r) : null
  }
  /** طلب بنفس النص على نفس المستودع شغال/ينتظر الدمج منذ since */
  async activeDuplicateJob(repo: string, normRequest: string, since: Date): Promise<CodeJob | null> {
    const rows = await this.db.query<any>(
      `SELECT * FROM code_jobs WHERE repo=$1 AND status IN ('dispatched','awaiting_merge') AND dispatched_at >= $2`, [repo, since])
    const norm = (s: string) => s.replace(/[ً-ٟـ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    const r = rows.find((x) => norm(x.request) === normRequest)
    return r ? mapJob(r) : null
  }
  async recentJobs(limit = 10): Promise<CodeJob[]> {
    const rows = await this.db.query<any>(`SELECT * FROM code_jobs ORDER BY dispatched_at DESC LIMIT $1`, [limit])
    return rows.map((r) => ({ ...r, dispatched_at: asDate(r.dispatched_at) }))
  }
  /** طلبات الكود على مستودع منذ since — الأحدث أولاً (سياق "طلبات سابقة ذات صلة") */
  async jobsForRepoSince(repo: string, since: Date, limit = 10): Promise<CodeJob[]> {
    const rows = await this.db.query<any>(
      `SELECT * FROM code_jobs WHERE lower(repo)=lower($1) AND dispatched_at >= $2 ORDER BY dispatched_at DESC LIMIT $3`, [repo, since, limit])
    return rows.map(mapJob)
  }
  async activeJobs(): Promise<CodeJob[]> {
    const rows = await this.db.query<any>(`SELECT * FROM code_jobs WHERE status='dispatched' ORDER BY dispatched_at`)
    return rows.map((r) => ({ ...r, dispatched_at: asDate(r.dispatched_at) }))
  }
  /** انتقال حالة مشروط: ينجح فقط إن كانت الحالة الحالية = from (يمنع الإشعار المكرر) */
  async transitionJob(id: string, from: string, to: string, f: { pr_number?: number; pr_url?: string } = {}): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE code_jobs SET status=$3, pr_number=COALESCE($4,pr_number), pr_url=COALESCE($5,pr_url), updated_at=now()
        WHERE request_id=$1 AND status=$2 RETURNING request_id`,
      [id, from, to, f.pr_number ?? null, f.pr_url ?? null])
    return rows.length === 1
  }
  async updateJob(id: string, f: Partial<Pick<CodeJob, 'status' | 'run_id' | 'run_url' | 'pr_number' | 'pr_url'>>) {
    await this.db.query(
      `UPDATE code_jobs SET status=COALESCE($2,status), run_id=COALESCE($3,run_id), run_url=COALESCE($4,run_url),
         pr_number=COALESCE($5,pr_number), pr_url=COALESCE($6,pr_url), updated_at=now() WHERE request_id=$1`,
      [id, f.status ?? null, f.run_id ?? null, f.run_url ?? null, f.pr_number ?? null, f.pr_url ?? null])
  }

  // ───── السؤال التوضيحي المفتوح (واحد فقط في كل وقت) ─────
  async setClarify(c: OpenClarify) { await this.setKv('open_clarify', JSON.stringify(c)) }
  async clearClarify() { await this.db.query(`DELETE FROM kv WHERE key='open_clarify'`) }
  async getClarify(now: Date): Promise<OpenClarify | null> {
    const raw = await this.getKv('open_clarify')
    if (!raw) return null
    const c = JSON.parse(raw) as OpenClarify
    if (now.getTime() - new Date(c.created_at).getTime() > CLARIFY_TTL_MS) { await this.clearClarify(); return null }
    return c
  }

  // ───── محادثات الأطراف الثالثة ─────
  async addContactMessage(m: { phone: string; name: string | null; direction: 'in' | 'out'; kind?: string; text: string; message_id?: string | null; known?: boolean; created_at: Date }) {
    await this.db.query(
      `INSERT INTO contact_messages (phone, name, direction, kind, text, message_id, known, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.phone, m.name, m.direction, m.kind ?? 'text', m.text.slice(0, 4000), m.message_id ?? null, m.known ?? true, m.created_at])
  }
  /** راسلناه نيابةً عن المالك خلال آخر ٣٠ يوماً؟ يرجع الاسم المستخدم حينها */
  async recentOutboundTo(phone: string, now: Date): Promise<{ to_name: string | null } | null> {
    const [r] = await this.db.query<{ to_name: string | null }>(
      `SELECT to_name FROM outbound WHERE to_phone=$1 AND created_at > $2 ORDER BY id DESC LIMIT 1`,
      [phone, new Date(now.getTime() - 30 * 86_400_000)])
    return r ?? null
  }
  /** الأرقام التي عندها رسائل معروفة لم تُحوَّل، وآخر رسالة منها أقدم من quietMs (انتهت "الدفعة") */
  async readyToForward(now: Date, quietMs = 60_000): Promise<string[]> {
    const rows = await this.db.query<{ phone: string }>(
      `SELECT phone FROM contact_messages WHERE direction='in' AND known AND forwarded_at IS NULL
        GROUP BY phone HAVING MAX(created_at) <= $1`, [new Date(now.getTime() - quietMs)])
    return rows.map((r) => r.phone)
  }
  /** يأخذ دفعة الرقم ويعلّمها محوّلة ذرّياً */
  async claimForward(phone: string, now: Date): Promise<{ name: string | null; kind: string; text: string; created_at: Date }[]> {
    const rows = await this.db.query<any>(
      `UPDATE contact_messages SET forwarded_at=$2
        WHERE phone=$1 AND direction='in' AND known AND forwarded_at IS NULL RETURNING name, kind, text, created_at, id`,
      [phone, now])
    return rows.sort((a, b) => a.id - b.id).map((r) => ({ ...r, created_at: asDate(r.created_at)! }))
  }
  async conversation(phone: string, limit = 12): Promise<{ direction: 'in' | 'out'; text: string; kind: string; created_at: Date }[]> {
    const rows = await this.db.query<any>(
      `SELECT direction, text, kind, created_at FROM contact_messages WHERE phone=$1 ORDER BY id DESC LIMIT $2`, [phone, limit])
    return rows.reverse().map((r) => ({ ...r, created_at: asDate(r.created_at)! }))
  }
  /** المجهولون الذين لم يُذكروا في ملخص بعد — تُعلَّم ذرّياً */
  async claimUnknownDigest(now: Date): Promise<{ phone: string; name: string | null; n: number }[]> {
    const rows = await this.db.query<any>(
      `UPDATE contact_messages SET digested_at=$1 WHERE direction='in' AND NOT known AND digested_at IS NULL RETURNING phone, name`, [now])
    const by = new Map<string, { phone: string; name: string | null; n: number }>()
    for (const r of rows) {
      const e = by.get(r.phone) ?? { phone: r.phone, name: r.name, n: 0 }
      e.n++; e.name = e.name ?? r.name
      by.set(r.phone, e)
    }
    return [...by.values()]
  }
  async unknownMessages(since: Date): Promise<{ phone: string; name: string | null; text: string; created_at: Date }[]> {
    const rows = await this.db.query<any>(
      `SELECT phone, name, text, created_at FROM contact_messages WHERE direction='in' AND NOT known AND created_at > $1 ORDER BY id LIMIT 30`, [since])
    return rows.map((r) => ({ ...r, created_at: asDate(r.created_at)! }))
  }

  /** هل راسل هذا الرقم البوت منذ since؟ (شرط الإرسال المباشر في وضع direct) */
  async messagedUsSince(phone: string, since: Date): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM contact_messages WHERE phone=$1 AND direction='in' AND created_at > $2 LIMIT 1`, [phone, since])
    return rows.length > 0
  }
  /** آخر من أرسل لهم المالك روابط (للتخمين: رسالة محوّلة غالباً رد من أحدهم) */
  async recentLinkTargets(now: Date, hours = 48): Promise<{ phone: string; name: string | null }[]> {
    const rows = await this.db.query<any>(
      `SELECT to_phone AS phone, MAX(to_name) AS name, MAX(id) AS last FROM outbound
        WHERE status='link' AND created_at > $1 GROUP BY to_phone ORDER BY last DESC LIMIT 5`,
      [new Date(now.getTime() - hours * 3600_000)])
    return rows.map((r) => ({ phone: r.phone, name: r.name }))
  }

  // ───── "تبي أرد؟" ─────
  async openReplyPrompt(p: { phone: string; name: string; contact_id: number | null; suggestions: string[]; now: Date }): Promise<number> {
    // رسالة محوّلة جديدة تحل محل السابقة: "1" تشير دائماً لآخر ما رآه المالك
    await this.db.query(`UPDATE reply_prompts SET status='done' WHERE status='open'`)
    const [r] = await this.db.query<{ id: number }>(
      `INSERT INTO reply_prompts (phone, name, contact_id, suggestions, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.phone, p.name, p.contact_id, JSON.stringify(p.suggestions), p.now, new Date(p.now.getTime() + 24 * 3600_000)])
    return r.id
  }
  async currentReplyPrompt(now: Date): Promise<{ id: number; phone: string; name: string; contact_id: number | null; suggestions: string[]; created_at: Date } | null> {
    const [r] = await this.db.query<any>(
      `SELECT * FROM reply_prompts WHERE status='open' AND expires_at > $1 ORDER BY id DESC LIMIT 1`, [now])
    return r ? { ...r, suggestions: parseJson(r.suggestions), created_at: asDate(r.created_at)! } : null
  }
  async closeReplyPrompt(id: number): Promise<boolean> {
    return (await this.db.query(`UPDATE reply_prompts SET status='done' WHERE id=$1 AND status='open' RETURNING id`, [id])).length === 1
  }

  // ───── صندوق رسائل المالك أثناء الانقطاع ─────
  async queueOwner(text: string, now: Date) {
    await this.db.query(`INSERT INTO owner_outbox (text, created_at) VALUES ($1,$2)`, [text, now])
  }
  async claimOwnerOutbox(now: Date): Promise<{ text: string; created_at: Date }[]> {
    const rows = await this.db.query<any>(`UPDATE owner_outbox SET sent_at=$1 WHERE sent_at IS NULL RETURNING id, text, created_at`, [now])
    return rows.sort((a, b) => a.id - b.id).map((r) => ({ text: r.text, created_at: asDate(r.created_at)! }))
  }

  // ───── الاستهلاك ─────
  async addUsage(e: { ts: Date; provider: string; model: string; purpose: string; input_tokens: number; output_tokens: number;
    audio_seconds: number | null; latency_ms: number; ok: boolean; error?: string | null; est_list_usd: number; est_cost_usd: number }) {
    await this.db.query(
      `INSERT INTO usage_events (ts, provider, model, purpose, input_tokens, output_tokens, audio_seconds, latency_ms, ok, error, est_list_usd, est_cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [e.ts, e.provider, e.model, e.purpose, e.input_tokens, e.output_tokens, e.audio_seconds, e.latency_ms, e.ok, e.error ?? null, e.est_list_usd, e.est_cost_usd])
  }
  /** استهلاك نموذج منذ لحظة (بداية يوم الحصة بتوقيت المحيط الهادئ) */
  async modelUsageSince(model: string, since: Date): Promise<{ requests: number; tokens: number }> {
    const [r] = await this.db.query<any>(
      `SELECT COUNT(*)::int AS requests, COALESCE(SUM(input_tokens + output_tokens),0)::int AS tokens
         FROM usage_events WHERE model=$1 AND ts >= $2`, [model, since])
    return { requests: Number(r?.requests ?? 0), tokens: Number(r?.tokens ?? 0) }
  }
  async usageTotals(since: Date, until?: Date): Promise<{ llm_calls: number; input_tokens: number; output_tokens: number; audio_seconds: number; est_cost_usd: number; est_list_usd: number }> {
    const [r] = await this.db.query<any>(
      `SELECT COUNT(*)::int AS llm_calls, COALESCE(SUM(input_tokens),0)::int AS input_tokens, COALESCE(SUM(output_tokens),0)::int AS output_tokens,
              COALESCE(SUM(audio_seconds),0)::float AS audio_seconds, COALESCE(SUM(est_cost_usd),0)::float AS est_cost_usd,
              COALESCE(SUM(est_list_usd),0)::float AS est_list_usd
         FROM usage_events WHERE ts >= $1 AND ($2::timestamptz IS NULL OR ts < $2)`, [since, until ?? null])
    return {
      llm_calls: Number(r.llm_calls), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens),
      audio_seconds: Math.round(Number(r.audio_seconds)), est_cost_usd: +Number(r.est_cost_usd).toFixed(4), est_list_usd: +Number(r.est_list_usd).toFixed(4),
    }
  }
  /** سلسلة يومية بتوقيت tz (آخر n يوماً) */
  async usageDaily(days: number, tz: string, now: Date): Promise<{ date: string; llm_calls: number; input_tokens: number; output_tokens: number }[]> {
    return this.db.query<any>(
      `SELECT to_char(date_trunc('day', ts AT TIME ZONE $1), 'YYYY-MM-DD') AS date, COUNT(*)::int AS llm_calls,
              COALESCE(SUM(input_tokens),0)::int AS input_tokens, COALESCE(SUM(output_tokens),0)::int AS output_tokens
         FROM usage_events WHERE ts >= $2 GROUP BY 1 ORDER BY 1`, [tz, new Date(now.getTime() - days * 86_400_000)])
  }

  // ───── رسائل مؤجلة (الحصة خالصة) ─────
  async deferMessage(text: string, channel: string, taskId: number | null, now: Date) {
    await this.db.query(`INSERT INTO deferred_messages (text, channel, task_id, created_at) VALUES ($1,$2,$3,$4)`, [text, channel, taskId, now])
  }
  async claimDeferred(now: Date): Promise<{ id: number; text: string; channel: string; task_id: number | null; created_at: Date }[]> {
    const rows = await this.db.query<any>(
      `UPDATE deferred_messages SET processed_at=$1 WHERE processed_at IS NULL RETURNING *`, [now])
    return rows.sort((a, b) => a.id - b.id).map((r) => ({ ...r, created_at: asDate(r.created_at)! }))
  }
  async hasDeferred(): Promise<boolean> {
    return (await this.db.query(`SELECT 1 FROM deferred_messages WHERE processed_at IS NULL LIMIT 1`)).length > 0
  }

  // ───── عدّاد الرسائل ─────
  async countMsg(channel: string, direction: 'in' | 'out', kind: string, now: Date) {
    await this.db.query(`INSERT INTO msg_events (ts, channel, direction, kind) VALUES ($1,$2,$3,$4)`, [now, channel, direction, kind])
  }

  // ───── موجز AI: الروابط المرسلة ─────
  async newsSentAmong(urls: string[]): Promise<Set<string>> {
    if (!urls.length) return new Set()
    const rows = await this.db.query<{ url_norm: string }>(`SELECT url_norm FROM news_sent WHERE url_norm = ANY($1::text[])`, [urls])
    return new Set(rows.map((r) => r.url_norm))
  }
  async newsRecentTitles(since: Date): Promise<string[]> {
    const rows = await this.db.query<{ title: string }>(`SELECT title FROM news_sent WHERE sent_at >= $1 ORDER BY sent_at DESC LIMIT 500`, [since])
    return rows.map((r) => r.title)
  }
  /** حجز ذرّي: يرجع ما أُدخل الآن فقط (المحجوز سابقاً لا يرجع) */
  async claimNewsUrls(items: { url_norm: string; title: string }[], at: Date): Promise<Set<string>> {
    const out = new Set<string>()
    for (const it of items) {
      const rows = await this.db.query<{ url_norm: string }>(
        `INSERT INTO news_sent (url_norm, title, sent_at) VALUES ($1,$2,$3) ON CONFLICT (url_norm) DO NOTHING RETURNING url_norm`, [it.url_norm, it.title, at])
      if (rows.length) out.add(it.url_norm)
    }
    return out
  }

  // ───── إعدادات ─────
  async getKv(key: string): Promise<string | null> {
    const [r] = await this.db.query<{ value: string }>(`SELECT value FROM kv WHERE key=$1`, [key])
    return r?.value ?? null
  }
  async setKv(key: string, value: string) {
    await this.db.query(`INSERT INTO kv (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, value])
  }
  async delKv(key: string) { await this.db.query(`DELETE FROM kv WHERE key=$1`, [key]) }
  /**
   * يضبط القيمة فقط إن تغيّرت، ويرجع true لمن غيّرها — عبارة واحدة ذرّية.
   * نستخدمه لـ "هل أُرسل ملخص اليوم؟": أول من يغيّر التاريخ هو من يرسل.
   */
  async claimKv(key: string, value: string): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO kv (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value WHERE kv.value IS DISTINCT FROM EXCLUDED.value
       RETURNING key`, [key, value])
    return rows.length === 1
  }
}
