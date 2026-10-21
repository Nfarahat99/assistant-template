/**
 * متتبّع المشاريع (بزنس لا تقني): بنود كل مشروع — إطلاق، دومين، تسويق، ميزة، مبيعات، محتوى، إداري —
 * ومرحلة كل مشروع (فكرة ← بناء ← جاهز ← مطلق ← نمو / متوقف).
 * هنا: الأنواع، الوصول للقاعدة، والدوال الصافية (الترتيب والتنسيق) — بلا نموذج لغوي.
 */
import type { Db } from '../db/index.js'
import { bestMatches } from '../lib/arabic.js'
import { toArabicDigits } from '../lib/phone.js'

export const ITEM_KINDS = ['launch', 'domain', 'marketing', 'feature', 'sales', 'content', 'admin', 'other'] as const
export const ITEM_STATUSES = ['todo', 'doing', 'done', 'dropped'] as const
export const STAGES = ['idea', 'building', 'ready', 'launched', 'growing', 'paused'] as const
export type ItemKind = typeof ITEM_KINDS[number]
export type ItemStatus = typeof ITEM_STATUSES[number]
export type Stage = typeof STAGES[number]

export const KIND_AR: Record<ItemKind, string> = {
  launch: 'إطلاق', domain: 'دومين', marketing: 'تسويق', feature: 'ميزة', sales: 'مبيعات', content: 'محتوى', admin: 'إداري', other: 'أخرى',
}
export const KIND_EMOJI: Record<ItemKind, string> = {
  launch: '🚀', domain: '🌐', marketing: '📣', feature: '✨', sales: '💰', content: '✍️', admin: '📄', other: '📌',
}
export const STAGE_AR: Record<Stage, string> = {
  idea: 'فكرة', building: 'قيد البناء', ready: 'جاهز للإطلاق', launched: 'مطلق', growing: 'في النمو', paused: 'متوقف',
}
export const PRIORITY_AR: Record<number, string> = { 1: 'عالية', 2: 'عادية', 3: 'منخفضة' }

export interface ProjectItem {
  id: number
  project_key: string
  project_label: string
  title: string
  kind: ItemKind
  status: ItemStatus
  priority: 1 | 2 | 3
  due_date: string | null      // YYYY-MM-DD
  notes: string | null
  position: number | null      // ترتيب قبله المالك (أصغر = أول)
  source: string               // owner | suggestion | checklist
  created_at: Date
  updated_at: Date
  done_at: Date | null
}
export interface ProjectProfile { project_key: string; project_label: string; stage: Stage | null; audience: string | null; revenue_model: string | null; updated_at: Date }
export interface NewItem { project_key: string; project_label: string; title: string; kind?: ItemKind; priority?: 1 | 2 | 3; due_date?: string | null; notes?: string | null; source?: string }

const asDate = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(String(v)))
const COLS = `id, project_key, project_label, title, kind, status, priority, to_char(due_date, 'YYYY-MM-DD') AS due_date, notes, position, source, created_at, updated_at, done_at`
const mapItem = (r: any): ProjectItem => ({
  ...r, priority: Number(r.priority) as 1 | 2 | 3, position: r.position == null ? null : Number(r.position),
  created_at: asDate(r.created_at)!, updated_at: asDate(r.updated_at)!, done_at: asDate(r.done_at),
})
const mapProfile = (r: any): ProjectProfile => ({ ...r, updated_at: asDate(r.updated_at)! })

/** "2026-10-05" أو ISO كامل ← "2026-10-05"؛ غير ذلك null */
export function normDate(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim())
  if (!m) return null
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`)
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}` ? null : `${m[1]}-${m[2]}-${m[3]}`
}

export class ProjectItems {
  constructor(private db: Db) {}

