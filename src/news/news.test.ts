import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFeed, parseHn, parseGithub, parseHfPapers, parseHfModels, parseTavily, fetchAllSources, validDate, validUrl,
  type NewsItem, type SourceResult,
} from './sources.js'
import {
  normalizeUrl, sameStory, scoreItems, dedupeBatch, pickDiverse, buildDigest, splitMessage, sanitizeProse, parseProse, formatDigest,
  type SentStore,
} from './digest.js'
import { createDb, type Db } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { Store } from '../store.js'

const NOW = new Date('2026-10-01T09:00:00Z')
const hAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

// ───── fixtures ─────
export const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title><link>https://example.com/</link>
<item><title><![CDATA[Claude Code ships MCP &amp; skills]]></title><link>https://blog.example.com/claude-mcp?utm_source=rss&amp;utm_medium=feed</link>
<pubDate>Wed, 30 Sep 2026 20:00:00 GMT</pubDate><description><![CDATA[<p>Anthropic&#39;s <b>new</b> release</p>]]></description></item>
<item><title>No date item</title><link>https://blog.example.com/nodate</link></item>
<item><title>Bad date item</title><link>https://blog.example.com/baddate</link><pubDate>not a date</pubDate></item>
<item><title>Bad url item</title><link>javascript:alert(1)</link><pubDate>Wed, 30 Sep 2026 20:00:00 GMT</pubDate></item>
<item><title>Future item</title><link>https://blog.example.com/future</link><pubDate>Wed, 30 Dec 2026 20:00:00 GMT</pubDate></item>
<item><title>Guid only</title><guid isPermaLink="true">https://blog.example.com/guid</guid><pubDate>Thu, 01 Oct 2026 06:00:00 GMT</pubDate></item>
</channel></rss>`

export const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Simon</title>
<link href="https://simonwillison.net/" rel="alternate"/>
<entry><title>Gemini agents &amp;amp; practice</title><link href="https://simonwillison.net/2026/Sep/30/gemini/" rel="alternate"/>
<link href="https://simonwillison.net/self" rel="self"/><published>2026-09-30T18:00:00+00:00</published><updated>2026-09-30T19:00:00+00:00</updated>
<summary type="html">&lt;p&gt;Notes on agents&lt;/p&gt;</summary></entry>
<entry><title>Old updated only</title><link href="https://simonwillison.net/2026/Sep/29/x/"/><updated>2026-09-29T10:00:00Z</updated><content type="html">body</content></entry>
<entry><title>No link</title><published>2026-09-30T18:00:00Z</published></entry>
</feed>`

export const HN = { hits: [
  { objectID: '1', title: 'Show HN: An MCP server for WhatsApp bots', url: 'https://github.com/x/mcp-wa', created_at: hAgo(3), points: 120, num_comments: 40 },
  { objectID: '2', title: 'Ask HN: agents in prod?', url: null, created_at: hAgo(5), points: 30, num_comments: 10 },
  { objectID: '3', title: 'Broken date', url: 'https://a.com/x', created_at: 'garbage', points: 50 },
  { objectID: '4', title: '', url: 'https://a.com/y', created_at: hAgo(2), points: 50 },
] }
export const GH = { items: [
  { full_name: 'acme/agent-kit', html_url: 'https://github.com/acme/agent-kit', created_at: hAgo(10), stargazers_count: 900, description: 'Agents toolkit', language: 'TypeScript' },
  { full_name: 'evil/x', html_url: 'https://evil.com/x', created_at: hAgo(10), stargazers_count: 999 },
] }
export const HF_PAPERS = [
  { title: 'Reasoning LLMs at scale', publishedAt: hAgo(6), paper: { id: '2609.12345', summary: 'We study reasoning.', upvotes: 55 } },
  { paper: { id: '../../etc', title: 'Bad id', publishedAt: hAgo(6), upvotes: 1 } },
]
export const HF_MODELS = [
  { id: 'Qwen/Qwen4-8B', likes: 800, createdAt: hAgo(20), pipeline_tag: 'text-generation' },
  { id: 'no-slash', likes: 5, createdAt: hAgo(20) },
]

const ok = (body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })

// ───── parsers ─────
test('RSS: CDATA + entities + tracking link kept as-is (normalised later), invalid date/url/future dropped, guid permalink used', () => {
  const items = parseFeed(RSS, 'simon', NOW)
  assert.deepEqual(items.map((i) => i.title), ['Claude Code ships MCP & skills', 'Guid only'])
  assert.equal(items[0].url, 'https://blog.example.com/claude-mcp?utm_source=rss&utm_medium=feed')
  assert.equal(items[0].date, '2026-09-30T20:00:00.000Z')
  assert.equal(items[0].snippet, "Anthropic's new release")
  assert.equal(items[1].url, 'https://blog.example.com/guid')
})

test('Atom: rel=alternate link, published preferred over updated, entries without link dropped', () => {
  const items = parseFeed(ATOM, 'simon', NOW)
  assert.deepEqual(items.map((i) => [i.title, i.url, i.date]), [
    ['Gemini agents & practice', 'https://simonwillison.net/2026/Sep/30/gemini/', '2026-09-30T18:00:00.000Z'],
    ['Old updated only', 'https://simonwillison.net/2026/Sep/29/x/', '2026-09-29T10:00:00.000Z'],
  ])
  assert.equal(items[0].snippet, 'Notes on agents')
})

test('HN: points as signal, missing url → HN item link, bad date / empty title dropped', () => {
  const items = parseHn(HN, NOW)
  assert.equal(items.length, 2)
  assert.equal(items[0].signal, 120)
  assert.equal(items[1].url, 'https://news.ycombinator.com/item?id=2')
  assert.equal(items[1].source, 'hn')
})

test('GitHub: stars as signal, non-github url dropped', () => {
  const items = parseGithub(GH, NOW)
  assert.deepEqual(items.map((i) => [i.title, i.signal]), [['acme/agent-kit', 900]])
  assert.match(items[0].snippet, /Agents toolkit \(TypeScript\)/)
})

test('HF papers + models: URLs built only from safe ids', () => {
  const p = parseHfPapers(HF_PAPERS, NOW)
  assert.deepEqual(p.map((i) => [i.url, i.signal]), [['https://huggingface.co/papers/2609.12345', 55]])
  const m = parseHfModels(HF_MODELS, NOW)
  assert.deepEqual(m.map((i) => [i.title, i.url, i.signal]), [['Qwen/Qwen4-8B', 'https://huggingface.co/Qwen/Qwen4-8B', 800]])
})

test('Tavily: items without published_date dropped', () => {
  const t = parseTavily({ results: [{ title: 'A', url: 'https://a.com/a', published_date: 'Wed, 30 Sep 2026 10:00:00 GMT', content: 'x' }, { title: 'B', url: 'https://a.com/b' }] }, NOW)
  assert.deepEqual(t.map((i) => i.title), ['A'])
})

test('validators', () => {
  assert.equal(validUrl('ftp://a.com/x'), null)
  assert.equal(validUrl('https://localhost/x'), null)
  assert.equal(validUrl('not a url'), null)
  assert.equal(validDate('', NOW), null)
  assert.equal(validDate('2026-12-30T00:00:00Z', NOW), null)
  assert.equal(validDate(1790000000, NOW), new Date(1790000000 * 1000).toISOString())
})

// ───── fetch + isolation ─────
function mockFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    for (const [k, v] of Object.entries(overrides)) if (url.includes(k)) return v()
    if (url.includes('hn.algolia.com')) return ok(HN)
    if (url.includes('api.github.com')) return ok(GH)
    if (url.includes('daily_papers')) return ok(HF_PAPERS)
    if (url.includes('huggingface.co/api/models')) return ok(HF_MODELS)
    if (url.includes('simonwillison')) return ok(ATOM)
    if (url.includes('techmeme')) return ok(RSS.replace('Claude Code ships MCP &amp; skills', 'Sports team wins').replace('Guid only', 'Guid only about OpenAI').replace('Anthropic&#39;s', 'The'))
    return ok('<rss><channel></channel></rss>')
  }
  return { fn, calls }
}

