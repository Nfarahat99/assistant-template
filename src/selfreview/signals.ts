/**
 * كشف التعثّرات في محادثة اليوم — حتمي بالكامل (regex + قواعد)، بلا نموذج.
 * النموذج يُستخدم لاحقاً للتجميع والتلخيص فقط (review.ts)، والكشف لا يعتمد عليه أبداً.
 */
import { ownerName, assistantName } from '../profile.js'
import { normalizeArabic } from '../lib/arabic.js'
import { toLatinDigits } from '../lib/phone.js'
import { BG_MARK } from '../lib/code-context.js'

export interface Turn { role: 'user' | 'assistant'; text: string; at: Date }

export type SignalKind =
  | 'correction'        // المالك صحّح: "لا غلط" / "مو كذا" / "خطأ"
  | 'frustration'       // "طولت" / "ليش" / "جاوبني على السؤال"
  | 'repeated_ask'      // نفس الطلب مرتين فأكثر
  | 'clarify_loop'      // سؤالا توضيح (خيارات مرقّمة) متتاليان أو أكثر
  | 'claim_no_action'   // "تم" بلا إجراء منفَّذ
  | 'failed'            // فشل/احتياط: "❌ فشل"، "ما قدرت أفهم"، "من معرفتي العامة"…
  | 'not_found'         // "ما لقيت" / "ما أقدر"

export interface Signal {
  kind: SignalKind
  /** فهرس الدور المعني في turns (رد البوت السيئ، أو رسالة المالك للتصحيح/التذمر) */
  index: number
  at: Date
  quote: string
  detail: string
}

/** وزن الخطورة — للترتيب واختيار أهم ٣ */
export const SEVERITY: Record<SignalKind, number> = {
  correction: 5, clarify_loop: 5, claim_no_action: 5, repeated_ask: 4, frustration: 3, failed: 3, not_found: 2,
}

export const KIND_AR: Record<SignalKind, string> = {
  correction: 'تصحيح منك', frustration: 'تذمّر', repeated_ask: 'طلب متكرر', clarify_loop: 'حلقة أسئلة توضيح',
  claim_no_action: 'ادّعاء تنفيذ بلا إجراء', failed: 'فشل/احتياط', not_found: '«ما لقيت/ما أقدر»',
}

const B = '(?:^|[\\s،,.«])'
const E = '(?=$|[\\s،,.!؟?»])'
/** تصحيح صريح في أي مكان */
const CORRECTION_ANY = new RegExp(`${B}(لا\\s*غلط|لا\\s*خطأ|مو\\s*كذا|مب\\s*كذا|مو\\s*هذا\\s*قصدي|مو\\s*هذا\\s*اللي)${E}`)
/** "غلط/خطأ" وحدها: فقط في أول الكلام (وإلا فهي وصف لبيانات: "الزي غلط في النظام") */
const CORRECTION_HEAD = new RegExp(`^\\s*(?:\\S+\\s+){0,2}(غلط|خطأ|خطا)${E}`)
/** تذمّر صريح في أي مكان */
const FRUSTRATION_ANY = new RegExp(`(طولت|طوّلت|مو\\s*راضي|ما\\s*فهمتني|جاوبني\\s*على\\s*السؤال|جاوب\\s*على\\s*سؤالي|كم\\s*مر[هة]\\s*اقول|قلت\\s*لك)`)
/** "ليش/ليه" — تذمّر فقط في رسالة قصيرة (في البلاغ الطويل هو سؤال عن خلل في مشروع) */
const WHY_SHORT = new RegExp(`${B}(ليش|ليه)${E}`)
const NOT_FOUND_RE = /(ما\s*لقيت|مالقيت|ما\s*أقدر|ما\s*اقدر|ما\s*قدرت)/
/** يحذف صدى الصوتية «…» في أول رد البوت */
const stripEcho = (s: string) => s.replace(/^🎤\s*«[\s\S]*?»\s*/, '')
const FAILED_RE = /(❌\s*فشل|فشل الدمج|ما قدرت أفهم طلبك|صار خطأ عندي|النموذج الأساسي متعثّر|📚 من معرفتي العامة|لم أتلق سؤال|ما فتح PR|انتهى بحالة ❌)/
/** "تم" كادعاء: كلمة مستقلة أو "تم تأكيد/اختيار/تنفيذ…" */
const CLAIM_RE = /(^|[\s،,.])(تم|تمّ)(?=$|[\s،,.!✅👍])/
/** علامات إجراء فعلي يطبعها الكود نفسه (لا النموذج) — وجودها ينفي الادعاء */
const ACTION_MARKERS = /(📝 أضفت|⏰ ضبطت|✅ خلصت|^\[\d+\]|\n\[\d+\]|🚀 أرسلت|✅ دمجته|🧠 تعلّمت|🗑️ حذفت|👤 حفظت|📌 |🔎 جالس|✅ انتشر)/
/** رد يعرض خيارات مرقّمة للاختيار (سؤال توضيحي) */
export function isClarify(text: string): boolean {
  const t = toLatinDigits(text)
  return /رد برقم الخيار/.test(t) || (/(^|\n)\s*1\.\s.+\n\s*2\.\s/.test(t) && /[؟?]/.test(t))
}

