import type { Store } from '../store.js'
import type { LlmClient } from '../ai/providers.js'
import { normalizeArabic } from '../lib/arabic.js'
import { toArabicDigits } from '../lib/phone.js'
import { logger } from '../logger.js'
import { QUESTIONS } from './questions.js'
import { finalize as defaultFinalize, isMarkerLine, type FinalizeResult, type InterviewSettings } from './finalize.js'

/**
 * المقابلة الشخصية داخل المحادثة: ٨ أسئلة تبني ذاكرة المساعد عن مالكه.
 * الحالة في kv (onboarding_state) فتنجو من إعادة التشغيل؛ المخرجات في knowledge_md / onboarding_tracks / onboarding_style.
 * لا شيء هنا يرسل لأي طرف ثالث — المخرج نصوص تُحفظ في kv فقط.
 */

export const STATE_KEY = 'onboarding_state'
export const PENDING_REQUEST_KEY = 'onboarding_pending_request'
export const TRACKS_KEY = 'onboarding_tracks'
export const STYLE_KEY = 'onboarding_style'
/** نسخة الذاكرة قبل آخر مقابلة (إن لم تكن قالباً) — إعادة المقابلة قابلة للتراجع */
export const PREV_KNOWLEDGE_KEY = 'knowledge_md_prev'

export interface OnboardingState {
  status: 'active' | 'stopped' | 'done'
  index: number
  answers: Record<string, string>
  startedAt: string
  /** أعادها المالك من اللوحة ← تبدأ من جديد مع رسالته التالية */
  restart?: boolean
  /** «ابدأ المقابلة» والذاكرة مكتوبة ← ننتظر «نعم ابدأ» (أي رد غيرها يلغي ويُعالج عادياً) */
  confirmRestart?: boolean
  /** أثناء التلخيص: النسخة السابقة حُفظت (saved) أو كانت قالباً (none) — لا تُحفظ مرتين بعد تعطّل */
  prev?: 'saved' | 'none'
  /** بعد النهاية: العدد فقط — الإجابات الخام تُمسح (خصوصية) */
  answered?: number
  skipped?: number
}

type KvStore = Pick<Store, 'getKv' | 'setKv'>
type FinalizeFn = (llm: LlmClient | null, answers: Record<string, string>) => Promise<FinalizeResult>
/** يطبّق مواعيد الملخّصات عبر نفس تحقق وحفظ اللوحة (Settings.update) — true = طُبّقت */
export type ApplySettingsFn = (patch: { morning_brief_at?: string; evening_review_at?: string }) => Promise<boolean>

const MAX_ANSWER = 4000
export const EDIT_HINT = 'تقدر تعدّل ذاكرتي من اللوحة ← الإعدادات ← ملف المعرفة'
export const BRIEFS_PATH = 'اللوحة ← الإعدادات ← مواعيد الملخّصات'
export const RESTART_CONFIRM = 'بتنعاد المقابلة وتنكتب الذاكرة من جديد — أكيد؟ قل «نعم ابدأ»'

/** ذاكرة فارغة أو ما زالت قالب knowledge/owner.md (فيها سطر «يُولَّد هذا الملف من الاستبيان») */
export function isPlaceholderKnowledge(md: string | null | undefined): boolean {
  if (!md || !md.trim()) return true
  return md.split('\n').some((l) => l.trim().startsWith('>') && isMarkerLine(l))
}

/** «نعم ابدأ» (مطبّعة: بلا همزات/تشكيل، و«المقابلة» اختيارية) — تأكيد إعادة المقابلة */
export function isRestartConfirm(text: string): boolean {
  return /^نعم\s+(ابدا|ابدء|ابدي)(\s+(ب\s*)?مقابله)?$/.test(normalizeArabic(text).trim())
}

// مطبّعة بنفس normalizeArabic (يحذف «ال» من الكلمات الطويلة: «السلام» ← «سلام»)
const norm = (xs: string[]) => xs.map(normalizeArabic).join('|')
const GREETING_RE = new RegExp(`^(${norm(['هلا والله', 'هلا', 'السلام عليكم', 'مرحبا', 'هاي', 'hi', 'hello', 'صباح الخير', 'مساء الخير', 'شلونك', 'كيفك', 'كيف الحال'])})(\\s+(${norm(['ورحمة الله', 'وبركاته', 'والله', 'حبيبي', 'اليوم'])}|يا \\S+))*$`)

/** تحية أو سؤال عن الحال — ليس طلباً يُؤجَّل لما بعد المقابلة (الطلب القصير مثل «مهامي» يُؤجَّل عادي) */
export function isChitChat(text: string): boolean {
  const t = normalizeArabic(text).trim()
  return GREETING_RE.test(t)
}

/** "07:00" ← "٧:٠٠" */
const clockAr = (hhmm: string) => toArabicDigits(hhmm.replace(/^0(\d)/, '$1'))

export type InterviewCommand = 'start' | 'resume' | 'stop' | 'skip'