test('fetchAllSources: each failure isolated, GitHub token sent, timeout signal on every request, techmeme keyword-filtered', async () => {
  const m = mockFetch({ 'openai.com': () => { throw new Error('ECONNRESET') }, 'latent.space': () => new Response('x', { status: 503 }) })
  const res = await fetchAllSources({ fetch: m.fn, since: new Date(NOW.getTime() - 72 * 3600_000), now: NOW, githubToken: 'ghp_t' })
  const by = Object.fromEntries(res.map((r) => [r.source, r]))
  assert.match(by.openai.error!, /ECONNRESET/)
  assert.match(by.latent.error!, /HTTP 503/)
  assert.equal(by.hn.items.length, 2, 'HN deduped across the 7 query terms')
  assert.equal(by.github.items.length, 1)
  assert.equal(by.simon.items.length, 2)
  assert.deepEqual(by.techmeme.items.map((i) => i.title), ['Guid only about OpenAI'])
  const gh = m.calls.filter((c) => c.url.includes('api.github.com'))
  assert.equal(gh.length, 3)
  assert.equal((gh[0].init!.headers as any).Authorization, 'Bearer ghp_t')
  assert.match(decodeURIComponent(gh[0].url), /created:>2026-09-28 stars:>50 topic:ai/)
  assert.ok(m.calls.every((c) => c.init?.signal instanceof AbortSignal))
  assert.equal(m.calls.filter((c) => c.url.includes('hn.algolia.com')).length, 7)
})

