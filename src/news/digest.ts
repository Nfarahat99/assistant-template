/**
 * موجز AI: جلب ← تحقق ← نافذة ٢٤س (تتوسع لـ ٧٢س) ← منع التكرار (رابط مطبّع + تداخل العناوين) ← ترتيب وتنويع ← صياغة عربية.
 * الحقائق (العنوان/الرابط/التاريخ/المصدر) من بيانات المصدر فقط؛ النموذج يكتب النثر فقط ولا يستطيع حقن روابط أو تواريخ.
 */
import { ownerName, profile } from '../profile.js'
import { fetchAllSources, fetchTavily, effectiveTime, SOURCE_LABEL, type FetchFn, type NewsItem, type SourceResult } from './sources.js'

// ───── منع التكرار ─────

const TRACKING = /^(utm_\w+|ref|ref_src|source|fbclid|gclid|mc_cid|mc_eid|igshid|si|s|cmpid|campaign|via|_hsenc|_hsmi|rss|feed)$/i

/** رابط مطبّع: مضيف صغير بلا www، بلا #، بلا معاملات التتبع، بلا / أخيرة */
export function normalizeUrl(u: string): string {
  try {
    const x = new URL(u)
    x.hash = ''
    x.hostname = x.hostname.toLowerCase().replace(/^www\./, '')
    x.protocol = 'https:'
    for (const k of [...x.searchParams.keys()]) if (TRACKING.test(k)) x.searchParams.delete(k)
    x.searchParams.sort()
    x.pathname = x.pathname.replace(/\/+$/, '') || '/'
    const s = x.toString()
    return x.pathname === '/' && !x.search ? s.replace(/\/$/, '') : s
  } catch { return u.trim().toLowerCase() }
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'by', 'from', 'at', 'as', 'its', 'it', 'new', 'how', 'why', 'what', 'show', 'hn', 'ask', 'your', 'you', 'this', 'that', 'now', 'via'])
export const titleTokens = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s.]/gu, ' ').split(/\s+/)
  .map((w) => w.replace(/^\.+|\.+$/g, '')).filter((w) => w.length > 1 && !STOP.has(w)))

/** نفس الخبر بعنوانين؟ تداخل ≥ ٧٠٪ من العنوان الأقصر (بحد أدنى ٣ كلمات مشتركة) */
export function sameStory(a: string, b: string): boolean {
  const A = titleTokens(a), B = titleTokens(b)
  if (!A.size || !B.size) return false
  let common = 0
  for (const w of A) if (B.has(w)) common++
  const small = Math.min(A.size, B.size)
  return common >= Math.min(3, small) && common / small >= 0.7
}

// ───── الترتيب ─────

/** اهتمامات المالك — الوزن 2 للأهم مباشرة، 1 للعام */
export const PROFILE: [RegExp, number][] = [
  [/claude code|claude/i, 2], [/\bmcp\b|model context protocol/i, 2], [/\bagents?\b|agentic|coding agent/i, 2], [/\bskills?\b/i, 1],
  [/anthropic/i, 2], [/gemini/i, 2], [/openai|chatgpt|\bgpt[-\w.]*/i, 2], [/next\.?js|vercel/i, 1.5], [/node\.?js|\bnode\b|typescript|\bbun\b|deno/i, 1],
  [/railway/i, 1.5], [/whatsapp|telegram|\bbots?\b/i, 1.5], [/edtech|education|students?|teachers?|learning platform|tutor/i, 1.5],
  [/saudi|arabic|\barab\b|riyadh|\bmena\b|\bgulf\b|uae|عرب|سعود/i, 2], [/open[- ]?(source|weights?|models?)|llama|qwen|deepseek|mistral|gemma/i, 1.5],
  [/cursor|copilot|codex|devin|windsurf|code (gen|review|assistant)/i, 1.5], [/\bllms?\b|language model|reasoning/i, 1], [/\bai\b|artificial intelligence/i, 0.5],
]