/** موافقات/أرقام/كلمات قصيرة لا تُعد "طلباً" في كشف التكرار */
function isApprovalish(text: string): boolean {
  const t = toLatinDigits(text).trim()
  return /^(نعم|لا|عدل|عدّل|الغ|تمام|اوكي|ok)\s*\d*\s*$/i.test(t) || /^\d{1,3}$/.test(t) || t.length < 4
}

const STOP = new Set(['في', 'من', 'على', 'الى', 'الي', 'عن', 'و', 'يا', 'هل', 'انا', 'انت', 'هذا', 'هذي', 'اللي', 'الي', 'لي', 'لك', 'ما', 'مو', 'شي', 'ابي', 'ابغى', 'احتاج', 'مشروع', 'نظام'])
/** "هذا غلط، المفروض …" — أمر حفظ حالة تقييم (ليس إشارة تصحيح عادية) */
export const MANUAL_CASE_RE = /^\s*(?:لا[،,\s]+)?(?:هذا|هذي|ردك|الرد)\s+(?:غلط|خطأ|خطا)\s*[،,.:\-–]?\s*(?:المفروض|الصح|الصحيح|كان المفروض)\s*[:：]?\s*([\s\S]{2,})$/
export const isManualCaseCommand = (text: string) => MANUAL_CASE_RE.test(text.replace(/^🎤\s*/, ''))

function tokens(text: string): Set<string> {
  return new Set(normalizeArabic(text.replace(/^🎤\s*/, '')).split(' ').filter((w) => w.length >= 2 && !STOP.has(w)))
}
export function similarity(a: string, b: string): number {
  const A = tokens(a), T = tokens(b)
  // كلمة أو كلمتان (اختيار من خيارات، اسم مشروع) لا تكفي للحكم بالتكرار
  if (A.size < 3 || T.size < 3) return 0
  let inter = 0
  for (const w of A) if (T.has(w)) inter++
  return inter / Math.min(A.size, T.size)
}

const clip = (s: string, n = 160) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

export interface DetectOpts {
  /** هل سُجّل إجراء فعلي (مهمة/طلب معلّق/طلب كود) قرب هذا الوقت؟ — من القاعدة. غيابه = نعتمد على علامات النص فقط */
  actionNear?: (at: Date) => boolean
  /** نافذة التكرار (افتراضياً ٣٠ دقيقة) */
  repeatWindowMs?: number
}

/** كل الإشارات في أدوار اليوم (مرتبة زمنياً) */
export function detectSignals(turns: Turn[], opts: DetectOpts = {}): Signal[] {
  const out: Signal[] = []
  const win = opts.repeatWindowMs ?? 30 * 60_000
  let clarifyRun: number[] = []
  const flushClarify = () => {
    if (clarifyRun.length >= 2) {
      const first = clarifyRun[0]
      out.push({ kind: 'clarify_loop', index: first, at: turns[first].at, quote: clip(turns[first].text),
        detail: `${clarifyRun.length} أسئلة توضيح متتالية بدل ما ينفّذ أو يجاوب` })
    }
    clarifyRun = []
  }
  const repeatedSeen = new Set<number>()

  turns.forEach((t, i) => {
    if (t.role === 'user') {
      const text = t.text.replace(/^🎤\s*/, '')
      const words = text.trim().split(/\s+/).length
      if ((CORRECTION_ANY.test(text) || CORRECTION_HEAD.test(text)) && !isManualCaseCommand(text)) {
        out.push({ kind: 'correction', index: i, at: t.at, quote: clip(text), detail: 'صحّحت ردي/فهمي' })
      } else if (FRUSTRATION_ANY.test(text) || (words <= 6 && WHY_SHORT.test(text))) {
        out.push({ kind: 'frustration', index: i, at: t.at, quote: clip(text), detail: 'سؤال/تذمّر يدل إن الرد السابق ما كفّى' })
      }
      // نفس الطلب مرتين خلال النافذة (لا الموافقات ولا الأرقام)
      if (!isApprovalish(text) && !repeatedSeen.has(i)) {
        for (let j = i + 1; j < turns.length; j++) {
          const u = turns[j]
          if (u.at.getTime() - t.at.getTime() > win) break
          if (u.role !== 'user' || isApprovalish(u.text) || repeatedSeen.has(j)) continue
          if (similarity(text, u.text) >= 0.6) {
            repeatedSeen.add(j)
            out.push({ kind: 'repeated_ask', index: j, at: u.at, quote: clip(u.text.replace(/^🎤\s*/, '')),
              detail: `طلبته قبل (${clip(text, 60)}) وما انحل من أول مرة` })
            break
          }
        }
      }
      return
    }
    // ── ردود البوت ──
    // إشعار تلقائي (نشر، PR جاهز، سؤال Claude…) يُحفظ في السجل بعلامة BG_MARK — ليس رداً على المالك
    const bg = t.text.startsWith(BG_MARK)
    const text = stripEcho(bg ? t.text.slice(BG_MARK.length) : t.text)
    // الرد الفعلي = أول رد بوت بعد رسالة المالك؛ ما بعده إشعارات خلفية (نشر، PR جاهز، سؤال Claude) — لا تقطع الحلقة ولا تُحسب منها
    let j = i - 1
    while (j >= 0 && turns[j].role === 'assistant' && turns[j].text.startsWith(BG_MARK)) j--
    const isReply = !bg && j >= 0 && turns[j].role === 'user' && (j === i - 1 || turns.slice(j + 1, i).every((x) => x.text.startsWith(BG_MARK)))
    if (isReply) {
      if (isClarify(text)) clarifyRun.push(i)
      else flushClarify()
    }
    const nf = NOT_FOUND_RE.exec(text)
    if (FAILED_RE.test(text)) out.push({ kind: 'failed', index: i, at: t.at, quote: clip(text), detail: 'فشل أو رد احتياطي' })
    else if (nf && nf.index < 40) out.push({ kind: 'not_found', index: i, at: t.at, quote: clip(text), detail: 'قلت ما لقيت/ما أقدر' })
    if (!bg && CLAIM_RE.test(text) && !ACTION_MARKERS.test(text) && !(opts.actionNear?.(t.at) ?? false)) {
      out.push({ kind: 'claim_no_action', index: i, at: t.at, quote: clip(text), detail: 'قلت «تم» وما فيه أي إجراء منفَّذ مسجّل' })
    }
  })
  flushClarify()
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index)
}

