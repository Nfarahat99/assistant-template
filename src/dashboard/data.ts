import type { Db } from '../db/index.js'
import { localParts, startOfLocalDay, zonedToDate } from '../lib/time.js'

/**
 * استعلامات لوحة التحكم (قراءة غالباً). SQL صريح على نفس الجداول التي يكتبها البوت —
 * لا نكرر منطق Store، فقط تجميعات لا يحتاجها البوت نفسه.
 */

const n = (v: unknown) => Number(v ?? 0)
const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())

/** مفتاح اليوم المحلي "YYYY-MM-DD" */
export function dayKey(d: Date, tz: string): string {
  const p = localParts(d, tz)
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
}
/** آخر `days` يوماً محلياً بالترتيب (الأقدم أولاً، اليوم آخراً) */
export function lastDays(now: Date, tz: string, days: number): string[] {
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(dayKey(startOfLocalDay(now, tz, -i), tz))
  return out
}
export function startOfLocalMonth(now: Date, tz: string): Date {
  const p = localParts(now, tz)
  return zonedToDate(p.y, p.mo, 1, 0, 0, tz)
}

// ───── الاستهلاك ─────
export interface UsageTotals { llm_calls: number; input_tokens: number; output_tokens: number; audio_seconds: number; est_cost_usd: number }

export async function usageTotals(db: Db, since: Date): Promise<UsageTotals> {
  const [r] = await db.query<any>(
    `SELECT COUNT(*)::int AS llm_calls, COALESCE(SUM(input_tokens),0)::bigint AS input_tokens, COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
            COALESCE(SUM(audio_seconds),0)::float AS audio_seconds, COALESCE(SUM(est_cost_usd),0)::float AS est_cost_usd
       FROM usage_events WHERE ts >= $1`, [since])
  return {
    llm_calls: n(r?.llm_calls), input_tokens: n(r?.input_tokens), output_tokens: n(r?.output_tokens),
    audio_seconds: Math.round(n(r?.audio_seconds)), est_cost_usd: +n(r?.est_cost_usd).toFixed(4),
  }
}

export async function usageDaily(db: Db, now: Date, tz: string, days = 30) {
  const keys = lastDays(now, tz, days)
  const rows = await db.query<any>(
    `SELECT to_char(ts AT TIME ZONE $1, 'YYYY-MM-DD') AS date, COUNT(*)::int AS llm_calls,
            COALESCE(SUM(input_tokens),0)::bigint AS input_tokens, COALESCE(SUM(output_tokens),0)::bigint AS output_tokens
       FROM usage_events WHERE ts >= $2 GROUP BY 1`, [tz, startOfLocalDay(now, tz, -(days - 1))])
  const by = new Map(rows.map((r) => [r.date, r]))
  return keys.map((date) => {
    const r = by.get(date)
    return { date, llm_calls: n(r?.llm_calls), input_tokens: n(r?.input_tokens), output_tokens: n(r?.output_tokens) }
  })
}

// ───── المهام ─────
export async function taskStats(db: Db, now: Date, tz: string) {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
  const [r] = await db.query<any>(
    `SELECT COUNT(*) FILTER (WHERE status='open')::int AS open,
            COUNT(*) FILTER (WHERE status='open' AND due_at < $1)::int AS overdue,
            COUNT(*) FILTER (WHERE status='done' AND done_at >= $2)::int AS done_7d,
            COUNT(*) FILTER (WHERE created_at >= $2)::int AS created_7d
       FROM tasks WHERE source IS DISTINCT FROM 'reminder'`, [now, weekAgo])
  const keys = lastDays(now, tz, 14)
  const since = startOfLocalDay(now, tz, -13)
  const created = await db.query<any>(
    `SELECT to_char(created_at AT TIME ZONE $1, 'YYYY-MM-DD') AS date, COUNT(*)::int AS c FROM tasks WHERE source IS DISTINCT FROM 'reminder' AND created_at >= $2 GROUP BY 1`, [tz, since])
  const done = await db.query<any>(
    `SELECT to_char(done_at AT TIME ZONE $1, 'YYYY-MM-DD') AS date, COUNT(*)::int AS c FROM tasks WHERE source IS DISTINCT FROM 'reminder' AND status='done' AND done_at >= $2 GROUP BY 1`, [tz, since])
  const cm = new Map(created.map((x) => [x.date, n(x.c)])), dm = new Map(done.map((x) => [x.date, n(x.c)]))
  return {
    open: n(r?.open), overdue: n(r?.overdue), done_7d: n(r?.done_7d), created_7d: n(r?.created_7d),
    daily: keys.map((date) => ({ date, created: cm.get(date) ?? 0, done: dm.get(date) ?? 0 })),
  }
}

