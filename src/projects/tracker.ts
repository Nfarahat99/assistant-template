/**
 * متتبّع مشاريع البزنس — طبقة التنسيق بين أوامر المالك، القاعدة، Railway، والنموذج اللغوي.
 * القاعدة: الحقائق من القاعدة وRailway فقط؛ النموذج يفهم رسائل المالك (في understand) ويكيّف قائمة الإطلاق فقط.
 * الإضافة والتعديل بلا موافقة (بيانات المالك نفسه)؛ الحذف، والاقتراحات، وقائمة الإطلاق، واعتماد الترتيب ← "نعم N".
 */
import { z } from 'zod'
import type { LlmClient } from '../ai/providers.js'
import { extractJson } from '../ai/schema.js'
import type { RwService } from '../clients/railway.js'
import { ProjectRegistry, projectLabel, selfProject, claudeConfigProject } from '../projects.js'
import { normalizeArabic, nameScore } from '../lib/arabic.js'
import { toArabicDigits } from '../lib/phone.js'
import { localParts } from '../lib/time.js'
import { withUsage } from '../usage.js'
import {
  ProjectItems, ITEM_KINDS, STAGE_AR, KIND_EMOJI, LAUNCH_CHECKLIST, PRIORITY_AR,
  rankItems, matchItems, formatProjectList, formatBrief, itemLine, normDate,
  type ProjectItem, type NewItem, type ItemKind, type ItemStatus, type Stage, type RankCtx,
} from './items.js'

const n = (x: number) => toArabicDigits(x)
const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']
export const SUGGEST_DISMISSED_KEY = 'project_suggest_dismissed'
export const BRIEF_CLAIM_KEY = 'project_brief_last'

/** حمولة طلب الموافقة (pending kind = project_items) */
export interface ProjectItemsPayload {
  op: 'add' | 'delete' | 'reorder'
  project_label?: string
  items?: NewItem[]
  ids?: number[]
  /** نص المعاينة (بدون سطر "رد: نعم N") */
  preview: string
  /** سطر واحد لقائمة المعلّق */
  summary: string
  /** فعل السؤال: "أضيفها؟" / "أحذفه؟" / "أعتمد الترتيب؟" */
  ask: string
  /** اقتراحات: الرفض يمنع تكرارها */
  dismiss_keys?: string[]
}

export interface TrackerDeps {
  items: ProjectItems
  projects: ProjectRegistry
  llm: LlmClient | null
  now: () => Date
  tz: string
  kv: { getKv(k: string): Promise<string | null>; setKv(k: string, v: string): Promise<void> }
  railwayServices: (() => Promise<RwService[]>) | null
  /** ينشئ طلب موافقة ويرجع نص المعاينة */
  propose: (payload: ProjectItemsPayload) => Promise<string>
}

type Resolved = { key: string; label: string } | { error: string }

/** مستودعات المساعد المدمجة — تُستثنى من متتبّع المشاريع (من الملف الشخصي، تُحسب عند الاستدعاء) */
const builtInRepos = () => new Set([selfProject().repo, claudeConfigProject()?.repo].filter((r): r is string => !!r).map((r) => r.toLowerCase()))

export class ProjectTracker {
  constructor(private d: TrackerDeps) {}

  // ─── أدوات ───
  private today(): string {
    const lp = localParts(this.d.now(), this.d.tz)
    return `${lp.y}-${String(lp.mo).padStart(2, '0')}-${String(lp.d).padStart(2, '0')}`
  }
  private tzDate = (d: Date) => {
    const lp = localParts(d, this.d.tz)
    return `${lp.y}-${String(lp.mo).padStart(2, '0')}-${String(lp.d).padStart(2, '0')}`
  }
  private async ctx(): Promise<RankCtx> {
    return { today: this.today(), tzDate: this.tzDate, profiles: new Map((await this.d.items.profiles()).map((p) => [p.project_key, p])) }
  }
  dateLabel(): string {
    const lp = localParts(this.d.now(), this.d.tz)
    return `${AR_DAYS[lp.wd]} ${n(lp.d)} ${AR_MONTHS[lp.mo - 1]}`
  }

