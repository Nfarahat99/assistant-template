/**
 * مصادر موجز AI (Tier 1 — مجانية بلا مفاتيح). القاعدة: العنوان والرابط والتاريخ من بيانات المصدر فقط،
 * والنموذج يكتب النثر العربي فقط. كل مصدر معزول: فشله لا يوقف البقية.
 */
import { profile } from '../profile.js'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface NewsItem {
  title: string
  url: string
  /** ISO من المصدر نفسه */
  date: string
  /** مفتاح المصدر (hn, github, hf_papers, …) */
  source: string
  snippet: string
  /** نقاط HN / نجوم GitHub / تصويتات HF — 0 إن لم يوجد */
  signal: number
}

export interface SourceResult { source: string; items: NewsItem[]; error?: string }

export interface FetchOpts {
  fetch: FetchFn
  /** أقدم تاريخ مقبول (النافذة الأوسع — ٧٢ ساعة) */
  since: Date
  now: Date
  githubToken?: string
  tavilyKey?: string
  timeoutMs?: number
}

export const SOURCE_LABEL: Record<string, string> = {
  hn: 'Hacker News', github: 'GitHub', hf_papers: 'HF Papers', hf_models: 'HF Models', arxiv: 'arXiv',
  openai: 'OpenAI', simon: 'Simon Willison', latent: 'Latent Space', smol: 'AINews (smol.ai)',
  techmeme: 'Techmeme', tldr: 'TLDR AI', anthropic: 'Anthropic', tavily: 'Tavily',
}

export const RSS_FEEDS: { source: string; url: string; filter?: boolean }[] = [
  { source: 'openai', url: 'https://openai.com/news/rss.xml' },
  { source: 'simon', url: 'https://simonwillison.net/atom/everything/' },
  { source: 'latent', url: 'https://www.latent.space/feed' },
  { source: 'smol', url: 'https://news.smol.ai/rss.xml' },
  { source: 'techmeme', url: 'https://www.techmeme.com/feed.xml', filter: true },
  { source: 'tldr', url: 'https://tldr.tech/api/rss/ai' },
  { source: 'anthropic', url: 'https://raw.githubusercontent.com/taobojlen/anthropic-rss-feed/main/anthropic_news_rss.xml' },
]

export const HN_TERMS = ['AI', 'LLM', 'Claude', 'agent', 'Gemini', 'OpenAI', 'MCP']
export const GITHUB_TOPICS = ['ai', 'llm', 'agents']

/** مصادر عامة (ليست AI بالكامل) — تحتاج كلمة AI صريحة لتُقبل */
const AI_RE = /\b(ai|a\.i\.|llms?|gpt[-\w.]*|claude|anthropic|openai|gemini|deepmind|agents?|agentic|mcp|copilot|cursor|mistral|llama|deepseek|qwen|grok|xai|hugging ?face|transformers?|diffusion|rag|embeddings?|fine-?tun\w*|inference|neural|machine learning|chatbots?|reasoning model|frontier model|open[- ]weights?|nvidia)\b/i
export const isAiText = (s: string) => AI_RE.test(s)

// ───── أدوات صغيرة ─────

/** يقبل http(s) فقط، ويرجع الرابط مطبّعاً بسيطاً أو null */
export function validUrl(u: unknown): string | null {
  if (typeof u !== 'string') return null
  try {
    const x = new URL(u.trim())
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return null
    if (!x.hostname.includes('.')) return null
    return x.toString()
  } catch { return null }
}

/** تاريخ صالح من المصدر ← ISO؛ يرفض الفارغ وغير القابل للقراءة والمستقبلي (> ساعة) */
export function validDate(d: unknown, now: Date): string | null {
  if (d == null || d === '') return null
  const t = typeof d === 'number' ? new Date(d < 1e12 ? d * 1000 : d) : new Date(String(d).trim())
  if (Number.isNaN(t.getTime())) return null
  if (t.getTime() > now.getTime() + 3600_000) return null
  if (t.getFullYear() < 2000) return null
  return t.toISOString()
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}
const stripCdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
/** نص نظيف من HTML/XML: يزيل CDATA والوسوم ويفك الكيانات (مرتين: المحتوى المهرّب داخل XML) */
export function cleanText(s: string, max = 300): string {
  let t = stripCdata(s)
  t = decodeEntities(t)
  t = t.replace(/<[^>]*>/g, ' ')
  t = decodeEntities(t)
  t = t.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function tag(block: string, names: string[]): string | null {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i')
    const m = re.exec(block)
    if (m) return m[1]
  }
  return null
}
function atomLink(block: string): string | null {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)].map((m) => m[1])
  const attr = (a: string, k: string) => new RegExp(`\\b${k}\\s*=\\s*["']([^"']*)["']`, 'i').exec(a)?.[1] ?? null
  const alt = links.find((a) => { const r = attr(a, 'rel'); return attr(a, 'href') && (!r || r === 'alternate') })
  return alt ? decodeEntities(attr(alt, 'href')!) : null
}

