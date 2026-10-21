/** فحص حي لمصادر موجز AI (بلا نموذج): npx tsx scripts/news-smoke.ts */
import { fetchAllSources, effectiveTime } from '../src/news/sources.js'
import { buildDigest } from '../src/news/digest.js'

const now = new Date()
const since = new Date(now.getTime() - 72 * 3600_000)
const res = await fetchAllSources({ fetch: (u, i) => fetch(u, i), since, now, githubToken: process.env.GITHUB_TOKEN })
const h24 = now.getTime() - 24 * 3600_000
for (const r of res) console.log(`${r.source.padEnd(10)} 72h=${String(r.items.length).padStart(3)} 24h=${String(r.items.filter((i) => effectiveTime(i) >= h24).length).padStart(3)}${r.error ? `  ERROR: ${r.error}` : ''}`)
const mem = new Set<string>()
const d = await buildDigest({
  fetch: (u, i) => fetch(u, i), now, tz: 'Asia/Riyadh', date: now.toISOString().slice(0, 10),
  sources: async () => res,
  store: { async sentAmong() { return new Set() }, async recentTitles() { return [] }, async claim(items) { items.forEach((i) => mem.add(i.url_norm)); return new Set(items.map((i) => i.url_norm)) } },
})
console.log(`\nwindow=${d.windowHours}h llm=${d.llm} picked=${d.entries.length}\n`)
console.log(d.text)