  /**
   * اسم المشروع كما قاله المالك ← مفتاح ثابت: مستودع من القائمة، أو اسم حر لمشروع بزنس ما له مستودع.
   * أكثر من مطابقة = نسأل ولا نخمّن.
   */
  async resolve(query: string | undefined): Promise<Resolved> {
    const q = (query ?? '').trim()
    if (!q) return { error: 'أي مشروع تقصد؟' }
    const hits = this.d.projects.resolve(q)
    if (hits.length === 1) return { key: hits[0].repo.toLowerCase(), label: projectLabel(hits[0]) }
    if (hits.length > 1) return { error: `«${q}» يطابق أكثر من مشروع: ${hits.slice(0, 6).map((p) => projectLabel(p)).join('، ')} — أي واحد؟` }
    // مشروع حر سبق تسجيله (بنود أو ملف) بنفس الاسم
    const key = `custom:${normalizeArabic(q)}`
    const prof = (await this.d.items.profiles()).find((p) => !p.project_key.includes('/') && nameScore(q, p.project_label) >= 3)
    if (prof) return { key: prof.project_key, label: prof.project_label }
    return { key, label: q.replace(/[؟?!.]+$/, '') }
  }

  /** بند واحد بالرقم أو بالنص (داخل المشروع إن ذُكر) */
  private async findItem(a: { project_query?: string; item_id?: number; query?: string }): Promise<{ item: ProjectItem } | { error: string }> {
    if (a.item_id) {
      const it = await this.d.items.get(a.item_id)
      return it ? { item: it } : { error: `ما فيه بند رقم ${n(a.item_id)}.` }
    }
    let pool = await this.d.items.open()
    let where = ''
    if (a.project_query) {
      const r = await this.resolve(a.project_query)
      if ('error' in r) return r
      pool = pool.filter((i) => i.project_key === r.key)
      where = ` في ${r.label}`
    }
    const hits = matchItems(a.query ?? '', pool)
    if (hits.length === 1) return { item: hits[0] }
    if (!hits.length) return { error: `ما لقيت بند مفتوح «${a.query ?? ''}»${where} 🤔` }
    const c = await this.ctx()
    return { error: `لقيت أكثر من بند${where}، أي واحد؟\n${hits.slice(0, 6).map((i) => `• ${itemLine(i, c, !where)}`).join('\n')}\nقل: «خلصت بند N» أو «احذف بند N»` }
  }

  // ─── الإضافة والتعديل (بلا موافقة) ───
  async add(a: { project_query: string; title: string; kind?: ItemKind; priority?: 1 | 2 | 3; due_date?: string; notes?: string }): Promise<string> {
    const r = await this.resolve(a.project_query)
    if ('error' in r) return r.error
    const existing = (await this.d.items.open(r.key)).find((i) => nameScore(a.title, i.title) >= 3 && nameScore(i.title, a.title) >= 3)
    if (existing) return `موجودة من قبل في ${r.label}: ${existing.title} [${n(existing.id)}] 👌`
    const kind = a.kind ?? guessKind(a.title)
    const newCustom = r.key.startsWith('custom:') && !(await this.d.items.keys()).includes(r.key)
    const it = await this.d.items.add({ project_key: r.key, project_label: r.label, title: a.title, kind, priority: a.priority, due_date: a.due_date, notes: a.notes, source: 'owner' }, this.d.now())
    const extra = [it.priority !== 2 ? `أولوية ${PRIORITY_AR[it.priority]}` : '', it.due_date ? `الموعد ${it.due_date}` : ''].filter(Boolean).join('، ')
    const custom = newCustom ? '\n(مشروع جديد — ما هو في قائمة مستودعاتي، سجّلته باسمه)' : ''
    return `📌 سجّلت على ${r.label}: ${KIND_EMOJI[it.kind]} ${it.title}${extra ? ` (${extra})` : ''} [${n(it.id)}]${custom}`
  }