/** محلّل RSS 2.0 / Atom صغير (بلا اعتماديات) — يكفي للخلاصات المعروفة */
export function parseFeed(xml: string, source: string, now: Date): NewsItem[] {
  const out: NewsItem[] = []
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => m[2])
  for (const b of blocks) {
    const title = cleanText(tag(b, ['title']) ?? '', 200)
    const rssLink = tag(b, ['link'])
    const link = validUrl(rssLink ? cleanText(rssLink, 2000) : atomLink(b)) ?? validUrl(atomLink(b))
      ?? (/isPermaLink\s*=\s*["']?true/i.test(b) || !/isPermaLink/i.test(b) ? validUrl(cleanText(tag(b, ['guid']) ?? '', 2000)) : null)
    const date = validDate(cleanText(tag(b, ['pubDate', 'published', 'dc:date', 'updated']) ?? '', 100), now)
    const snippet = cleanText(tag(b, ['description', 'summary', 'content:encoded', 'content']) ?? '', 280)
    if (!title || !link || !date) continue
    out.push({ title, url: link, date, source, snippet, signal: 0 })
  }
  return out
}

export function parseHn(json: any, now: Date): NewsItem[] {
  const out: NewsItem[] = []
  for (const h of Array.isArray(json?.hits) ? json.hits : []) {
    const title = cleanText(String(h?.title ?? ''), 200)
    const url = validUrl(h?.url) ?? (h?.objectID ? validUrl(`https://news.ycombinator.com/item?id=${h.objectID}`) : null)
    const date = validDate(h?.created_at ?? h?.created_at_i, now)
    if (!title || !url || !date) continue
    const points = Number(h?.points) || 0
    out.push({ title, url, date, source: 'hn', snippet: `${points} نقطة · ${Number(h?.num_comments) || 0} تعليق على HN`, signal: points })
  }
  return out
}

export function parseGithub(json: any, now: Date): NewsItem[] {
  const out: NewsItem[] = []
  for (const r of Array.isArray(json?.items) ? json.items : []) {
    const title = cleanText(String(r?.full_name ?? ''), 200)
    const url = validUrl(r?.html_url)
    const date = validDate(r?.created_at, now)
    if (!title || !url || !date || !url.startsWith('https://github.com/')) continue
    const stars = Number(r?.stargazers_count) || 0
    out.push({ title, url, date, source: 'github', snippet: cleanText(`${r?.description ?? ''}${r?.language ? ` (${r.language})` : ''}`, 280), signal: stars })
  }
  return out
}

export function parseHfPapers(json: any, now: Date): NewsItem[] {
  const out: NewsItem[] = []
  for (const e of Array.isArray(json) ? json : []) {
    const p = e?.paper ?? {}
    const id = String(p?.id ?? '')
    const title = cleanText(String(e?.title ?? p?.title ?? ''), 200)
    const url = /^\w[\w.\-]*$/.test(id) && !id.includes('..') ? validUrl(`https://huggingface.co/papers/${id}`) : null
    const date = validDate(e?.publishedAt ?? p?.publishedAt, now)
    if (!title || !url || !date) continue
    out.push({ title, url, date, source: 'hf_papers', snippet: cleanText(String(p?.summary ?? e?.summary ?? ''), 280), signal: Number(p?.upvotes) || 0 })
  }
  return out
}

export function parseHfModels(json: any, now: Date): NewsItem[] {
  const out: NewsItem[] = []
  for (const m of Array.isArray(json) ? json : []) {
    const id = String(m?.id ?? m?.modelId ?? '')
    const url = /^[\w.\-]+\/[\w.\-]+$/.test(id) ? validUrl(`https://huggingface.co/${id}`) : null
    const date = validDate(m?.createdAt, now)
    if (!id || !url || !date) continue
    const tags = [m?.pipeline_tag, m?.library_name].filter(Boolean).join(', ')
    out.push({ title: id, url, date, source: 'hf_models', snippet: cleanText(`Trending model on Hugging Face${tags ? ` — ${tags}` : ''}`, 200), signal: Number(m?.likes) || 0 })
  }
  return out
}

export function parseTavily(json: any, now: Date): NewsItem[] {
  const out: NewsItem[] = []
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const title = cleanText(String(r?.title ?? ''), 200)
    const url = validUrl(r?.url)
    const date = validDate(r?.published_date, now)
    if (!title || !url || !date) continue
    out.push({ title, url, date, source: 'tavily', snippet: cleanText(String(r?.content ?? ''), 280), signal: 0 })
  }
  return out
}

// ───── الجلب ─────

/** يُحسب عند الطلب — الملف الشخصي يُحمَّل بعد استيراد الموديولات */
const ua = () => `assistant-news/1.0 (+https://github.com/${profile().github.self_repo})`