  async add(it: NewItem, now: Date): Promise<ProjectItem> {
    const [r] = await this.db.query(
      `INSERT INTO project_items (project_key, project_label, title, kind, priority, due_date, notes, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$9) RETURNING ${COLS}`,
      [it.project_key, it.project_label, it.title.trim().slice(0, 200), it.kind ?? 'other', it.priority ?? 2, normDate(it.due_date), it.notes ?? null, it.source ?? 'owner', now])
    return mapItem(r)
  }
  async get(id: number): Promise<ProjectItem | null> {
    const [r] = await this.db.query(`SELECT ${COLS} FROM project_items WHERE id=$1`, [id])
    return r ? mapItem(r) : null
  }
  /** المفتوحة (todo/doing) — لمشروع واحد أو للكل */
  async open(projectKey?: string): Promise<ProjectItem[]> {
    const rows = projectKey
      ? await this.db.query(`SELECT ${COLS} FROM project_items WHERE status IN ('todo','doing') AND project_key=$1 ORDER BY id`, [projectKey])
      : await this.db.query(`SELECT ${COLS} FROM project_items WHERE status IN ('todo','doing') ORDER BY id`)
    return rows.map(mapItem)
  }
  /** كل البنود لمشروع (أي حالة) — لتجنّب اقتراح شيء موجود أو منجز */
  async forProject(projectKey: string): Promise<ProjectItem[]> {
    return (await this.db.query(`SELECT ${COLS} FROM project_items WHERE project_key=$1 ORDER BY id`, [projectKey])).map(mapItem)
  }
  async doneSince(since: Date): Promise<ProjectItem[]> {
    return (await this.db.query(`SELECT ${COLS} FROM project_items WHERE status='done' AND done_at >= $1 ORDER BY done_at`, [since])).map(mapItem)
  }
  async keys(): Promise<string[]> {
    return (await this.db.query<{ project_key: string }>(`SELECT DISTINCT project_key FROM project_items`)).map((r) => r.project_key)
  }
  async update(id: number, f: { status?: ItemStatus; priority?: 1 | 2 | 3; due_date?: string | null; title?: string; notes?: string | null; kind?: ItemKind }, now: Date): Promise<ProjectItem | null> {
    const sets: string[] = []
    const vals: unknown[] = []
    const set = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col}=$${vals.length}${cast}`) }
    if (f.status) {
      set('status', f.status)
      vals.push(f.status === 'done' ? now : null); sets.push(`done_at=$${vals.length}`)
    }
    if (f.priority) set('priority', f.priority)
    if (f.due_date !== undefined) set('due_date', normDate(f.due_date), '::date')
    if (f.title?.trim()) set('title', f.title.trim().slice(0, 200))
    if (f.notes !== undefined) set('notes', f.notes)
    if (f.kind) set('kind', f.kind)
    if (!sets.length) return this.get(id)
    set('updated_at', now)
    vals.push(id)
    const [r] = await this.db.query(`UPDATE project_items SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING ${COLS}`, vals)
    return r ? mapItem(r) : null
  }
  async remove(ids: number[]): Promise<number> {
    if (!ids.length) return 0
    const rows = await this.db.query(`DELETE FROM project_items WHERE id = ANY($1::int[]) RETURNING id`, [ids])
    return rows.length
  }
  /** يحفظ ترتيباً قبله المالك: position = 1..n لهذه البنود */
  async setOrder(ids: number[], now: Date) {
    for (let i = 0; i < ids.length; i++) {
      await this.db.query(`UPDATE project_items SET position=$1, updated_at=$2 WHERE id=$3`, [i + 1, now, ids[i]])
    }
  }

  async profile(key: string): Promise<ProjectProfile | null> {
    const [r] = await this.db.query(`SELECT * FROM project_profiles WHERE project_key=$1`, [key])
    return r ? mapProfile(r) : null
  }
  async profiles(): Promise<ProjectProfile[]> {
    return (await this.db.query(`SELECT * FROM project_profiles ORDER BY project_key`)).map(mapProfile)
  }
  async setProfile(p: { project_key: string; project_label: string; stage?: Stage | null; audience?: string | null; revenue_model?: string | null }, now: Date): Promise<ProjectProfile> {
    const [r] = await this.db.query(
      `INSERT INTO project_profiles (project_key, project_label, stage, audience, revenue_model, updated_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (project_key) DO UPDATE SET project_label=EXCLUDED.project_label,
         stage=COALESCE(EXCLUDED.stage, project_profiles.stage),
         audience=COALESCE(EXCLUDED.audience, project_profiles.audience),
         revenue_model=COALESCE(EXCLUDED.revenue_model, project_profiles.revenue_model),
         updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [p.project_key, p.project_label, p.stage ?? null, p.audience ?? null, p.revenue_model ?? null, now])
    return mapProfile(r)
  }
}

// ═════════════ الترتيب ═════════════

/** فرق الأيام بين تاريخين محليين YYYY-MM-DD (b - a) */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** البنود التي تمنع الإطلاق لمشروع لم يُطلق بعد */
const LAUNCH_BLOCKING: ItemKind[] = ['launch', 'domain', 'feature', 'admin']
const PRE_LAUNCH: (Stage | null)[] = [null, 'idea', 'building', 'ready']

export interface RankCtx { today: string; profiles: Map<string, ProjectProfile>; tzDate: (d: Date) => string }

/**
 * درجة الإلحاح (أعلى = أول): الأولوية، التأخير/قرب الموعد، منع الإطلاق، الركود (كم له معلّق)، "شغّال عليه".
 * المشروع المتوقف ينزل للأسفل.
 */