// ───── dedupe / ranking ─────
test('normalizeUrl strips tracking, www, hash, trailing slash; keeps meaningful query', () => {
  assert.equal(normalizeUrl('http://WWW.Example.com/a/?utm_source=x&id=3&ref=hn#top'), 'https://example.com/a?id=3')
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com')
})

test('sameStory: token overlap across sources', () => {
  assert.ok(sameStory('OpenAI launches GPT-6.1 Sol', 'GPT-6.1 Sol: OpenAI launches new model'))
  assert.ok(!sameStory('OpenAI launches GPT-6.1 Sol', 'Anthropic launches Claude Sonnet 5.5'))
})

const item = (over: Partial<NewsItem>): NewsItem => ({ title: 't', url: 'https://x.com/1', date: hAgo(2), source: 'hn', snippet: '', signal: 0, ...over })

test('ranking: profile keywords + source weight win; max 2 per source; arXiv capped at 1', () => {
  const items: NewsItem[] = [
    ...['Claude Code gets hooks', 'MCP registry launches', 'Agents SDK for Node', 'Claude skills explained'].map((t, j) => [t, j + 1] as const).map(([t, i]) => item({ title: t, url: `https://news.ycombinator.com/${i}`, source: 'hn', signal: 100 * i })),
    ...[1, 2, 3].map((i) => item({ title: ['LLM reasoning via search', 'Agents that plan', 'Multimodal agents benchmark'][i - 1], url: `https://arxiv.org/abs/${i}`, source: 'arxiv' })),
    item({ title: 'Gemini in Next.js apps', url: 'https://simonwillison.net/g', source: 'simon' }),
    item({ title: 'Quarterly earnings of a shoe company', url: 'https://x.com/shoe', source: 'techmeme' }),
  ]
  const picked = pickDiverse(dedupeBatch(scoreItems(items, NOW)), 8, 2)
  const count = (s: string) => picked.filter((p) => p.source === s).length
  assert.equal(count('hn'), 2)
  assert.equal(count('arxiv'), 1)
  assert.equal(picked[picked.length - 1].source, 'techmeme', 'irrelevant item ranks last')
  assert.ok(picked.slice(0, 3).some((p) => p.source === 'simon'))
  assert.equal(picked.find((p) => p.source === 'hn')!.signal, 400, 'higher signal first within source')
})

test('dedupeBatch: same normalized URL or same story → keep highest score', () => {
  const s = scoreItems([
    item({ title: 'OpenAI launches GPT-6.1 Sol today', url: 'https://openai.com/x?utm_source=a', source: 'openai' }),
    item({ title: 'GPT-6.1 Sol: OpenAI launches today', url: 'https://techmeme.com/y', source: 'techmeme' }),
    item({ title: 'Totally different', url: 'https://www.openai.com/x', source: 'hn' }),
  ], NOW)
  const d = dedupeBatch(s)
  assert.deepEqual(d.map((x) => x.source), ['openai'])
})

