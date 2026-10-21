/**
 * مُشغّل التقييم: يعيد كل حالة على خطوة الفهم الحقيقية (understand + برومبت النظام الحقيقي)
 * بنموذج قابل للتبديل، ويفحص أنواع الإجراءات والممنوعات. لا ينفّذ أي إجراء (لا رسائل، لا GitHub، لا قواعد).
 *
 * المسارات الحتمية التي تسبق النموذج في البوت (مثل "أي مودل أنت") تُحاكى هنا بنفس الدوال المصدَّرة،
 * فحالة route=fast تنجح فقط إذا التقطها المسار الحتمي فعلاً.
 * حالات الصوت تُعاد كنص التفريغ (الإنتاج يفهمها بـ Gemini دائماً — المقارنة تفصلها).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { LlmClient } from '../ai/providers.js'
import { understand, lastUnderstandError, type UnderstandContext } from '../ai/understand.js'
import { extractJson, parseLlmOutput } from '../ai/schema.js'
import { capabilitiesForPrompt } from '../capabilities.js'
import { profile } from '../profile.js'
import { parseProjects, projectLabel, ProjectRegistry } from '../projects.js'
import { isModelQuestion, WHERE_IN_CODE_RE } from '../assistant.js'
import { isRunScriptRequest, optionLetterIndex } from '../lib/reply-guards.js'
import { isManualCaseCommand } from '../selfreview/signals.js'
import { COMPARE_RE } from '../selfreview/commands.js'
import type { EvalCase, Expected } from '../selfreview/cases.js'

export type Modality = 'text' | 'voice'

export interface Replay {
  route: 'fast' | 'llm' | 'error'
  actions: { type: string; text?: string }[]
  /** كل النص الذي سيقرؤه المالك (reply + answer + clarify) */
  text: string
  /** حمولة الإجراءات (طلب الكود، سؤال القاعدة، استعلام البحث…) — لـ must_match و payload: */
  payload?: string
  error?: string
}

export interface CaseResult {
  id: string
  owner_message: string
  modality: Modality
  status: 'pass' | 'fail' | 'skip' | 'error'
  /** البوت يلتقط هذه الرسالة بمسار حتمي قبل النموذج في الإنتاج (اسم الحارس) — الدرجة الخام تبقى للنموذج */
  guarded?: string
  reasons: string[]
  actions: string[]
  text: string
  ms: number
}

export interface EvalReport {
  model: string
  started_at: string
  total: number
  passed: number
  failed: number
  errors: number
  skipped: number
  /** نسبة النجاح من المُقيَّم فعلاً (بدون المتخطّى) — 0..100 */
  score: number
  /** الدرجة مع حواجز الإنتاج الحتمية: الحالة المحروسة تُحسب ناجحة (ما يراه المالك فعلاً) */
  score_guarded: number
  /** نسبة الردود (عبر النموذج) التي فيها سؤال توضيح — مقياس حلقات التوضيح */
  clarify_rate: number
  /** مخرجات نموذج مرفوضة (JSON/schema) من كل الاستدعاءات — تشمل المحاولة الثانية */
  invalid_outputs: number
  calls: number
  by_modality: Record<Modality, { graded: number; passed: number; score: number }>
  results: CaseResult[]
}

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..', '..')
const readOr = (p: string, d = '') => { try { return readFileSync(p, 'utf8') } catch { return d } }

let registryCache: ProjectRegistry | null = null
function registry(): ProjectRegistry {
  if (registryCache) return registryCache
  // قائمة مشاريع مصطنعة ثابتة (projects-snapshot.json — نفس صيغة projects.json)، وإلا projects.json المحلي
  const snap = readOr(join(here, 'projects-snapshot.json')) || readOr(join(ROOT, 'projects.json'), '[]')
  try { registryCache = new ProjectRegistry(parseProjects(snap)) } catch { registryCache = new ProjectRegistry([]) }
  return registryCache
}

/** = assistant.ts handleText: "نعم N" حرفياً ← literalNReply */
const LITERAL_N_RE = /^\s*(?:نعم|لا|عدّل|عدل)\s+(?:N|ن|رقم|الرقم|<رقم>|<N>)\s*$/i
/** = assistant.ts handleText: "اكتب/سوي سكربت" طلب كتابة لا تشغيل */
const WRITE_SCRIPT_RE = /(اكتب|يكتب|سوي|يسوي|سو|جهز|يجهز|اعمل|يعمل)\s+(ال)?(سكربت|سكريبت|script)/i

/**
 * حواجز الإنتاج الحتمية قبل النموذج (من PR #58) — نفس الدوال المصدَّرة حيث أمكن.
 * التقييم يبقى على الفهم الخام، وهذا للتوضيح ولحساب score_guarded فقط.
 */