async function get(o: FetchOpts, url: string, kind: 'json' | 'text', headers: Record<string, string> = {}): Promise<any> {
  const res = await o.fetch(url, { headers: { 'User-Agent': ua(), Accept: kind === 'json' ? 'application/json' : 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', ...headers }, signal: AbortSignal.timeout(o.timeoutMs ?? 25_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return kind === 'json' ? res.json() : res.text()
}

const ymd = (d: Date) => d.toISOString().slice(0, 10)
/**
 * وقت البند الفعّال للنافذة: مصادر تنشر تاريخ اليوم فقط (منتصف الليل UTC بالضبط — TLDR، مرآة Anthropic)
 * تُعامل كأنها نُشرت في أي لحظة من ذلك اليوم، فلا تسقط من نافذة ٢٤ ساعة ظلماً.
 */
export const effectiveTime = (it: NewsItem) => {
  const t = new Date(it.date).getTime()
  return it.date.endsWith('T00:00:00.000Z') ? t + 86_400_000 - 1 : t
}
const inWindow = (it: NewsItem, since: Date) => effectiveTime(it) >= since.getTime()

/** عدة طلبات لنفس المصدر: ينجح إن نجح واحد على الأقل */
async function settleAll<T>(ps: Promise<T[]>[]): Promise<T[]> {
  const rs = await Promise.allSettled(ps)
  const ok = rs.filter((r): r is PromiseFulfilledResult<T[]> => r.status === 'fulfilled')
  if (!ok.length) throw (rs[0] as PromiseRejectedResult).reason
  return ok.flatMap((r) => r.value)
}
/** نفس البند يظهر لعدة كلمات بحث/مواضيع */
function uniqByUrl(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>()
  return items.filter((it) => !seen.has(it.url) && !!seen.add(it.url))
}

export async function fetchHn(o: FetchOpts): Promise<NewsItem[]> {
  const since = Math.floor(o.since.getTime() / 1000)
  const items = await settleAll(HN_TERMS.map(async (q) => parseHn(await get(o,
    `https://hn.algolia.com/api/v1/search_by_date?tags=story&query=${encodeURIComponent(q)}&numericFilters=${encodeURIComponent(`created_at_i>${since},points>15`)}&hitsPerPage=30`, 'json'), o.now)))
  return uniqByUrl(items)
}

export async function fetchGithub(o: FetchOpts): Promise<NewsItem[]> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  if (o.githubToken) headers.Authorization = `Bearer ${o.githubToken}`
  return uniqByUrl(await settleAll(GITHUB_TOPICS.map(async (topic) => parseGithub(await get(o,
    `https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>${ymd(o.since)} stars:>50 topic:${topic}`)}&sort=stars&order=desc&per_page=20`, 'json', headers), o.now))))
}

export const fetchHfPapers = async (o: FetchOpts) => parseHfPapers(await get(o, 'https://huggingface.co/api/daily_papers', 'json'), o.now)
export const fetchHfModels = async (o: FetchOpts) => parseHfModels(await get(o, 'https://huggingface.co/api/models?sort=likes7d&direction=-1&limit=20', 'json'), o.now)
export const fetchArxiv = async (o: FetchOpts) => parseFeed(await get(o,
  'https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=30', 'text'), 'arxiv', o.now)

export async function fetchFeed(o: FetchOpts, f: { source: string; url: string; filter?: boolean }): Promise<NewsItem[]> {
  const items = parseFeed(await get(o, f.url, 'text'), f.source, o.now)
  return f.filter ? items.filter((it) => isAiText(`${it.title} ${it.snippet}`)) : items
}

export async function fetchTavily(o: FetchOpts): Promise<NewsItem[]> {
  const res = await o.fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${o.tavilyKey}` },
    body: JSON.stringify({ query: 'AI news LLM agents Claude OpenAI Gemini', topic: 'news', days: 1, max_results: 10 }),
    signal: AbortSignal.timeout(o.timeoutMs ?? 25_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseTavily(await res.json(), o.now)
}

/** كل مصادر Tier 1 بالتوازي — فشل أي مصدر معزول ويُسجَّل في error */
export async function fetchAllSources(o: FetchOpts): Promise<SourceResult[]> {
  const jobs: [string, () => Promise<NewsItem[]>][] = [
    ['hn', () => fetchHn(o)],
    ['github', () => fetchGithub(o)],
    ['hf_papers', () => fetchHfPapers(o)],
    ['hf_models', () => fetchHfModels(o)],
    ['arxiv', () => fetchArxiv(o)],
    ...RSS_FEEDS.map((f): [string, () => Promise<NewsItem[]>] => [f.source, () => fetchFeed(o, f)]),
  ]
  return Promise.all(jobs.map(async ([source, run]) => {
    try {
      return { source, items: (await run()).filter((it) => inWindow(it, o.since)) }
    } catch (err) {
      return { source, items: [], error: String((err as any)?.message ?? err).slice(0, 160) }
    }
  }))
}