  async update(a: { project_query?: string; item_id?: number; query?: string; status?: ItemStatus; priority?: 1 | 2 | 3; due_date?: string; title?: string }): Promise<string> {
    const f = await this.findItem(a)
    if ('error' in f) return f.error
    const it = await this.d.items.update(f.item.id, { status: a.status, priority: a.priority, due_date: a.due_date === undefined ? undefined : normDate(a.due_date), title: a.title }, this.d.now())
    if (!it) return 'ما قدرت أحدّث البند.'
    if (a.status === 'done') {
      const left = (await this.d.items.open(it.project_key)).length
      return `✅ خلصت: ${it.project_label} — ${it.title}${left ? ` (باقي ${n(left)} مفتوحة)` : ' — ما بقى شي مفتوح على المشروع 🎉'}`
    }
    if (a.status === 'dropped') return `🚫 شلتها من القائمة: ${it.project_label} — ${it.title}`
    if (a.status === 'doing') return `🔨 تمام، ${it.title} (${it.project_label}) صارت «شغّال عليها»`
    return `✏️ حدّثت: ${it.project_label} — ${it.title}${it.priority !== 2 ? ` · أولوية ${PRIORITY_AR[it.priority]}` : ''}${it.due_date ? ` · الموعد ${it.due_date}` : ''}`
  }

  async doneById(id: number): Promise<string> { return this.update({ item_id: id, status: 'done' }) }

  async setStage(a: { project_query: string; stage?: Stage; audience?: string; revenue_model?: string }): Promise<string> {
    const r = await this.resolve(a.project_query)
    if ('error' in r) return r.error
    const p = await this.d.items.setProfile({ project_key: r.key, project_label: r.label, stage: a.stage ?? null, audience: a.audience ?? null, revenue_model: a.revenue_model ?? null }, this.d.now())
    const bits = [p.stage ? `المرحلة: ${STAGE_AR[p.stage]}` : '', p.audience ? `الجمهور: ${p.audience}` : '', p.revenue_model ? `الدخل: ${p.revenue_model}` : ''].filter(Boolean)
    const hint = a.stage === 'launched' ? '\n🎉 مبروك الإطلاق! من الحين أقدّم بنود التسويق والمبيعات عليه.' : ''
    return `📁 ${r.label} — ${bits.join(' · ') || 'حدّثت ملفه'}${hint}`
  }

  // ─── العرض ───
  async list(projectQuery?: string): Promise<string> {
    if (!projectQuery?.trim()) return (await this.brief(false)).join('\n\n')
    const r = await this.resolve(projectQuery)
    if ('error' in r) return r.error
    return formatProjectList(r.label, await this.d.items.open(r.key), await this.d.items.profile(r.key), await this.ctx())
  }

  async brief(weekly: boolean): Promise<string[]> {
    const items = await this.d.items.open()
    const profiles = await this.d.items.profiles()
    const c = await this.ctx()
    let doneThisWeek: ProjectItem[] | undefined
    let emptyProjects: string[] | undefined
    if (weekly) {
      doneThisWeek = await this.d.items.doneSince(new Date(this.d.now().getTime() - 7 * 86_400_000))
      const used = new Set([...(await this.d.items.keys()), ...profiles.filter((p) => p.stage !== 'paused').map((p) => p.project_key)])
      const paused = new Set(profiles.filter((p) => p.stage === 'paused').map((p) => p.project_key))
      const builtIn = builtInRepos()
      emptyProjects = this.d.projects.all()
        .filter((p) => !builtIn.has(p.repo.toLowerCase()) && !paused.has(p.repo.toLowerCase()) && !used.has(p.repo.toLowerCase()) && !isArchivedNote(p.note))
        .map((p) => projectLabel(p))
      // مشاريع لها ملف بلا بنود مفتوحة
      const openKeys = new Set(items.map((i) => i.project_key))
      for (const p of profiles) if (p.stage !== 'paused' && !openKeys.has(p.project_key)) emptyProjects.push(p.project_label)
      emptyProjects = [...new Set(emptyProjects)]
    }
    return formatBrief({ date: this.dateLabel(), items, profiles, ctx: c, weekly, doneThisWeek, emptyProjects })
  }