export function scoreItem(it: ProjectItem, c: RankCtx): number {
  let s = it.priority === 1 ? 30 : it.priority === 2 ? 15 : 0
  if (it.due_date) {
    const left = dayDiff(c.today, it.due_date)
    if (left < 0) s += 40
    else if (left <= 3) s += 25
    else if (left <= 7) s += 10
  }
  const stage = c.profiles.get(it.project_key)?.stage ?? null
  if (PRE_LAUNCH.includes(stage) && LAUNCH_BLOCKING.includes(it.kind)) s += 15
  if ((stage === 'launched' || stage === 'growing') && ['marketing', 'sales', 'content'].includes(it.kind)) s += 10
  s += Math.min(10, Math.floor(Math.max(0, dayDiff(c.tzDate(it.created_at), c.today)) / 3))
  if (it.status === 'doing') s += 5
  if (stage === 'paused') s -= 40
  return s
}

/** ترتيب عام: بالدرجة، ثم الترتيب اليدوي داخل نفس المشروع، ثم الأقدم */
export function rankItems(items: ProjectItem[], c: RankCtx): ProjectItem[] {
  const sc = new Map(items.map((i) => [i.id, scoreItem(i, c)]))
  return [...items].sort((a, b) => sc.get(b.id)! - sc.get(a.id)! || (a.position ?? 1e9) - (b.position ?? 1e9) || a.id - b.id)
}

/** ترتيب داخل مشروع: الترتيب اليدوي المقبول أولاً، ثم الدرجة */
export function rankProjectItems(items: ProjectItem[], c: RankCtx): ProjectItem[] {
  const sc = new Map(items.map((i) => [i.id, scoreItem(i, c)]))
  return [...items].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || sc.get(b.id)! - sc.get(a.id)! || a.id - b.id)
}

/** يطابق نص المالك ("الدومين") مع بنود مفتوحة — أكثر من واحد = غموض يُسأل عنه */
export function matchItems(query: string, items: ProjectItem[]): ProjectItem[] {
  return bestMatches(query, items.map((i) => ({ i, names: [i.title, `${KIND_AR[i.kind]} ${i.title}`, KIND_AR[i.kind]] }))).map((x) => x.i)
}

// ═════════════ التنسيق ═════════════

const n = (x: number) => toArabicDigits(x)

/** "معلّقة من ١٢ يوم" / "متأخرة ٣ أيام" / "باقي ٥ أيام" */
export function itemAge(it: ProjectItem, c: RankCtx): string {
  if (it.due_date) {
    const left = dayDiff(c.today, it.due_date)
    if (left < 0) return `متأخرة ${n(-left)} يوم`
    if (left === 0) return 'موعدها اليوم'
    if (left <= 14) return `باقي ${n(left)} يوم`
  }
  const age = dayDiff(c.tzDate(it.created_at), c.today)
  return age >= 2 ? `معلّقة من ${n(age)} يوم` : ''
}

export function itemLine(it: ProjectItem, c: RankCtx, withProject = false): string {
  const age = itemAge(it, c)
  return `${KIND_EMOJI[it.kind]} ${withProject ? `${it.project_label}: ` : ''}${it.title}${it.status === 'doing' ? ' (شغّال عليها)' : ''}${age ? ` — ${age}` : ''} [${n(it.id)}]`
}

export function formatProjectList(label: string, items: ProjectItem[], profile: ProjectProfile | null, c: RankCtx): string {
  const stage = profile?.stage ? ` (${STAGE_AR[profile.stage]})` : ''
  if (!items.length) return `📁 ${label}${stage}: ما عندي بنود مفتوحة عليه 👌\nوش الخطوة الجاية؟ قل مثلاً: «${label}: لازم نسوي صفحة هبوط»`
  const ranked = rankProjectItems(items, c)
  return `📁 ${label}${stage} — ${n(items.length)} مفتوحة:\n${ranked.map((i, k) => `${n(k + 1)}. ${itemLine(i, c)}`).join('\n')}\n(لما تخلص: «خلصت بند N»)`
}

export const TG_LIMIT = 3900
/** يقسم على حدود الفقرات (ثم الأسطر) بحيث لا تتجاوز أي رسالة الحد */
export function splitMessage(text: string, max = TG_LIMIT): string[] {
  const parts: string[] = []
  let cur = ''
  const push = (chunk: string, sep: string) => {
    if (!cur) { cur = chunk; return }
    if (cur.length + sep.length + chunk.length <= max) cur += sep + chunk
    else { parts.push(cur); cur = chunk }
  }
  for (const block of text.split('\n\n')) {
    if (block.length <= max) { push(block, '\n\n'); continue }
    for (const line of block.split('\n')) for (let i = 0; i < line.length; i += max) push(line.slice(i, i + max), '\n')
  }
  if (cur) parts.push(cur)
  return parts
}

