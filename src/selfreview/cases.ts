/**
 * حالات التقييم (regression): كل تعثّر يُكتشف أو يصحّحه المالك يصير حالة تُعاد على الفهم الحقيقي
 * في `npm run eval` — حتى لا يرجع نفس الخطأ بعد أي تعديل كود.
 */
import type { Db } from '../db/index.js'
import { ensureSelfReviewSchema } from './schema.js'
import { MANUAL_CASE_RE, type Signal, type SignalKind, type Turn } from './signals.js'

/** دور في سياق الحالة. role=pending = طلب موافقة معلّق ظاهر للنموذج ("[N] ملخص") */
export interface CaseTurn { role: 'user' | 'assistant' | 'pending'; text: string; no?: number }

export interface Expected {
  /** كل إجراء ينتجه الفهم يجب أن يكون من هذه الأنواع (رد بلا إجراءات = answer). فارغ/غائب = لا قيد */
  action_types?: string[]
  /**
   * ممنوعات: "action:<type>" = إجراء ممنوع، وأي نص آخر = تعبير نمطي (regex، بلا حساسية لحالة الأحرف)
   * يُفحص على نص الرد كاملاً (reply + نص answer + سؤال/خيارات clarify). "payload:<regex>" يُفحص على حمولة الإجراءات.
   */
  must_not?: string[]
  /** يجب أن يظهر واحد على الأقل من هذه الإجراءات (مثل db_query للتحقيق قبل أي تعديل) */
  require_any?: string[]
  /** تعابير نمطية يجب أن تطابق النص أو حمولة الإجراءات (طلب الكود، سؤال القاعدة…) */
  must_match?: string[]
  /** fast = يجب أن يلتقطه مسار حتمي قبل النموذج (مثل "أي مودل أنت") */
  route?: 'fast' | 'llm'
  /** توقّع المالك بكلامه — يُستخدم للحَكَم (judge) إن طُلب */
  notes?: string
  /** حَكَم بالنموذج على notes (فقط عند توفر مفاتيح) */
  judge?: boolean
  /** الرد السيئ الذي رآه المالك (توثيق) */
  bad_reply?: string
}

export type CaseSource = 'selfreview' | 'manual' | 'seed'
export type CaseStatus = 'active' | 'draft' | 'retired'

export interface EvalCase {
  id?: number
  name?: string
  created_at?: Date
  owner_message: string
  context_turns: CaseTurn[]
  expected: Expected
  source: CaseSource
  status: CaseStatus
  /** نص مكتوب (يفهمه النموذج الأساسي) أو صوت (يفهمه Gemini دائماً في الإنتاج) — المقارنة تفصلهما */
  modality?: 'text' | 'voice'
}

const mapCase = (r: any): EvalCase => ({
  id: r.id, created_at: r.created_at instanceof Date ? r.created_at : new Date(r.created_at),
  owner_message: r.owner_message,
  context_turns: typeof r.context_turns === 'string' ? JSON.parse(r.context_turns) : r.context_turns,
  expected: typeof r.expected === 'string' ? JSON.parse(r.expected) : r.expected,
  source: r.source, status: r.status, modality: r.modality === 'voice' ? 'voice' : 'text',
})

/** فيها فحص فعلي (لا ملاحظة فقط) */
export function hasChecks(e: Expected): boolean {
  return !!(e.action_types?.length || e.must_not?.length || e.require_any?.length || e.must_match?.length || e.route || e.judge)
}