  /**
   * الموجز المجدول: يومياً في وقته (نافذة ٣ ساعات)، والأحد أسبوعي أوفى.
   * لا يرسل شيئاً لمن ما استخدم المتتبّع أبداً، ولا موجزاً يومياً بلا بنود مفتوحة.
   */
  async scheduled(o: { enabled: boolean; at: string; claim: (key: string, value: string) => Promise<boolean> }): Promise<{ parts: string[]; weekly: boolean } | null> {
    if (!o.enabled) return null
    const lp = localParts(this.d.now(), this.d.tz)
    const [h, m] = o.at.split(':').map(Number)
    const mins = lp.h * 60 + lp.mi
    const start = h * 60 + m
    if (!(mins >= start && mins < start + 180)) return null
    const weekly = lp.wd === 0
    const open = await this.d.items.open()
    if (!open.length) {
      if (!weekly) return null
      if (!(await this.d.items.keys()).length && !(await this.d.items.profiles()).length) return null
    }
    if (!(await o.claim(BRIEF_CLAIM_KEY, this.today()))) return null
    return { parts: await this.brief(weekly), weekly }
  }

  // ─── الحذف والترتيب والاقتراحات وقائمة الإطلاق (بموافقة) ───
  async remove(a: { project_query?: string; item_id?: number; query?: string }): Promise<string> {
    const f = await this.findItem(a)
    if ('error' in f) return f.error
    const it = f.item
    return this.d.propose({
      op: 'delete', ids: [it.id], project_label: it.project_label,
      preview: `🗑️ أحذف البند من ${it.project_label}: ${it.title}؟`, summary: `حذف بند «${it.title}» من ${it.project_label}`, ask: 'أحذفه؟',
    })
  }

  async prioritize(projectQuery?: string): Promise<string> {
    const c = await this.ctx()
    if (!projectQuery?.trim()) {
      const ranked = rankItems(await this.d.items.open(), c)
      if (!ranked.length) return 'ما عندي بنود مفتوحة أرتبها.'
      return `🧭 ترتيبي المقترح لكل المشاريع (الأولوية، الموعد، اللي يوقف الإطلاق، والأقدم):\n${ranked.slice(0, 12).map((i, k) => `${n(k + 1)}. ${itemLine(i, c, true)}`).join('\n')}`
    }
    const r = await this.resolve(projectQuery)
    if ('error' in r) return r.error
    const open = await this.d.items.open(r.key)
    if (!open.length) return `ما عندي بنود مفتوحة على ${r.label}.`
    // ترتيب جديد من الدرجة نفسها (نتجاهل الترتيب اليدوي القديم)
    const ranked = rankItems(open.map((i) => ({ ...i, position: null })), c)
    if (open.length === 1) return formatProjectList(r.label, open, await this.d.items.profile(r.key), c)
    return this.d.propose({
      op: 'reorder', ids: ranked.map((i) => i.id), project_label: r.label,
      preview: `🧭 ترتيبي المقترح لـ ${r.label}:\n${ranked.map((i, k) => `${n(k + 1)}. ${itemLine(i, c)}`).join('\n')}`,
      summary: `اعتماد ترتيب بنود ${r.label}`, ask: 'أعتمد هالترتيب؟',
    })
  }