export const SOURCE_WEIGHT: Record<string, number> = {
  smol: 1, simon: 1, latent: 1, anthropic: 1, openai: 0.8, hn: 0.6, github: 0.6, techmeme: 0.6, tldr: 0.6,
  hf_papers: 0.5, hf_models: 0.5, tavily: 0.4, arxiv: 0.2,
}

export interface Scored extends NewsItem { score: number; url_norm: string }

export function keywordScore(it: NewsItem): number {
  let s = 0
  for (const [re, w] of PROFILE) {
    if (re.test(it.title)) s += w * 1.5
    else if (re.test(it.snippet)) s += w * 0.5
  }
  return Math.min(s, 8)
}

export function scoreItems(items: NewsItem[], now: Date): Scored[] {
  const maxBySource = new Map<string, number>()
  for (const it of items) maxBySource.set(it.source, Math.max(maxBySource.get(it.source) ?? 0, it.signal))
  return items.map((it) => {
    const max = maxBySource.get(it.source) ?? 0
    const sig = max > 0 ? Math.log1p(it.signal) / Math.log1p(max) : 0
    const ageH = (now.getTime() - Math.min(now.getTime(), effectiveTime(it))) / 3600_000
    const recency = Math.max(0, 1 - ageH / 72)
    // وزن المصدر مضاعِف: ورقة arXiv بكلمات مطابقة لا تتفوق على خبر مهم من مصدر منسَّق
    const score = (1 + keywordScore(it) + 2 * sig + recency) * (0.5 + (SOURCE_WEIGHT[it.source] ?? 0.4))
    return { ...it, score: Math.round(score * 100) / 100, url_norm: normalizeUrl(it.url) }
  })
}

/** يزيل التكرار داخل الدفعة: نفس الرابط المطبّع أو نفس القصة — يبقى الأعلى درجة */
export function dedupeBatch(items: Scored[]): Scored[] {
  const out: Scored[] = []
  for (const it of [...items].sort((a, b) => b.score - a.score)) {
    if (out.some((o) => o.url_norm === it.url_norm || sameStory(o.title, it.title))) continue
    out.push(it)
  }
  return out
}

/** الأعلى درجة مع حد بندين لكل مصدر */
/** مصادر منخفضة القيمة كخبر يومي: بند واحد كحد أقصى */
export const SOURCE_CAP: Record<string, number> = { arxiv: 1, hf_models: 1 }

export function pickDiverse(items: Scored[], max = 8, perSource = 2): Scored[] {
  const out: Scored[] = []
  const count = new Map<string, number>()
  for (const it of [...items].sort((a, b) => b.score - a.score)) {
    if ((count.get(it.source) ?? 0) >= Math.min(perSource, SOURCE_CAP[it.source] ?? perSource)) continue
    count.set(it.source, (count.get(it.source) ?? 0) + 1)
    out.push(it)
    if (out.length >= max) break
  }
  return out
}

// ───── الصياغة العربية (النموذج = نثر فقط) ─────

export interface Prose { summary_ar?: string; why_ar?: string; idea_ar?: string }

export function summaryPrompt(knowledge: string): string {
  return `أنت محرر نشرة "موجز AI" اليومية ل${ownerName()} (${profile().interests || 'عمله ومشاريعه'}).
سياق إضافي عنه:
${knowledge.slice(0, 2000)}

ستصلك بنود أخبار بمعرّفات (id) مع العنوان والمقتطف من المصدر. لكل id اكتب بالعربي السعودي المختصر الواضح:
- summary_ar: ما هو الخبر/المشروع في جملة واحدة (اعتمد على العنوان والمقتطف فقط — لا تخترع أرقاماً ولا تفاصيل غير موجودة)
- why_ar: لماذا يهم ${ownerName()} تحديداً في جملة واحدة
- idea_ar: فكرة عملية واحدة محددة يطبقها في عمله أو مشاريعه أو مساعده الشخصي
ممنوع كتابة أي روابط أو نطاقات أو تواريخ. المصطلحات التقنية والأسماء تبقى بالإنجليزي.
أعد JSON فقط بهذا الشكل: {"items":[{"id":"1","summary_ar":"...","why_ar":"...","idea_ar":"..."}]}`
}