export function guardOf(c: EvalCase): string | null {
  const t = c.owner_message.replace(/^🎤\s*/, '').trim()
  if (LITERAL_N_RE.test(t)) return 'literal_n'
  if (isRunScriptRequest(t) && !WRITE_SCRIPT_RE.test(t)) return 'run_script_answer'
  const w = WHERE_IN_CODE_RE.exec(t)
  if (w && registry().resolve(w[2].trim()).length === 1) return 'code_search'
  const lastBot = [...c.context_turns].reverse().find((x) => x.role === 'assistant')
  if (optionLetterIndex(t) !== null && /^❓ Claude يحتاج توضيح/.test(lastBot?.text ?? '')) return 'code_question_answer'
  return null
}

export const modalityOf = (c: EvalCase): Modality => c.modality ?? (/^🎤/.test(c.owner_message) ? 'voice' : 'text')

/** سياق ثابت قريب من الإنتاج: قائمة المشاريع المصطنعة، ذاكرة المالك المحلية، حقائق البوت (مربوط بكل شيء) */
export function baseContext(): Omit<UnderstandContext, 'history' | 'pending'> {
  const list = registry().all()
  return {
    nowIso: '2026-10-05T19:00:00+03:00',
    weekday: 'الاثنين',
    contacts: [{ name: 'ريم الشهري', aliases: ['ريم'] }],
    projects: list.map((p) => ({ name: `${projectLabel(p)} — ${p.repo}`, aliases: p.aliases.slice(1) })),
    openTasks: [],
    knowledge: readOr(join(ROOT, 'knowledge', 'owner.md')),
    capabilities: capabilitiesForPrompt({
      githubConnected: true, githubOwner: profile().github.owner, projects: list.map((p) => ({ label: projectLabel(p), repo: p.repo })),
      selfRepo: profile().github.self_repo, telegram: 'bound', whatsapp: { status: 'connected', banned: false }, sendMode: 'link',
      version: null, recentJobs: [], lastFailures: [], webSearch: true, railway: true, railwayServices: [],
      databases: ['نجوم (nujoom — نجوم بلس)', 'النخبة (nukhba — رافد)'], dbAccess: true,
      llm: { primary: 'NVIDIA (nvidia/nemotron-3-super-120b-a12b)', fallback: 'Google Gemini (gemini-3.8-flash)', lastServed: null },
    }),
    guidelines: '',
  }
}

export function contextFor(c: EvalCase, base = baseContext()): UnderstandContext {
  return {
    ...base,
    history: c.context_turns.filter((t) => t.role !== 'pending').map((t) => ({ role: t.role as 'user' | 'assistant', text: t.text })),
    pending: c.context_turns.filter((t) => t.role === 'pending').map((t, i) => ({ no: t.no ?? i + 1, summary: t.text })),
  }
}

/** المسارات الحتمية قبل النموذج — نفس الدوال التي يستخدمها البوت */
export function preRoute(text: string): Replay | null {
  const t = text.trim().replace(/[.!؟?]+$/, '')
  if (isModelQuestion(t)) return { route: 'fast', actions: [{ type: 'model_answer' }], text: '' }
  if (isManualCaseCommand(text)) return { route: 'fast', actions: [{ type: 'save_eval_case' }], text: '' }
  if (COMPARE_RE.test(t)) return { route: 'fast', actions: [{ type: 'compare_models' }], text: '' }
  return null
}

export async function replay(c: EvalCase, llm: LlmClient | null, base?: ReturnType<typeof baseContext>): Promise<Replay | null> {
  const msg = c.owner_message.replace(/^🎤\s*/, '')
  const fast = preRoute(msg)
  if (fast) return fast
  if (!llm) return null
  const out = await understand(llm, msg, contextFor(c, base))
  if (!out) return { route: 'error', actions: [], text: '', error: lastUnderstandError ?? 'فشل الفهم' }
  const actions = out.actions.map((a: any) => ({
    type: a.type as string,
    text: a.type === 'answer' ? a.text : a.type === 'clarify' ? `${a.question}\n${(a.options ?? []).join('\n')}` : undefined,
  }))
  const text = [out.reply, ...actions.map((a) => a.text ?? '')].filter(Boolean).join('\n')
  // التذكيرات: التكرار وموعد التنبيه جزء من الحمولة ("recurrence:daily"، "remind_at:…"، "at:…") ليُفحص بـ must_match
  const payload = out.actions
    .map((a: any) => [a.request, a.question, a.query, a.task, a.title, a.rule, a.db_query, a.project_query,
      a.type === 'set_reminder' ? a.text : null,
      a.recurrence ? `recurrence:${a.recurrence}` : null, a.remind_at ? `remind_at:${a.remind_at}` : null,
      a.type === 'set_reminder' && a.at ? `at:${a.at}` : null, a.task_id ? `task_id:${a.task_id}` : null].filter(Boolean).join(' | '))
    .filter(Boolean).join('\n')
  return { route: 'llm', actions, text, payload }
}

