// فحص الجاهزية: npm run doctor            (بدون إنترنت — يفحص وجود الإعدادات والمفاتيح)
//               npm run doctor -- --online (+ يتحقق من صحة توكن تيليجرام ومفتاح Gemini عند تيليجرام وGoogle)
// يُشغَّل عبر tsx (package.json: "doctor": "tsx scripts/doctor.mjs") لأن منطق الفحص في src/doctor.ts (TypeScript).
// يقرأ process.env (+ ملف .env في جذر المستودع عبر dotenv) وملف assistant.config.json، ويطبع ✅/⚠️/❌.
// رمز الخروج 1 عند أي خطأ (❌). لا يطبع أي قيمة سرية.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { runChecks, runOnlineChecks, formatReport, isRailway } from '../src/doctor.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env'), quiet: true })
const online = process.argv.slice(2).includes('--online')

const configPath = resolve(root, process.env.ASSISTANT_CONFIG || 'assistant.config.json')
const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null

const checks = runChecks(process.env, configText)
if (online) checks.push(...(await runOnlineChecks(process.env)))
const { text, exitCode } = formatReport(checks)
console.log(`فحص الجاهزية (npm run doctor${online ? ' -- --online' : ''})\n`)
console.log(text)

// على الجهاز المحلي الأسرار غالباً في Railway وليست في .env — نوضّح ذلك بدل ما يبدو كأنه عطل
const envFailed = checks.some((c) => !c.ok && c.id !== 'config')
if (envFailed && !isRailway(process.env)) {
  console.log('\nملاحظة: الفحص يقرأ ملف .env على هذا الجهاز. لو حطيت الأسرار في Railway فقط، افحصها بـ: railway run npm run doctor')
}
if (!online) console.log('\nللتحقق إن توكن تيليجرام ومفتاح Gemini صحيحين (يحتاج إنترنت): npm run doctor -- --online')
// exitCode بدل process.exit: يخلي المخرجات تنكتب كاملة قبل الخروج (مهم لما تكون موجّهة لملف أو أنبوب)
process.exitCode = exitCode