/** أوامر المقابلة — تتحمّل الشدة والهمزات والصيغ الشائعة («كمل»، «تخطى»، «تخطي»، «أوقف»…) */
export function interviewCommand(text: string): InterviewCommand | null {
  const t = normalizeArabic(text).trim()
  if (/^(ابدا|ابدء|ابدي|بدا|نبدا|خلنا نبدا)\s+(ب\s*)?مقابله$/.test(t)) return 'start'
  if (/^(كمل|نكمل|خلنا نكمل|كملي|واصل|استانف|ارجع)\s+(ل\s*)?مقابله$/.test(t)) return 'resume'
  if (/^(وقف|اوقف|وقفي|قف|اقف|اقاف)\s+مقابله$/.test(t)) return 'stop'
  if (/^(تخط|تخطي|تخطا|تخطاه|تخطاها|تجاوز|تجاوزه|سكيب|skip)$/.test(t)) return 'skip'
  return null
}

export async function readState(store: Pick<Store, 'getKv'>): Promise<OnboardingState | null> {
  try {
    const s = JSON.parse((await store.getKv(STATE_KEY)) ?? 'null')
    return s && typeof s === 'object' && typeof s.status === 'string' ? { answers: {}, index: 0, startedAt: '', ...s } : null
  } catch { return null }
}

/** «إعادة المقابلة» من اللوحة: الحالة تُصفَّر وتبدأ مع رسالة المالك التالية — الذاكرة الحالية لا تُمس حتى تنتهي */
export async function resetInterview(store: Pick<Store, 'setKv'>): Promise<OnboardingState> {
  const s: OnboardingState = { status: 'stopped', index: 0, answers: {}, startedAt: '', restart: true }
  await store.setKv(STATE_KEY, JSON.stringify(s))
  await store.setKv(PENDING_REQUEST_KEY, '')
  return s
}

export class Interview {
  constructor(
    private store: KvStore,
    private now: () => Date,
    private llm: LlmClient | null = null,
    private finalizeFn: FinalizeFn = defaultFinalize,
    private applySettings: ApplySettingsFn | null = null,
  ) {}

  state(): Promise<OnboardingState | null> { return readState(this.store) }

  private save(s: OnboardingState) { return this.store.setKv(STATE_KEY, JSON.stringify(s)) }

  async active(): Promise<boolean> {
    return (await this.state())?.status === 'active'
  }

  /** من البداية (يمسح أي إجابات سابقة لم تكتمل) ← السؤال الأول */
  async start(): Promise<string> {
    await this.save({ status: 'active', index: 0, answers: {}, startedAt: this.now().toISOString() })
    return QUESTIONS[0].ask()
  }

  async handle(text: string): Promise<{ reply: string; done: boolean }> {
    const s = await this.state()
    if (!s || s.status !== 'active') return { reply: 'ما فيه مقابلة شغالة — قل «ابدأ المقابلة» لو تبي نبدأ.', done: false }
    // تلخيص لم يكتمل: لا تسجيل ولا زيادة للمؤشر بعد عدد الأسئلة
    if (s.index >= QUESTIONS.length) return { reply: await this.finish(s), done: true }
    const q = QUESTIONS[s.index]
    if (q && interviewCommand(text) !== 'skip') {
      const a = text.trim().slice(0, MAX_ANSWER)
      if (a) s.answers[q.id] = a
    }
    s.index++
    // الإجابة تُحفظ قبل التلخيص: لو تعطّل finalize أو أُعيد التشغيل، «كمّل المقابلة» يكمل التلخيص بلا فقد
    await this.save(s)
    if (s.index < QUESTIONS.length) return { reply: QUESTIONS[s.index].ask(), done: false }
    return { reply: await this.finish(s), done: true }
  }

  async stop(): Promise<string> {
    const s = await this.state()
    const dropped = await this.dropPendingRequest()
    // إعادة من اللوحة لم تبدأ بعد ← «وقف المقابلة» يلغيها
    if (s?.restart) {
      await this.save({ ...s, restart: undefined })
      return 'تمام، ألغيت إعادة المقابلة 👌' + dropped
    }
    if (!s || s.status !== 'active') return 'ما فيه مقابلة شغالة 👌' + dropped
    await this.save({ ...s, status: 'stopped' })
    return `تمام، وقفت المقابلة ⏸️ (جاوبت ${toArabicDigits(s.index)} من ${toArabicDigits(QUESTIONS.length)}) — قل «كمّل المقابلة» متى ما بغيت.` + dropped
  }

  /** الطلب المؤجَّل من أول رسالة لا يبقى معلّقاً بعد الإيقاف — يُبلَّغ المالك ليعيد إرساله */
  private async dropPendingRequest(): Promise<string> {
    const req = (await this.store.getKv(PENDING_REQUEST_KEY))?.trim()
    if (!req) return ''
    await this.store.setKv(PENDING_REQUEST_KEY, '')
    return '\nطلبك اللي أرسلته قبل المقابلة ما نفّذته — أرسله مرة ثانية لو تبيه.'
  }

