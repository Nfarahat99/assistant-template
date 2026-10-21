/**
 * npm run eval [-- --json eval-report.json] [--md eval-report.md] [--from-db] [--compare] [--only <name>]
 *
 * يعيد حالات التقييم (البذور + حالات القاعدة مع --from-db) على خطوة الفهم الحقيقية.
 * النموذج من البيئة: GEMINI_API_KEY / NVIDIA_API_KEY (نفس سلسلة الإنتاج). بدون مفاتيح: تُقيَّم الحالات الحتمية
 * فقط ويُتخطى الباقي برسالة واضحة (خروج 0). EVAL_MIN_SCORE=<0-100> يجعل الدرجة الأقل فشلاً (خروج 1).
 */
import { writeFileSync } from 'node:fs'
import { SEED_CASES } from './seed-cases.js'
import { runEval, formatTable, type EvalReport } from './harness.js'
import { fromEnv, pair } from './llm.js'
import { formatComparison } from '../selfreview/review.js'
import type { EvalCase } from '../selfreview/cases.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }

async function loadCases(): Promise<EvalCase[]> {
  let cases: EvalCase[] = [...SEED_CASES]
  if (flag('from-db')) {
    const { loadConfig } = await import('../config.js')
    const { createDb } = await import('../db/index.js')
    const { listCases } = await import('../selfreview/cases.js')
    const cfg = loadConfig()
    if (!cfg.databaseUrl) console.warn('⚠️ --from-db بدون DATABASE_URL — PGlite المحلي')
    const db = await createDb(cfg)
    try {
      const fromDb = (await listCases(db, { status: 'active', limit: 500 })).filter((c) => c.source !== 'seed')
      cases = cases.concat(fromDb.reverse())
    } finally { await db.close() }
  }
  const only = opt('only')
  if (only) cases = cases.filter((c) => (c.name ?? '').includes(only) || c.owner_message.includes(only))
  return cases
}

async function main() {
  const cases = await loadCases()
  const jsonPath = opt('json') ?? 'eval-report.json'
  const mdPath = opt('md')

  if (flag('compare')) {
    const p = pair()
    if (!p) { console.log('⏭️ المقارنة تحتاج NVIDIA_API_KEY و GEMINI_API_KEY معاً — تخطّي.'); return }
    // النص على النموذجين؛ الصوت على Gemini وحده (الإنتاج يفهم الصوت بـ Gemini دائماً)
    const a = await runEval(cases, { llm: p.primary.llm, model: p.primary.name, modality: 'text' })
    const b = await runEval(cases, { llm: p.fallback.llm, model: p.fallback.name, modality: 'text' })
    const v = await runEval(cases, { llm: p.fallback.llm, model: p.fallback.name, modality: 'voice' })
    console.log(formatTable(a), '\n'); console.log(formatTable(b), '\n'); if (v.total) console.log(formatTable(v), '\n')
    console.log(formatComparison(a, b, v))
    writeFileSync(jsonPath, JSON.stringify({ text: { primary: a, fallback: b }, voice: v }, null, 2))
    if (mdPath) writeFileSync(mdPath, `${formatTable(a, true)}\n\n${formatTable(b, true)}\n\n${v.total ? formatTable(v, true) : ''}\n`)
    return
  }

  const m = fromEnv()
  if (!m) console.log('⏭️ لا توجد مفاتيح نموذج (GEMINI_API_KEY / NVIDIA_API_KEY) — تُقيَّم الحالات الحتمية فقط، والباقي متخطّى.\n')
  const rep: EvalReport = await runEval(cases, { llm: m?.llm ?? null, model: m?.name ?? 'none (deterministic only)', concurrency: Number(process.env.EVAL_CONCURRENCY || 2) })
  console.log(formatTable(rep))
  writeFileSync(jsonPath, JSON.stringify(rep, null, 2))
  if (mdPath) writeFileSync(mdPath, formatTable(rep, true) + '\n')
  console.log(`\n📄 ${jsonPath}`)
  const min = Number(process.env.EVAL_MIN_SCORE || 0)
  if (m && min > 0 && rep.score < min) {
    console.error(`❌ الدرجة ${rep.score}% أقل من الحد ${min}%`)
    process.exitCode = 1
  }
}

main().then(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50)).catch((err) => { console.error(err); process.exit(2) })