export function summaryInput(items: NewsItem[]): string {
  return JSON.stringify(items.map((it, i) => ({ id: String(i + 1), title: it.title, source: SOURCE_LABEL[it.source] ?? it.source, snippet: it.snippet })))
}

/** يزيل أي رابط/نطاق/تاريخ قد يكتبه النموذج — الروابط والتواريخ من المصدر فقط */
export function sanitizeProse(s: unknown, max = 260): string {
  if (typeof s !== 'string') return ''
  let t = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|ai|io|org|net|dev|sh|co|app|tech|news|xyz|gg|me|sa)(?:\/\S*)?/gi, '')
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '')
    .replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  if (t.length > max) t = `${t.slice(0, max - 1)}…`
  return t
}

/** يقرأ رد النموذج بأمان: خريطة id ← نثر منظّف. أي خطأ ← خريطة فارغة (الموجز ينزل بلا نثر لكنه لا يفشل) */
export function parseProse(raw: string, n: number): Map<string, Prose> {
  const map = new Map<string, Prose>()
  try {
    const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
    for (const x of Array.isArray(j?.items) ? j.items : []) {
      const id = String(x?.id ?? '')
      if (!/^\d+$/.test(id) || +id < 1 || +id > n) continue
      const p: Prose = { summary_ar: sanitizeProse(x.summary_ar), why_ar: sanitizeProse(x.why_ar), idea_ar: sanitizeProse(x.idea_ar) }
      if (p.summary_ar || p.why_ar || p.idea_ar) map.set(id, p)
    }
  } catch { /* نثر غير صالح ← بلا نثر */ }
  return map
}

// ───── التنسيق ─────

export interface DigestEntry extends NewsItem { prose?: Prose }

function localDate(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
  } catch { return iso.slice(0, 10) }
}

export function formatDigest(date: string, entries: DigestEntry[], tz = 'Asia/Riyadh', note?: string): string {
  if (!entries.length) return `🗞️ موجز AI — ${date}\nما لقيت أخبار جديدة مهمة (آخر ٧٢ ساعة) ما أرسلتها لك قبل. بكرة أشوف 👌${note ? `\n${note}` : ''}`
  const body = entries.map((e, i) => {
    const lines = [`${i + 1}. ${e.title}`]
    if (e.prose?.summary_ar) lines.push(`   ${e.prose.summary_ar}`)
    if (e.prose?.why_ar) lines.push(`   💡 ${e.prose.why_ar}`)
    if (e.prose?.idea_ar) lines.push(`   🛠️ ${e.prose.idea_ar}`)
    lines.push(`   🗓️ ${localDate(e.date, tz)} · ${SOURCE_LABEL[e.source] ?? e.source}`)
    lines.push(`   🔗 ${e.url}`)
    return lines.join('\n')
  })
  return `🗞️ موجز AI — ${date}\n\n${body.join('\n\n')}${note ? `\n\n${note}` : ''}`
}

/** تقسيم آمن لتيليجرام (4096): على حدود البنود، وإلا قصّ صارم */
export function splitMessage(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text]
  const parts: string[] = []
  let cur = ''
  for (const block of text.split('\n\n')) {
    const piece = cur ? `${cur}\n\n${block}` : block
    if (piece.length <= limit) { cur = piece; continue }
    if (cur) parts.push(cur)
    let b = block
    while (b.length > limit) { parts.push(b.slice(0, limit)); b = b.slice(limit) }
    cur = b
  }
  if (cur) parts.push(cur)
  return parts
}

// ───── التشغيل الكامل ─────

export interface SentStore {
  /** الروابط المطبّعة المرسلة سابقاً من بين هذه */
  sentAmong(urls: string[]): Promise<Set<string>>
  /** عناوين أُرسلت مؤخراً (لمنع نفس القصة برابط مختلف) */
  recentTitles(since: Date): Promise<string[]>
  /** حجز ذرّي: يرجع الروابط التي حُجزت الآن فعلاً (غير المحجوزة سابقاً) */
  claim(items: { url_norm: string; title: string }[], at: Date): Promise<Set<string>>
}