// ───── LLM boundary ─────
test('sanitizeProse/parseProse: LLM cannot inject URLs, domains or dates; unknown ids ignored', () => {
  const raw = JSON.stringify({ items: [
    { id: '1', summary_ar: 'أداة جديدة https://evil.com/p و www.evil.org وراجع [هنا](https://x.y) و evil.ai/path بتاريخ 2026-09-30', why_ar: 'مهمة', idea_ar: 'جرّبها', url: 'https://evil.com', date: '2020-01-01' },
    { id: '99', summary_ar: 'خارج النطاق' },
  ] })
  const m = parseProse(raw, 2)
  assert.equal(m.size, 1)
  const p = m.get('1')!
  assert.doesNotMatch(JSON.stringify(p), /evil|https?:|www\.|2026-09-30|x\.y/)
  assert.match(p.summary_ar!, /أداة جديدة/)
  assert.equal(parseProse('not json at all', 2).size, 0)
  assert.equal(sanitizeProse(42), '')
})

// ───── full pipeline with real Store (PGlite) ─────
let db: Db, store: Store, sentStore: SentStore
before(async () => {
  db = await createDb({ pgliteDir: 'memory://' } as any)
  await migrate(db)
  store = new Store(db)
  sentStore = { sentAmong: (u) => store.newsSentAmong(u), recentTitles: (s) => store.newsRecentTitles(s), claim: (i, at) => store.claimNewsUrls(i, at) }
})
after(async () => { await db.close() })

const SRC: SourceResult[] = [
  { source: 'hn', items: [
    item({ title: 'Claude Code adds MCP skills marketplace', url: 'https://anthropic.com/news/skills?utm_source=hn', source: 'hn', signal: 300, date: hAgo(3) }),
    item({ title: 'Show HN: WhatsApp bot framework in TypeScript', url: 'https://github.com/a/wa', source: 'hn', signal: 80, date: hAgo(5) }),
    item({ title: 'Old but relevant agents post here', url: 'https://old.com/agents', source: 'hn', signal: 50, date: hAgo(60) }),
  ] },
  { source: 'simon', items: [item({ title: 'Gemini 4 Argon notes for developers', url: 'https://simonwillison.net/gemini4', source: 'simon', date: hAgo(4) })] },
  { source: 'techmeme', items: [item({ title: 'Claude Code adds MCP skills marketplace (The Verge)', url: 'https://techmeme.com/a1', source: 'techmeme', date: hAgo(2) })] },
  { source: 'openai', items: [item({ title: 'OpenAI DevDay recap Node SDK', url: 'https://openai.com/index/devday', source: 'openai', date: hAgo(8) })] },
  { source: 'latent', items: [item({ title: 'Coding agents podcast episode', url: 'https://latent.space/p/ep', source: 'latent', date: hAgo(10) })] },
  { source: 'github', items: [], error: 'HTTP 403' },
]