export interface TaskOut {
  id: number; title: string; notes: string | null; priority: string | null; source: string | null
  due_at: string | null; remind_at: string | null; status: string; created_at: string | null; done_at: string | null
}
export const mapTask = (r: any): TaskOut => ({
  id: r.id, title: r.title, notes: r.notes, priority: r.priority, source: r.source,
  due_at: iso(r.due_at), remind_at: iso(r.remind_at), status: r.status, created_at: iso(r.created_at), done_at: iso(r.done_at),
})

export type TaskFilter = 'open' | 'overdue' | 'done' | 'all'
export async function listTasks(db: Db, status: TaskFilter, q: string, now: Date): Promise<TaskOut[]> {
  const where: string[] = [`source IS DISTINCT FROM 'reminder'`]
  const params: unknown[] = []
  if (status === 'open') where.push(`status='open'`)
  if (status === 'done') where.push(`status='done'`)
  if (status === 'overdue') { params.push(now); where.push(`status='open' AND due_at < $${params.length}`) }
  if (q) {
    params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`)
    where.push(`(title ILIKE $${params.length} OR COALESCE(notes,'') ILIKE $${params.length})`)
  }
  const rows = await db.query<any>(
    `SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (status='done') ASC,
               CASE WHEN status='open' THEN COALESCE(due_at, remind_at) END ASC NULLS LAST,
               done_at DESC NULLS LAST, id DESC
      LIMIT 500`, params)
  return rows.map(mapTask)
}

// ───── الرسائل ─────
export async function messageStats(db: Db, now: Date, tz: string) {
  const today = startOfLocalDay(now, tz)
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
  // عدّاد القنوات (msg_events) إن كان يُكتب، وإلا أدوار المحادثة — نأخذ الأكبر
  const [t] = await db.query<any>(
    `SELECT COUNT(*) FILTER (WHERE role='user')::int AS inn, COUNT(*) FILTER (WHERE role='assistant')::int AS out
       FROM turns WHERE created_at >= $1`, [today])
  const [e] = await db.query<any>(
    `SELECT COUNT(*) FILTER (WHERE direction='in')::int AS inn, COUNT(*) FILTER (WHERE direction='out')::int AS out
       FROM msg_events WHERE ts >= $1`, [today])
  const [o] = await db.query<any>(
    `SELECT COUNT(*) FILTER (WHERE status='link' AND created_at >= $1)::int AS links_7d FROM outbound`, [weekAgo])
  return {
    in_today: Math.max(n(t?.inn), n(e?.inn)),
    out_today: Math.max(n(t?.out), n(e?.out)),
    links_7d: n(o?.links_7d),
  }
}

// ───── طلبات الكود ─────
const RUNNING = ['dispatched', 'queued', 'pending', 'running', 'in_progress']
export async function jobStats(db: Db, now: Date) {
  const since = new Date(now.getTime() - 30 * 86_400_000)
  const [r] = await db.query<any>(
    `SELECT COUNT(*) FILTER (WHERE status = ANY($2::text[]))::int AS running,
            COUNT(*) FILTER (WHERE status IN ('awaiting_merge','pr_open','awaiting_approval'))::int AS awaiting_merge,
            COUNT(*) FILTER (WHERE status IN ('merged','deployed') AND updated_at >= $1)::int AS merged_30d,
            COUNT(*) FILTER (WHERE status IN ('failed','error','timeout') AND updated_at >= $1)::int AS failed_30d
       FROM code_jobs`, [since, RUNNING])
  return { running: n(r?.running), awaiting_merge: n(r?.awaiting_merge), merged_30d: n(r?.merged_30d), failed_30d: n(r?.failed_30d) }
}

export async function listJobs(db: Db, limit = 100): Promise<any[]> {
  return db.query<any>(`SELECT * FROM code_jobs ORDER BY dispatched_at DESC LIMIT $1`, [limit])
}

// ───── المحادثات ─────
export async function conversations(db: Db, limit: number) {
  const rows = await db.query<any>(`SELECT id, role, text, channel, created_at FROM turns ORDER BY id DESC LIMIT $1`, [limit])
  return rows.map((r) => ({
    id: r.id, role: r.role === 'user' ? 'owner' : 'bot', text: r.text, channel: r.channel ?? null, created_at: iso(r.created_at),
  }))
}

export { iso }