const compile = (m: string, reasons: string[]): RegExp | null => {
  try { return new RegExp(m, 'i') } catch { reasons.push(`نمط غير صالح: ${m}`); return null }
}

/** الفحص الحتمي: المسار + الأنواع المسموحة + المطلوب + المطابق + الممنوعات */
export function check(e: Expected, r: Replay): string[] {
  const reasons: string[] = []
  if (r.route === 'error') return [`فشل الفهم: ${r.error}`]
  if (e.route && e.route !== r.route) reasons.push(`المسار ${r.route} والمتوقع ${e.route}`)
  // رد بلا إجراءات = answer ضمني
  const types = r.actions.length ? r.actions.map((a) => a.type) : ['answer']
  if (e.action_types?.length) {
    const bad = types.filter((t) => !e.action_types!.includes(t))
    if (bad.length) reasons.push(`إجراء غير متوقع: ${bad.join(', ')} (المسموح: ${e.action_types.join(', ')})`)
  }
  if (e.require_any?.length && !types.some((t) => e.require_any!.includes(t))) reasons.push(`مطلوب واحد من: ${e.require_any.join(', ')}`)
  for (const m of e.must_match ?? []) {
    const re = compile(m, reasons)
    if (re && !re.test(`${r.text}\n${r.payload ?? ''}`)) reasons.push(`لم يطابق /${m}/`)
  }
  for (const m of e.must_not ?? []) {
    if (m.startsWith('action:')) {
      const t = m.slice(7)
      if (types.includes(t)) reasons.push(`إجراء ممنوع: ${t}`)
      continue
    }
    const onPayload = m.startsWith('payload:')
    const re = compile(onPayload ? m.slice(8) : m, reasons)
    const hit = re?.exec(onPayload ? (r.payload ?? '') : r.text)
    if (hit) reasons.push(`${onPayload ? 'حمولة ممنوعة' : 'نص ممنوع'} «${hit[0].trim()}»`)
  }
  return reasons
}

const JUDGE_SYSTEM = `أنت حَكَم صارم لمساعد شخصي. تُعطى رسالة المالك، وتوقّعه بكلامه، ورد المساعد (مع أنواع إجراءاته).
هل الرد يحقق التوقع؟ أعد JSON فقط: {"pass":true|false,"why":"سبب قصير"}`

/** حَكَم بالنموذج على توقّع المالك الحر — فقط إن طُلب ووُجد نموذج */
export async function judge(llm: LlmClient, c: EvalCase, r: Replay): Promise<string | null> {
  try {
    const raw = await llm.complete(JUDGE_SYSTEM,
      `رسالة المالك: ${c.owner_message}\nتوقّعه: ${c.expected.notes}\nإجراءات المساعد: ${r.actions.map((a) => a.type).join(', ') || 'answer'}\nرد المساعد: ${r.text.slice(0, 1500)}\nالحمولة: ${(r.payload ?? '').slice(0, 600)}`)
    const j = extractJson(raw) as { pass?: boolean; why?: string }
    return j.pass === false ? `الحَكَم: ${String(j.why ?? 'لا يحقق التوقع').slice(0, 160)}` : null
  } catch { return null }
}

/** يغلّف النموذج ليعدّ الاستدعاءات والمخرجات المرفوضة (نفس عقد zod الذي يطبقه البوت) */
export function countingLlm(llm: LlmClient): { llm: LlmClient; stats: { calls: number; invalid: number } } {
  const stats = { calls: 0, invalid: 0 }
  return {
    stats,
    llm: {
      ...llm,
      async complete(system, user) {
        stats.calls++
        const raw = await llm.complete(system, user)
        // الحَكَم له شكل آخر — لا يُعد
        if (system !== JUDGE_SYSTEM && !parseLlmOutput(raw).ok) stats.invalid++
        return raw
      },
    },
  }
}

export interface RunOpts {
  llm: LlmClient | null
  model: string
  /** حد التوازي (افتراضياً ٢ — حصص المزوّدين المجانية صغيرة) */
  concurrency?: number
  /** نص فقط / صوت فقط / الكل */
  modality?: Modality | 'all'
  onResult?: (r: CaseResult) => void
}