  /** «ابدأ المقابلة» والذاكرة مكتوبة: نسأل قبل الإعادة */
  async askRestart(): Promise<string> {
    const s = await this.state()
    await this.save({ ...(s ?? { status: 'stopped', index: 0, answers: {}, startedAt: '' }), confirmRestart: true })
    return RESTART_CONFIRM
  }

  /** سؤال التأكيد يُجاب مرة واحدة — أي رد يلغيه */
  async clearRestartAsk(): Promise<void> {
    const s = await this.state()
    if (s?.confirmRestart) await this.save({ ...s, confirmRestart: undefined })
  }

  /** يكمل من نفس السؤال؛ بلا مقابلة سابقة (أو أعادها من اللوحة) ← من البداية */
  async resume(): Promise<string> {
    const s = await this.state()
    if (!s || s.restart) return this.start()
    if (s.status === 'done') return `المقابلة مخلّصة ✅ — لو تبي تعيدها قل «ابدأ المقابلة».`
    if (s.index >= QUESTIONS.length) return (await this.finish(s))
    await this.save({ ...s, status: 'active', restart: undefined })
    return QUESTIONS[s.index].ask()
  }

  private async finish(s: OnboardingState): Promise<string> {
    const out = await this.finalizeFn(this.llm, s.answers)
    // النسخة السابقة (تعديلات اللوحة أو مقابلة سابقة) تُحفظ قبل الكتابة فوقها — مرة واحدة حتى لو تعطّل التلخيص وأُعيد
    if (!s.prev) {
      const prev = await this.store.getKv('knowledge_md')
      const real = !isPlaceholderKnowledge(prev)
      if (real) await this.store.setKv(PREV_KNOWLEDGE_KEY, prev!)
      s = { ...s, prev: real ? 'saved' : 'none' }
      await this.save(s)
    }
    const at = this.now().toISOString()
    await this.store.setKv('knowledge_md', out.knowledgeMd)
    await this.store.setKv('knowledge_md_updated_at', at)
    await this.store.setKv(TRACKS_KEY, JSON.stringify(out.tracks))
    await this.store.setKv(STYLE_KEY, out.style)
    const applied = await this.applyBriefTimes(out.settings)
    const answers = s.answers
    const answered = QUESTIONS.filter((q) => answers[q.id]?.trim()).length
    // خصوصية: الإجابات الخام لا تبقى بعد النهاية (الذاكرة نفسها في knowledge_md وتُعدَّل من اللوحة) — العدد فقط
    await this.save({ status: 'done', index: QUESTIONS.length, answers: {}, startedAt: s.startedAt, answered, skipped: QUESTIONS.length - answered })
    const tracks = out.tracks.map((t) => t.name).filter(Boolean)
    const times = [
      applied.morning_brief_at && `الملخص الصباحي ${clockAr(applied.morning_brief_at)}`,
      applied.evening_review_at && `المسائي ${clockAr(applied.evening_review_at)}`,
    ].filter(Boolean)
    return [
      'خلصنا ✅',
      `🧠 حفظت ذاكرتي عنك (جاوبت ${toArabicDigits(answered)} من ${toArabicDigits(QUESTIONS.length)})`,
      ...(s.prev === 'saved' ? ['🗂️ حفظت النسخة السابقة من ذاكرتي احتياط'] : []),
      `🧭 المسارات: ${tracks.length ? tracks.slice(0, 6).join('، ') : 'ما تحددت بعد'}`,
      `✍️ الأسلوب: ${out.style.trim() ? 'حفظت طريقة كتابتك' : 'لم يُذكر'}`,
      times.length ? `⏰ ضبطت ${times.join('، ')} (تغيّرها من ${BRIEFS_PATH})` : `⏰ مواعيد الملخّصات تضبطها من ${BRIEFS_PATH}`,
      EDIT_HINT,
    ].join('\n')
  }

  /** مواعيد الملخّصات اللي ذكرها المالك فقط ← نفس تحقق وحفظ اللوحة؛ أي فشل = لا شيء طُبّق (الملخص يدلّه على اللوحة) */
  private async applyBriefTimes(st: InterviewSettings | undefined): Promise<{ morning_brief_at?: string; evening_review_at?: string }> {
    const patch: { morning_brief_at?: string; evening_review_at?: string } = {}
    if (st?.morning_brief_at) patch.morning_brief_at = st.morning_brief_at
    if (st?.evening_review_at) patch.evening_review_at = st.evening_review_at
    if (!this.applySettings || !Object.keys(patch).length) return {}
    try {
      return (await this.applySettings(patch)) ? patch : {}
    } catch (err) {
      logger.warn({ err: String(err) }, 'تعذّر تطبيق مواعيد الملخّصات من المقابلة')
      return {}
    }
  }
}
