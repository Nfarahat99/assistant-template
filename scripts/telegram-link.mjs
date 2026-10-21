// رابط ربط تيليجرام: npm run telegram-link
// يقرأ TELEGRAM_BOT_TOKEN وTELEGRAM_LINK_CODE من .env، ويجيب اسم البوت من getMe،
// ثم يفتح https://t.me/<bot>?start=<الرمز> في المتصفح الافتراضي. المالك يضغط «Start» في تيليجرام ويتربط —
// بدون ما ينسخ الرمز من الكمبيوتر للجوال. لا يطبع الرمز ولا التوكن ولا الرابط (الرابط فيه الرمز).
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { telegramGetMe } from '../src/doctor.ts'
import { isStartPayload, telegramStartUrl, openUrlCommand } from '../src/telegram/deep-link.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: resolve(root, '.env'), quiet: true })

const FALLBACK = 'البديل: افتح بوتك في تيليجرام واكتب /start ثم مسافة ثم قيمة TELEGRAM_LINK_CODE من ملف .env'
const fail = (msg) => { console.log(`❌ ${msg}\n${FALLBACK}`); process.exitCode = 1 }

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim()
const code = (process.env.TELEGRAM_LINK_CODE || '').trim()

if (!token) fail('ما فيه TELEGRAM_BOT_TOKEN في .env — الصق توكن BotFather أول')
else if (!code) fail('ما فيه TELEGRAM_LINK_CODE في .env — اطلب من Claude: «ولّد TELEGRAM_LINK_CODE»')
else if (!isStartPayload(code)) fail('TELEGRAM_LINK_CODE فيه رموز ما يقبلها رابط تيليجرام (المسموح: حروف إنجليزية وأرقام و _ و -، حتى 64 خانة) — اطلب من Claude يولّد رمز جديد ويحدّثه في Railway')
else {
  const me = await telegramGetMe(token)
  if (me.kind === 'bad') fail('توكن تيليجرام غلط — انسخه من BotFather مرة ثانية')
  else if (me.kind === 'unreachable') fail('ما قدرت أوصل لتيليجرام (مشكلة اتصال) — جرّب بعدين')
  else {
    const { cmd, args } = openUrlCommand(process.platform, telegramStartUrl(me.username, code))
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => fail('ما قدرت أفتح المتصفح على هذا الجهاز'))
    child.on('spawn', () => {
      child.unref()
      console.log(`✅ فتحت رابط بوتك @${me.username} في المتصفح.`)
      console.log('الحين: اضغط «Start» (أو «ابدأ») — لو سألك المتصفح افتح تيليجرام. لازم يكون المساعد منشور على Railway عشان يرد.')
      console.log('يشتغل من تيليجرام الكمبيوتر أو الويب أو الجوال — الربط لحسابك نفسه في كل الأجهزة.')
    })
  }
}