export interface DigestDeps {
  fetch: FetchFn
  now: Date
  tz: string
  date: string
  store: SentStore
  /** صياغة JSON (Gemini) — اختياري؛ فشلها لا يمنع الإرسال */
  complete?: (system: string, user: string) => Promise<string>
  knowledge?: string
  githubToken?: string
  tavilyKey?: string
  /** للاختبار: مصادر جاهزة بدل الجلب */
  sources?: (since: Date) => Promise<SourceResult[]>
}

export interface DigestResult {
  text: string
  entries: DigestEntry[]
  stats: { source: string; fetched: number; error?: string }[]
  windowHours: 24 | 72
  llm: 'ok' | 'failed' | 'skipped'
}

const MIN_ITEMS = 5

export async function buildDigest(d: DigestDeps): Promise<DigestResult> {
  const since72 = new Date(d.now.getTime() - 72 * 3600_000)
  const results = await (d.sources ?? ((since) => fetchAllSources({ fetch: d.fetch, since, now: d.now, githubToken: d.githubToken })))(since72)
  const stats = results.map((r) => ({ source: r.source, fetched: r.items.length, ...(r.error ? { error: r.error } : {}) }))
  let all = results.flatMap((r) => r.items)

  const sentTitles = await d.store.recentTitles(new Date(d.now.getTime() - 14 * 86_400_000))
  const sent = await d.store.sentAmong([...new Set(all.map((it) => normalizeUrl(it.url)))])
  const fresh = (items: NewsItem[]) => dedupeBatch(scoreItems(items, d.now)
    .filter((it) => !sent.has(it.url_norm) && !sentTitles.some((t) => sameStory(t, it.title))))

  const within = (h: number) => (it: NewsItem) => effectiveTime(it) >= d.now.getTime() - h * 3600_000
  let windowHours: 24 | 72 = 24
  let pool = fresh(all.filter(within(24)))

  // Tier 2 اختياري: Tavily فقط إن وُجد المفتاح وكانت Tier 1 شحيحة
  if (pool.length < MIN_ITEMS && d.tavilyKey) {
    try {
      const t = await fetchTavily({ fetch: d.fetch, since: since72, now: d.now, tavilyKey: d.tavilyKey })
      stats.push({ source: 'tavily', fetched: t.length })
      all = [...all, ...t]
      pool = fresh(all.filter(within(24)))
    } catch (err) {
      stats.push({ source: 'tavily', fetched: 0, error: String((err as any)?.message ?? err).slice(0, 160) })
    }
  }
  if (pool.length < MIN_ITEMS) { windowHours = 72; pool = fresh(all.filter(within(72))) }

  let picked = pickDiverse(pool, 8, 2)
  // حجز ذرّي قبل الإرسال: تشغيلان متزامنان (مجدول + عند الطلب) لا يرسلان نفس الرابط
  const claimed = await d.store.claim(picked.map((p) => ({ url_norm: p.url_norm, title: p.title })), d.now)
  picked = picked.filter((p) => claimed.has(p.url_norm))

  let llm: DigestResult['llm'] = 'skipped'
  let entries: DigestEntry[] = picked.map(({ score: _s, url_norm: _u, ...it }) => it)
  if (entries.length && d.complete) {
    try {
      const prose = parseProse(await d.complete(summaryPrompt(d.knowledge ?? ''), summaryInput(entries)), entries.length)
      llm = prose.size ? 'ok' : 'failed'
      entries = entries.map((e, i) => ({ ...e, prose: prose.get(String(i + 1)) }))
    } catch {
      llm = 'failed'
    }
  }
  const note = llm === 'failed' ? '(تعذّرت الصياغة العربية هالمرة — هذي العناوين والروابط من المصادر مباشرة)' : undefined
  return { text: formatDigest(d.date, entries, d.tz, note), entries, stats, windowHours, llm }
}