export interface BriefInput {
  date: string                       // "الأربعاء ١ أكتوبر" أو YYYY-MM-DD
  items: ProjectItem[]               // المفتوحة
  profiles: ProjectProfile[]
  ctx: RankCtx
  weekly?: boolean
  /** الأسبوعي: المنجز خلال ٧ أيام */
  doneThisWeek?: ProjectItem[]
  /** الأسبوعي: مشاريع بلا أي بند ("وش الخطوة الجاية؟") */
  emptyProjects?: string[]
}

/**
 * الموجز اليومي: أهم ٣-٥ خطوات عبر كل المشاريع، المتأخر، سطر لكل مشروع فيه بنود، وتركيز واحد.
 * الأسبوعي (الأحد): ملخص أوفى لكل مشروع بمرحلته + المنجز + المشاريع الفاضية.
 */
export function formatBrief(b: BriefInput): string[] {
  const { ctx } = b
  const ranked = rankItems(b.items, ctx)
  const out: string[] = [`📊 مشاريعك ${b.weekly ? 'هذا الأسبوع' : 'اليوم'} — ${b.date}`]
  if (!ranked.length) {
    out.push('ما عندي بنود مفتوحة على أي مشروع.')
  } else {
    const top = ranked.slice(0, 5)
    out.push(`🎯 أهم الخطوات:\n${top.map((i, k) => `${n(k + 1)}. ${itemLine(i, ctx, true)}`).join('\n')}`)
    const overdue = ranked.filter((i) => i.due_date && dayDiff(ctx.today, i.due_date) < 0 && !top.includes(i))
    if (overdue.length) out.push(`⏰ متأخرة:\n${overdue.slice(0, 8).map((i) => `• ${itemLine(i, ctx, true)}`).join('\n')}`)

    const byProject = new Map<string, ProjectItem[]>()
    for (const i of ranked) byProject.set(i.project_key, [...(byProject.get(i.project_key) ?? []), i])
    const prof = new Map(b.profiles.map((p) => [p.project_key, p]))
    const lines: string[] = []
    for (const [key, list] of byProject) {
      const p = prof.get(key)
      const stage = p?.stage ? ` (${STAGE_AR[p.stage]})` : ''
      const next = rankProjectItems(list, ctx)[0]
      if (b.weekly) {
        const kinds = [...new Set(list.map((i) => i.kind))].map((k) => `${KIND_EMOJI[k]} ${n(list.filter((i) => i.kind === k).length)} ${KIND_AR[k]}`).join('، ')
        lines.push(`📁 ${list[0].project_label}${stage}: ${n(list.length)} مفتوحة (${kinds})\n   التالي: ${next.title}`)
      } else {
        lines.push(`• ${list[0].project_label}${stage}: ${n(list.length)} مفتوحة — التالي: ${next.title}`)
      }
    }
    out.push(`${b.weekly ? '🗂️ المشاريع:' : '📁 المشاريع:'}\n${lines.join('\n')}`)
  }
  if (b.weekly && b.doneThisWeek?.length) {
    out.push(`✅ خلّصت هالأسبوع ${n(b.doneThisWeek.length)}:\n${b.doneThisWeek.slice(0, 10).map((i) => `• ${i.project_label}: ${i.title}`).join('\n')}`)
  }
  if (b.weekly && b.emptyProjects?.length) {
    const shown = b.emptyProjects.slice(0, 10)
    out.push(`🤔 ما عندي مهام لـ ${shown.join('، ')}${b.emptyProjects.length > shown.length ? ` (+${n(b.emptyProjects.length - shown.length)})` : ''} — وش الخطوة الجاية؟`)
  }
  if (ranked[0]) out.push(`👉 ركّز اليوم على: ${ranked[0].project_label} — ${ranked[0].title}`)
  return splitMessage(out.join('\n\n'))
}

// ═════════════ قائمة الإطلاق ═════════════

export const LAUNCH_CHECKLIST: { title: string; kind: ItemKind }[] = [
  { title: 'تركيب دومين', kind: 'domain' },
  { title: 'صفحة هبوط', kind: 'launch' },
  { title: 'تحديد الأسعار والباقات', kind: 'sales' },
  { title: 'ربط بوابة الدفع', kind: 'sales' },
  { title: 'تركيب التحليلات (Analytics)', kind: 'launch' },
  { title: 'حسابات التواصل الاجتماعي', kind: 'marketing' },
  { title: 'حملة تسويق للإطلاق', kind: 'marketing' },
  { title: 'أول عملاء / تجربة (Pilot)', kind: 'sales' },
  { title: 'قناة دعم العملاء', kind: 'admin' },
  { title: 'الشروط وسياسة الخصوصية', kind: 'admin' },
]