  /** اقتراحات من حقائق Railway (لا دومين خاص، ما انشر/النشر فاشل) — كطلب موافقة، لا بنود تلقائية */
  async suggestionPayload(projectQuery?: string): Promise<ProjectItemsPayload | { none: string }> {
    if (!this.d.railwayServices) return { none: 'Railway غير مربوط — ما عندي حقائق أقترح منها.' }
    let services: RwService[]
    try { services = await this.d.railwayServices() } catch { return { none: 'ما قدرت أقرأ Railway الحين.' } }
    const builtIn = builtInRepos()
    let projects = this.d.projects.all().filter((p) => !builtIn.has(p.repo.toLowerCase()) && !isArchivedNote(p.note))
    if (projectQuery?.trim()) {
      const hits = this.d.projects.resolve(projectQuery)
      if (hits.length !== 1) return { none: hits.length ? `«${projectQuery}» يطابق أكثر من مشروع — حدد.` : `ما لقيت «${projectQuery}» في مشاريعي المربوطة بـ Railway.` }
      projects = hits
    }
    const dismissed = new Set<string>(JSON.parse((await this.d.kv.getKv(SUGGEST_DISMISSED_KEY)) || '[]'))
    const profiles = new Map((await this.d.items.profiles()).map((p) => [p.project_key, p]))
    const items: NewItem[] = []
    const keys: string[] = []
    const facts: string[] = []
    for (const p of projects) {
      const key = p.repo.toLowerCase()
      if (profiles.get(key)?.stage === 'paused') continue
      let svcs = services.filter((s) => s.repo?.toLowerCase() === key)
      if (!svcs.length && p.railway_project) svcs = services.filter((s) => s.projectName.toLowerCase() === p.railway_project!.toLowerCase())
      if (!svcs.length) continue
      const label = projectLabel(p)
      const have = await this.d.items.forProject(key)
      const offer = (kind: ItemKind, title: string, fact: string) => {
        const k = `${key}:${kind}`
        if (dismissed.has(k) || have.some((i) => i.kind === kind)) return
        items.push({ project_key: key, project_label: label, title, kind, priority: kind === 'launch' ? 1 : 2, source: 'suggestion' })
        keys.push(k)
        facts.push(`${KIND_EMOJI[kind]} ${label}: ${title} — ${fact}`)
      }
      const live = svcs.filter((s) => s.latest && s.latest.status === 'SUCCESS')
      const broken = svcs.filter((s) => s.latest && ['FAILED', 'CRASHED'].includes(s.latest.status))
      if (!live.length) {
        offer('launch', 'نشر المشروع (ما فيه نسخة شغّالة)', broken.length ? `آخر نشر لـ ${broken[0].serviceName} فشل` : 'ما فيه أي نشر على Railway')
      }
      const web = svcs.filter((s) => s.domains.length)
      if (web.length && web.every((s) => s.domains.every((d) => d.endsWith('.up.railway.app')))) {
        offer('domain', 'تركيب دومين خاص', `رابطه الحالي ${web[0].domains[0]}`)
      }
      if (items.length >= 12) break
    }
    if (!items.length) return { none: 'ما لقيت شي جديد أقترحه من Railway — كل شي مسجّل أو سبق رفضته 👌' }
    return {
      op: 'add', items, dismiss_keys: keys,
      preview: `💡 لاحظت من Railway (اقتراحات، ما سجّلتها):\n${facts.join('\n')}`,
      summary: `إضافة ${n(items.length)} اقتراح من Railway`, ask: 'أضيفها كبنود؟',
    }
  }

  async suggest(projectQuery?: string): Promise<string> {
    const s = await this.suggestionPayload(projectQuery)
    return 'none' in s ? s.none : this.d.propose(s)
  }

  /** قائمة إطلاق: القالب ← يكيّفه النموذج للمشروع (اختياري) ← نحذف الموجود ← موافقة */
  async checklist(projectQuery: string): Promise<string> {
    const r = await this.resolve(projectQuery)
    if ('error' in r) return r.error
    const have = await this.d.items.forProject(r.key)
    const profile = await this.d.items.profile(r.key)
    let list = LAUNCH_CHECKLIST
    if (this.d.llm) {
      try {
        const raw = await withUsage({ purpose: 'project_checklist' }, () => this.d.llm!.complete(CHECKLIST_SYSTEM, checklistUser(r.label, profile, have)))
        const parsed = ChecklistSchema.safeParse(extractJson(raw))
        if (parsed.success && parsed.data.items.length >= 3) list = parsed.data.items
      } catch { /* القالب كما هو */ }
    }
    const fresh = list.filter((t) => !have.some((i) => (i.kind === t.kind && t.kind === 'domain') || (nameScore(t.title, i.title) >= 3)))
    if (!fresh.length) return `قائمة إطلاق ${r.label} كلها مسجّلة عندي 👌 — «وش باقي على ${r.label}» يعرضها.`
    const items: NewItem[] = fresh.map((t) => ({ project_key: r.key, project_label: r.label, title: t.title, kind: t.kind, priority: ['domain', 'launch'].includes(t.kind) ? 1 : 2, source: 'checklist' }))
    return this.d.propose({
      op: 'add', items, project_label: r.label,
      preview: `🚀 قائمة إطلاق ${r.label} (${n(items.length)} بند — ما حفظتها بعد):\n${items.map((i, k) => `${n(k + 1)}. ${KIND_EMOJI[i.kind!]} ${i.title}`).join('\n')}`,
      summary: `قائمة إطلاق ${r.label} (${n(items.length)} بند)`, ask: 'أحفظها؟',
    })
  }