export async function runEval(all: EvalCase[], o: RunOpts): Promise<EvalReport> {
  const started = new Date()
  const base = baseContext()
  const cases = o.modality && o.modality !== 'all' ? all.filter((c) => modalityOf(c) === o.modality) : all
  const counted = o.llm ? countingLlm(o.llm) : null
  const llm = counted?.llm ?? null
  const results: CaseResult[] = new Array(cases.length)
  let clarifies = 0, llmRoutes = 0
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= cases.length) return
      const c = cases[i]
      const id = c.name ?? (c.id != null ? `#${c.id}` : `case${i + 1}`)
      const modality = modalityOf(c)
      const t0 = Date.now()
      let res: CaseResult
      try {
        const r = await replay(c, llm, base)
        if (!r) res = { id, owner_message: c.owner_message, modality, status: 'skip', reasons: ['لا يوجد نموذج (لا مفاتيح)'], actions: [], text: '', ms: 0 }
        else {
          if (r.route === 'llm') { llmRoutes++; if (r.actions.some((a) => a.type === 'clarify')) clarifies++ }
          const reasons = check(c.expected, r)
          if (!reasons.length && c.expected.judge && c.expected.notes && llm && r.route === 'llm') {
            const j = await judge(llm, c, r)
            if (j) reasons.push(j)
          }
          res = { id, owner_message: c.owner_message, modality, status: r.route === 'error' ? 'error' : reasons.length ? 'fail' : 'pass',
            ...(guardOf(c) ? { guarded: guardOf(c)! } : {}), reasons, actions: r.actions.map((a) => a.type), text: r.text.slice(0, 600), ms: Date.now() - t0 }
        }
      } catch (err) {
        res = { id, owner_message: c.owner_message, modality, status: 'error', reasons: [String((err as any)?.message ?? err).slice(0, 200)], actions: [], text: '', ms: Date.now() - t0 }
      }
      results[i] = res
      o.onResult?.(res)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 2) }, worker))
  const count = (s: CaseResult['status']) => results.filter((r) => r.status === s).length
  const passed = count('pass'), failed = count('fail'), errors = count('error'), skipped = count('skip')
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0)
  const mod = (m: Modality) => {
    const g = results.filter((r) => r.modality === m && r.status !== 'skip')
    const p = g.filter((r) => r.status === 'pass').length
    return { graded: g.length, passed: p, score: pct(p, g.length) }
  }
  return {
    model: o.model, started_at: started.toISOString(), total: cases.length, passed, failed, errors, skipped,
    score: pct(passed, passed + failed + errors),
    score_guarded: pct(results.filter((r) => r.status === 'pass' || (r.guarded && r.status !== 'skip')).length, passed + failed + errors),
    clarify_rate: pct(clarifies, llmRoutes),
    invalid_outputs: counted?.stats.invalid ?? 0, calls: counted?.stats.calls ?? 0,
    by_modality: { text: mod('text'), voice: mod('voice') }, results,
  }
}

/** جدول نصي للطرفية/التعليق */
export function formatTable(rep: EvalReport, markdown = false): string {
  const icon = { pass: '✅', fail: '❌', error: '⚠️', skip: '⏭️' } as const
  const graded = rep.passed + rep.failed + rep.errors
  const summary = `Score: ${rep.score}% (${rep.passed}/${graded}) · with prod guards ${rep.score_guarded}% · text ${rep.by_modality.text.score}% (${rep.by_modality.text.passed}/${rep.by_modality.text.graded}) · voice ${rep.by_modality.voice.score}% (${rep.by_modality.voice.passed}/${rep.by_modality.voice.graded}) · clarify ${rep.clarify_rate}% · invalid JSON ${rep.invalid_outputs}/${rep.calls} · skipped ${rep.skipped}`
  const lines: string[] = []
  if (markdown) {
    lines.push(`### 🧪 Eval — ${rep.model}`, '', `**${summary}**`, '', '| | case | mod | message | actions | why |', '|---|---|---|---|---|---|')
    const cell = (s: string, n: number) => s.replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, n)
    for (const r of rep.results) lines.push(`| ${icon[r.status]}${r.guarded ? ' 🛡️' : ''} | ${r.id} | ${r.modality} | ${cell(r.owner_message, 50)} | ${r.actions.join(', ')} | ${cell(r.reasons.join('; '), 140)} |`)
  } else {
    for (const r of rep.results) lines.push(`${icon[r.status]}${r.guarded ? '🛡️' : '  '} ${r.id.padEnd(30)} ${r.modality === 'voice' ? '🎤' : '⌨️'} ${r.owner_message.replace(/\n/g, ' ').slice(0, 36).padEnd(36)}  [${r.actions.join(',')}] ${r.reasons.join('; ').slice(0, 160)}`)
    lines.push('', `${summary}  (${rep.model})`)
  }
  return lines.join('\n')
}