test('buildDigest: LLM prose attached by id; links/dates only from metadata; cross-source dupes merged', async () => {
  let userSeen = ''
  const r = await buildDigest({
    fetch: async () => { throw new Error('should not fetch') }, now: NOW, tz: 'Asia/Riyadh', date: '2026-10-01', store: sentStore,
    sources: async () => SRC,
    complete: async (_sys, user) => {
      userSeen = user
      const ids = JSON.parse(user).map((x: any) => x.id)
      return JSON.stringify({ items: ids.map((id: string) => ({ id, summary_ar: `ملخص ${id} https://inject.me/x`, why_ar: `يهمك ${id}`, idea_ar: `طبقها ${id}` })) })
    },
  })
  assert.equal(r.llm, 'ok')
  assert.equal(r.windowHours, 24)
  assert.doesNotMatch(userSeen, /https?:\/\//, 'LLM input has no URLs')
  assert.equal(r.entries.length, 5, 'techmeme dupe merged; 60h-old item outside 24h window')
  assert.ok(!r.entries.some((e) => e.url.includes('techmeme')))
  assert.match(r.text, /^🗞️ موجز AI — 2026-10-01\n\n1\. Claude Code adds MCP skills marketplace\n   ملخص 1\n   💡 يهمك 1\n   🛠️ طبقها 1\n   🗓️ 2026-10-01 · Hacker News\n   🔗 https:\/\/anthropic\.com\/news\/skills\?utm_source=hn/)
  assert.doesNotMatch(r.text, /inject\.me/)
  const links = [...r.text.matchAll(/🔗 (\S+)/g)].map((m) => m[1])
  assert.deepEqual(new Set(links), new Set(r.entries.map((e) => e.url)))
  assert.deepEqual(r.stats.find((s) => s.source === 'github'), { source: 'github', fetched: 0, error: 'HTTP 403' })
})

test('buildDigest: dedupe across runs (same URL with different tracking, or same story elsewhere) → nothing new', async () => {
  const again: SourceResult[] = [
    { source: 'hn', items: [item({ title: 'Claude Code adds MCP skills marketplace', url: 'https://www.anthropic.com/news/skills/?utm_campaign=z', source: 'hn', date: hAgo(1) })] },
    { source: 'smol', items: [item({ title: 'Gemini 4 Argon: notes for developers', url: 'https://news.smol.ai/x', source: 'smol', date: hAgo(1) })] },
  ]
  const r = await buildDigest({ fetch: async () => ok(''), now: NOW, tz: 'Asia/Riyadh', date: '2026-10-02', store: sentStore, sources: async () => again })
  assert.equal(r.entries.length, 0)
  assert.match(r.text, /ما لقيت أخبار جديدة/)
})

test('buildDigest: LLM failure → degraded but non-empty (titles + links + dates); widens to 72h when < 5', async () => {
  const fresh: SourceResult[] = [{ source: 'hn', items: [
    item({ title: 'Brand new MCP gateway release', url: 'https://n.com/1', source: 'hn', date: hAgo(2) }),
    item({ title: 'Agents benchmark from last weekend', url: 'https://n.com/2', source: 'hn', date: hAgo(50) }),
  ] }]
  const r = await buildDigest({ fetch: async () => ok(''), now: NOW, tz: 'Asia/Riyadh', date: '2026-10-01', store: sentStore, sources: async () => fresh,
    complete: async () => { throw new Error('Gemini 503') } })
  assert.equal(r.llm, 'failed')
  assert.equal(r.windowHours, 72)
  assert.equal(r.entries.length, 2)
  assert.match(r.text, /1\. Brand new MCP gateway release\n   🗓️ \d{4}-\d{2}-\d{2} · Hacker News\n   🔗 https:\/\/n\.com\/1/)
  assert.match(r.text, /تعذّرت الصياغة العربية/)
})

test('buildDigest: concurrent runs never send the same URL twice (atomic claim)', async () => {
  const src: SourceResult[] = [{ source: 'simon', items: [item({ title: 'Concurrent claim test agents', url: 'https://c.com/1', source: 'simon', date: hAgo(1) })] }]
  const run = () => buildDigest({ fetch: async () => ok(''), now: NOW, tz: 'Asia/Riyadh', date: 'd', store: sentStore, sources: async () => src })
  const [a, b] = await Promise.all([run(), run()])
  assert.equal(a.entries.length + b.entries.length, 1)
})

test('buildDigest: Tavily only when key set and Tier 1 < 5', async () => {
  const urls: string[] = []
  const f = async (u: string) => { urls.push(u); return ok({ results: [{ title: 'Tavily AI story about agents', url: 'https://t.com/1', published_date: hAgo(3), content: 'c' }] }) }
  const r = await buildDigest({ fetch: f, now: NOW, tz: 'Asia/Riyadh', date: 'd', store: sentStore, sources: async () => [], tavilyKey: 'tvly-x' })
  assert.deepEqual(urls, ['https://api.tavily.com/search'])
  assert.deepEqual(r.entries.map((e) => e.source), ['tavily'])
  urls.length = 0
  await buildDigest({ fetch: f, now: NOW, tz: 'Asia/Riyadh', date: 'd', store: sentStore, sources: async () => [] })
  assert.equal(urls.length, 0, 'no key → no Tavily call')
})

test('splitMessage keeps every part under the Telegram limit and splits on item boundaries', () => {
  const entries = Array.from({ length: 8 }, (_, i) => ({ ...item({ title: `Item ${i} ${'x'.repeat(200)}`, url: `https://x.com/${i}` }), prose: { summary_ar: 'م'.repeat(250), why_ar: 'ل'.repeat(250), idea_ar: 'ف'.repeat(250) } }))
  const text = formatDigest('2026-10-01', entries)
  assert.ok(text.length > 4096)
  const parts = splitMessage(text)
  assert.ok(parts.length >= 2)
  assert.ok(parts.every((p) => p.length <= 4096))
  assert.equal(parts.join('\n\n'), text)
  assert.ok(parts[1].startsWith(`${parts[0].split('\n\n').length}. `) || /^\d+\. /.test(parts[1]))
})