  // ─── تنفيذ القرار ───
  async apply(pl: ProjectItemsPayload): Promise<string> {
    const now = this.d.now()
    if (pl.op === 'add') {
      const added: ProjectItem[] = []
      for (const it of pl.items ?? []) added.push(await this.d.items.add(it, now))
      return `📌 أضفت ${n(added.length)} بند${pl.project_label ? ` على ${pl.project_label}` : ''}:\n${added.map((i) => `• ${pl.project_label ? '' : `${i.project_label}: `}${i.title} [${n(i.id)}]`).join('\n')}`
    }
    if (pl.op === 'delete') {
      const k = await this.d.items.remove(pl.ids ?? [])
      return k ? `🗑️ حذفته${pl.project_label ? ` من ${pl.project_label}` : ''}.` : 'البند انحذف من قبل 👌'
    }
    await this.d.items.setOrder(pl.ids ?? [], now)
    return `🧭 اعتمدت الترتيب لـ ${pl.project_label}. «وش باقي على ${pl.project_label}» يعرضه.`
  }

  async reject(pl: ProjectItemsPayload): Promise<string> {
    if (pl.dismiss_keys?.length) {
      const cur: string[] = JSON.parse((await this.d.kv.getKv(SUGGEST_DISMISSED_KEY)) || '[]')
      await this.d.kv.setKv(SUGGEST_DISMISSED_KEY, JSON.stringify([...new Set([...cur, ...pl.dismiss_keys])].slice(-500)))
      return 'تمام، ما راح أقترحها مرة ثانية ✋'
    }
    return 'تمام، ألغيته ✋'
  }
}

export function isArchivedNote(note: unknown): boolean {
  return typeof note === 'string' && /\b(archive|archived|dormant|deprecated)\b|مؤرشف/i.test(note)
}

/** تخمين النوع من العنوان إن لم يحدده النموذج */
export function guessKind(title: string): ItemKind {
  const t = normalizeArabic(title)
  if (/دومين|نطاق|domain|dns/.test(t)) return 'domain'
  if (/تسويق|حمله|اعلان|انستقرام|سناب|تيك|marketing|ads|سوشل/.test(t)) return 'marketing'
  if (/اطلاق|نشر|launch|deploy|صفحه هبوط|landing/.test(t)) return 'launch'
  if (/عميل|عملاء|مبيعات|سعر|اسعار|باقات|دفع|بيع|sales|pricing|payment/.test(t)) return 'sales'
  if (/محتوي|مقال|فيديو|بوست|content/.test(t)) return 'content'
  if (/ميزه|خاصيه|feature/.test(t)) return 'feature'
  if (/عقد|سجل تجاري|ترخيص|خصوصيه|شروط|ضريبه|فاتوره|legal|privacy/.test(t)) return 'admin'
  return 'other'
}

const ChecklistSchema = z.object({
  items: z.array(z.object({ title: z.string().trim().min(2).max(120), kind: z.enum(ITEM_KINDS).catch('other') })).max(14),
})

const CHECKLIST_SYSTEM = `أنت تجهّز قائمة إطلاق تجاري (بزنس، لا تقنية) لمشروع ناشئ سعودي.
ابدأ من القالب المعطى: احذف ما لا ينطبق على المشروع، وكيّف الصياغة له، وأضف بنداً أو اثنين فقط إن كان ضرورياً.
لا تكرر بنداً موجوداً في "البنود الحالية". عناوين قصيرة بالعربي (٢-٦ كلمات).
أعد JSON فقط: {"items":[{"title":"...","kind":"launch|domain|marketing|feature|sales|content|admin|other"}]}`

function checklistUser(label: string, profile: { stage: Stage | null; audience: string | null; revenue_model: string | null } | null, have: ProjectItem[]): string {
  return [
    `المشروع: ${label}`,
    profile?.stage ? `المرحلة: ${STAGE_AR[profile.stage]}` : '',
    profile?.audience ? `الجمهور: ${profile.audience}` : '',
    profile?.revenue_model ? `نموذج الدخل: ${profile.revenue_model}` : '',
    `البنود الحالية: ${have.map((i) => i.title).join('، ') || 'لا شيء'}`,
    `القالب:\n${LAUNCH_CHECKLIST.map((t) => `- ${t.title} (${t.kind})`).join('\n')}`,
  ].filter(Boolean).join('\n')
}