/** يحفظ حالة (مكررة = تُتجاهل). يرجع رقمها أو null إن كانت موجودة */
export async function saveCase(db: Db, c: EvalCase): Promise<number | null> {
  await ensureSelfReviewSchema(db)
  const rows = await db.query<{ id: number }>(
    `INSERT INTO eval_cases (owner_message, context_turns, expected, source, status, modality) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [c.owner_message.slice(0, 2000), JSON.stringify(c.context_turns), JSON.stringify(c.expected), c.source, c.status, c.modality ?? (/^🎤/.test(c.owner_message) ? 'voice' : 'text')])
  return rows[0]?.id ?? null
}

export async function listCases(db: Db, o: { status?: CaseStatus | 'all'; limit?: number } = {}): Promise<EvalCase[]> {
  await ensureSelfReviewSchema(db)
  const st = o.status ?? 'active'
  const rows = await db.query<any>(
    `SELECT * FROM eval_cases ${st === 'all' ? '' : 'WHERE status=$2'} ORDER BY id DESC LIMIT $1`,
    st === 'all' ? [o.limit ?? 200] : [o.limit ?? 200, st])
  return rows.map(mapCase)
}

const toCaseTurns = (ts: Turn[]): CaseTurn[] => ts.map((t) => ({ role: t.role, text: t.text.slice(0, 1200) }))

/** توقّع آلي من نوع التعثّر — قيود آمنة لا تُفشل رداً صحيحاً */
export function expectationFor(kinds: SignalKind[], badReply: string): Expected {
  const must_not = new Set<string>()
  const notes: string[] = []
  if (kinds.includes('clarify_loop')) { must_not.add('action:clarify'); notes.push('لا تسأل سؤال توضيح ثانٍ — نفّذ أو جاوب بصراحة') }
  if (kinds.includes('claim_no_action')) {
    must_not.add('(^|\\s)(تم|تمّ)\\s*(تأكيد|اختيار|التأكد|تنفيذ|تشغيل)'); notes.push('لا تقل «تم» بدون إجراء فعلي')
  }
  if (kinds.includes('failed') && /من معرفتي العامة/.test(badReply)) { must_not.add('action:web_search'); notes.push('ليس سؤال بحث ويب') }
  if (kinds.includes('repeated_ask') || kinds.includes('frustration') || kinds.includes('correction')) notes.push('الرد السابق ما حلّ الطلب — جاوب على نفس السؤال مباشرة')
  if (kinds.includes('not_found')) notes.push('لا تقل «ما لقيت» قبل ما تجرب المسار الصحيح')
  return { ...(must_not.size ? { must_not: [...must_not] } : {}), notes: notes.join('؛ '), bad_reply: badReply.slice(0, 400) }
}

/** حالة من حادثة كشفتها المراجعة الذاتية */
export function caseFromIncident(turns: Turn[], ownerIndex: number, signals: Signal[]): EvalCase | null {
  const owner = turns[ownerIndex]
  if (!owner || owner.role !== 'user') return null
  const bad = turns.slice(ownerIndex + 1).find((t) => t.role === 'assistant')?.text ?? ''
  const expected = expectationFor(signals.map((s) => s.kind), bad)
  return {
    owner_message: owner.text.replace(/^🎤\s*/, ''),
    context_turns: toCaseTurns(turns.slice(Math.max(0, ownerIndex - 6), ownerIndex)),
    expected, source: 'selfreview', status: hasChecks(expected) ? 'active' : 'draft',
    modality: /^🎤/.test(owner.text) ? 'voice' : 'text',
  }
}

/** كلمات في توقّع المالك تتحول لقيود حتمية */
export function expectationFromOwner(want: string, badReply: string): Expected {
  const must_not: string[] = []
  const types = new Set<string>()
  if (/(لا تسأل|بدون (اسئله|أسئلة|خيارات)|لا تعطيني خيارات|بلا خيارات|مو خيارات)/.test(want)) must_not.push('action:clarify')
  if (/(لا تبحث|مو بحث|بدون بحث|مو من النت)/.test(want)) must_not.push('action:web_search')
  if (/(لا تقول تم|لا تقل تم|لا تدعي|لا تدّعي)/.test(want)) must_not.push('(^|\\s)(تم|تمّ)(\\s|$)')
  if (/(كلود|claude|طلب كود|عدل الكود|يعدل الكود)/i.test(want)) types.add('code_change')
  if (/(ذكرني|تذكير)/.test(want)) types.add('set_reminder')
  if (/(مهمه|مهمة)/.test(want)) types.add('add_task')
  if (/(قاعده|قاعدة) (البيانات|بيانات)/.test(want)) types.add('db_query')
  if (/(جاوب|جواب|رد علي|تجاوبني|قل لي)/.test(want) && !types.size) types.add('answer')
  return {
    ...(types.size ? { action_types: [...types, ...(types.has('answer') ? [] : ['answer'])] } : {}),
    ...(must_not.length ? { must_not } : {}),
    notes: want.trim().slice(0, 500), judge: true, bad_reply: badReply.slice(0, 400),
  }
}

/**
 * "هذا غلط، المفروض <كذا>" بعد رد سيئ: آخر الأدوار (مع الرسالة الحالية في آخرها) ← حالة يدوية.
 * null = ليست هذه الصيغة؛ { error } = الصيغة صحيحة لكن لا يوجد رد سابق نبني عليه.
 */
export function manualCaseFrom(text: string, recent: { role: 'user' | 'assistant'; text: string }[]): EvalCase | { error: string } | null {
  const m = MANUAL_CASE_RE.exec(text.replace(/^🎤\s*/, '').trim())
  if (!m) return null
  const turns = [...recent]
  // الرسالة الحالية محفوظة أصلاً في السجل — نزيلها
  if (turns.length && turns[turns.length - 1].role === 'user' && turns[turns.length - 1].text.replace(/^🎤\s*/, '').trim() === text.replace(/^🎤\s*/, '').trim()) turns.pop()
  let b = turns.length - 1
  while (b >= 0 && turns[b].role !== 'assistant') b--
  let u = b - 1
  while (u >= 0 && turns[u].role !== 'user') u--
  if (b < 0 || u < 0) return { error: 'ما لقيت رداً سابقاً مني أحفظه كحالة 🤔 — قلها مباشرة بعد الرد الغلط.' }
  const expected = expectationFromOwner(m[1], turns[b].text)
  return {
    owner_message: turns[u].text.replace(/^🎤\s*/, ''),
    context_turns: turns.slice(Math.max(0, u - 6), u).map((t) => ({ role: t.role, text: t.text.slice(0, 1200) })),
    expected, source: 'manual', status: 'active', modality: /^🎤/.test(turns[u].text) ? 'voice' : 'text',
  }
}