export interface Incident {
  id: number
  signals: Signal[]
  score: number
  /** رسالة المالك التي سبقت أول رد سيئ — مدخل حالة التقييم */
  ownerIndex: number
  /** مقتطف المحادثة (حتى ٨ أدوار) — دليل يُرفق بطلب الإصلاح */
  excerpt: Turn[]
}

/** يجمع الإشارات المتقاربة (≤ ٥ دقائق) في حادثة واحدة، ويرتبها بالخطورة */
export function groupIncidents(turns: Turn[], signals: Signal[], gapMs = 5 * 60_000): Incident[] {
  const groups: Signal[][] = []
  for (const s of signals) {
    const g = groups[groups.length - 1]
    if (g && s.at.getTime() - g[g.length - 1].at.getTime() <= gapMs) g.push(s)
    else groups.push([s])
  }
  return groups.map((g, k) => {
    const first = Math.min(...g.map((s) => s.index))
    const last = Math.max(...g.map((s) => s.index))
    let ownerIndex = first
    while (ownerIndex >= 0 && turns[ownerIndex]?.role !== 'user') ownerIndex--
    // التصحيح/التذمر رسالة مالك بنفسه: المدخل هو رسالة المالك التي سبقت رد البوت الذي صُحِّح
    if (ownerIndex === first && turns[first]?.role === 'user' && g.every((s) => s.kind === 'correction' || s.kind === 'frustration')) {
      let j = first - 1
      while (j >= 0 && turns[j].role !== 'user') j--
      if (j >= 0) ownerIndex = j
    }
    if (ownerIndex < 0) ownerIndex = Math.max(0, first)
    const from = Math.max(0, Math.min(ownerIndex, first) - 2)
    const excerpt = turns.slice(from, Math.min(turns.length, Math.max(last, ownerIndex) + 2)).slice(-8)
    const kinds = new Set(g.map((s) => s.kind))
    const score = [...kinds].reduce((a, k) => a + SEVERITY[k], 0) + g.length * 0.1
    return { id: k + 1, signals: g, score, ownerIndex, excerpt }
  }).sort((a, b) => b.score - a.score || a.id - b.id)
}

/** عدد المحادثات = جلسات يفصل بينها ٣٠ دقيقة صمت من المالك */
export function countConversations(turns: Turn[], gapMs = 30 * 60_000): number {
  let n = 0, last = -Infinity
  for (const t of turns) {
    if (t.role !== 'user') continue
    if (t.at.getTime() - last > gapMs) n++
    last = t.at.getTime()
  }
  return n
}

/** مقتطف نصي للدليل (طلب الكود، الرسالة) */
export function excerptText(ex: Turn[], max = 700): string {
  const lines = ex.map((t) => `${t.role === 'user' ? ownerName() : assistantName()}: ${clip(t.text, 180)}`)
  let s = lines.join('\n')
  while (s.length > max && lines.length > 2) { lines.shift(); s = lines.join('\n') }
  return s.slice(0, max)
}

/** يقرأ سطور سجل محادثة (HH:MM:SS بتوقيت UTC، owner|bot | نص، و ⏎ = سطر جديد) — للاختبارات والبذور */
export function parseTranscript(raw: string, day = '2026-10-05'): Turn[] {
  const out: Turn[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\d{2}):(\d{2}):(\d{2}) (owner|bot) \| ([\s\S]*)$/.exec(line)
    if (!m) continue
    out.push({ role: m[4] === 'owner' ? 'user' : 'assistant', text: m[5].replace(/ ⏎ /g, '\n').replace(/⏎/g, '\n'),
      at: new Date(`${day}T${m[1]}:${m[2]}:${m[3]}Z`) })
  }
  return out
}
