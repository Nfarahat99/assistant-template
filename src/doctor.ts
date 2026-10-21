import { loadConfig } from './config.js'
import { defaultModels, type ProviderId } from './ai/roles.js'
import { parseProfile } from './profile.js'
import { isValidKey } from './lib/secretbox.js'
import { isStartPayload } from './telegram/deep-link.js'

/**
 * فحص الجاهزية (npm run doctor): دالة نقية تأخذ البيئة ونص assistant.config.json
 * وترجع قائمة فحوص. لا تطبع، ولا تقرأ ملفات، ولا تكتب أي قيمة سرية في الرسائل.
 */
export type Check = { id: string; ok: boolean; level: 'error' | 'warn'; message_ar: string }
export type Env = Record<string, string | undefined>

const CONFIG_FILE = 'assistant.config.json'
const INTERVIEW = 'onboarding/interview.md'

/** متغير البيئة لمفتاح كل مزوّد */
export const PROVIDER_KEY: Record<ProviderId, string> = {
  gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', nvidia: 'NVIDIA_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
}

const has = (env: Env, k: string) => !!(env[k] || '').trim()

function checkConfig(configText: string | null): Check {
  const fail = (message_ar: string): Check => ({ id: 'config', ok: false, level: 'error', message_ar })
  if (configText === null) return fail(`ملف ${CONFIG_FILE} غير موجود — شغّل المقابلة التقنية (${INTERVIEW}) في Claude Code`)
  let raw: unknown
  try { raw = JSON.parse(configText) } catch {
    return fail(`ملف ${CONFIG_FILE} مو JSON صالح — صحّحه أو أعد المقابلة التقنية (${INTERVIEW})`)
  }
  try {
    const p = parseProfile(raw, CONFIG_FILE)
    return { id: 'config', ok: true, level: 'error', message_ar: `ملف الإعدادات سليم — المساعد «${p.assistant.name}» للمالك «${p.owner.name}»` }
  } catch (e) {
    // نفس رسالة الإقلاع (القيم التجريبية أو الحقل الخاطئ)
    return fail((e as Error).message)
  }
}

function checkChannel(env: Env): Check {
  const tg = has(env, 'TELEGRAM_BOT_TOKEN')
  const wa = has(env, 'GATEWAY_URL') && has(env, 'GATEWAY_API_KEY') && has(env, 'ASSISTANT_PHONE')
  if (!tg && !wa) {
    return { id: 'channel', ok: false, level: 'error', message_ar: 'ما فيه قناة — ضع TELEGRAM_BOT_TOKEN (من @BotFather) أو اضبط واتساب كاملاً (GATEWAY_URL وGATEWAY_API_KEY وASSISTANT_PHONE)' }
  }
  const which = tg && wa ? 'تيليجرام وواتساب' : tg ? 'تيليجرام' : 'واتساب'
  return { id: 'channel', ok: true, level: 'error', message_ar: `القناة جاهزة: ${which}` }
}

/** ربط المالك في تيليجرام: TELEGRAM_OWNER_CHAT_ID أو "/start <TELEGRAM_LINK_CODE>" — بدونهما ما أحد يقدر يربط نفسه */
function checkLinkCode(env: Env): Check {
  if (!has(env, 'TELEGRAM_BOT_TOKEN')) return { id: 'link_code', ok: true, level: 'warn', message_ar: 'ربط تيليجرام مو مطلوب (تيليجرام غير مضبوط)' }
  const code = (env.TELEGRAM_LINK_CODE || '').trim()
  if (code && !has(env, 'TELEGRAM_OWNER_CHAT_ID') && !isStartPayload(code)) {
    return { id: 'link_code', ok: false, level: 'warn', message_ar: 'TELEGRAM_LINK_CODE فيه رموز ما يقبلها رابط تيليجرام المباشر (المسموح حروف إنجليزية وأرقام و _ و - حتى 64 خانة) — اطلب من Claude: «ولّد TELEGRAM_LINK_CODE جديد»' }
  }
  return code || has(env, 'TELEGRAM_OWNER_CHAT_ID')
    ? { id: 'link_code', ok: true, level: 'warn', message_ar: 'ربط المالك في تيليجرام جاهز (TELEGRAM_LINK_CODE أو TELEGRAM_OWNER_CHAT_ID)' }
    : { id: 'link_code', ok: false, level: 'warn', message_ar: 'ما فيه TELEGRAM_LINK_CODE ولا TELEGRAM_OWNER_CHAT_ID — ما تقدر تربط نفسك بالبوت بـ /start. اطلب من Claude: «ولّد TELEGRAM_LINK_CODE»' }
}

function checkAi(env: Env): Check {
  // نفس منطق الإقلاع: Gemini افتراضياً ما لم تقل البيئة غير ذلك (إعدادات اللوحة المحفوظة تعلو عليه لاحقاً)
  const provider = defaultModels(loadConfig(env as NodeJS.ProcessEnv)).understand.provider
  const key = PROVIDER_KEY[provider]
  if (has(env, key)) return { id: 'ai', ok: true, level: 'warn', message_ar: `مفتاح الذكاء لدور الفهم موجود (${provider}: ${key})` }
  const link = provider === 'gemini' ? ' مفتاح مجاني: https://aistudio.google.com/apikey —' : ''
  return { id: 'ai', ok: false, level: 'warn', message_ar: `ما فيه ${key} — المساعد ما بيفهم الرسائل (الفهم على ${provider}).${link} لو اخترت مزوّد ثاني من اللوحة تجاهل هذا` }
}

function checkDashboard(env: Env): Check {
  return has(env, 'DASHBOARD_PASSWORD')
    ? { id: 'dashboard', ok: true, level: 'warn', message_ar: 'كلمة مرور اللوحة موجودة (DASHBOARD_PASSWORD)' }
    : { id: 'dashboard', ok: false, level: 'warn', message_ar: 'ما فيه DASHBOARD_PASSWORD — لوحة التحكم معطّلة لين تضيفه' }
}

function checkSecretsKey(env: Env): Check {
  const key = (env.SECRETS_KEY || '').trim()
  const valid = isValidKey(key)
  if (has(env, 'GATEWAY_PROVISION_KEY')) {
    return valid
      ? { id: 'secrets_key', ok: true, level: 'error', message_ar: 'SECRETS_KEY صالح (لازم لربط واتساب من اللوحة)' }
      : { id: 'secrets_key', ok: false, level: 'error', message_ar: 'SECRETS_KEY ناقص أو غير صالح — لازم 64 خانة hex لأن GATEWAY_PROVISION_KEY مضبوط. اطلب من Claude: «ولّد SECRETS_KEY جديد»' }
  }
  if (!key) return { id: 'secrets_key', ok: true, level: 'warn', message_ar: 'SECRETS_KEY مو مطلوب الحين (يلزم لاحقاً لربط واتساب من اللوحة)' }
  return valid
    ? { id: 'secrets_key', ok: true, level: 'warn', message_ar: 'SECRETS_KEY صالح' }
    : { id: 'secrets_key', ok: false, level: 'warn', message_ar: 'SECRETS_KEY غير صالح (لازم 64 خانة hex) — ربط واتساب من اللوحة ما بيشتغل. اطلب من Claude: «ولّد SECRETS_KEY جديد»' }
}

const hasPublicUrl = (env: Env) => has(env, 'PUBLIC_URL') || has(env, 'RAILWAY_PUBLIC_DOMAIN')

/**
 * ربط واتساب من اللوحة (GATEWAY_PROVISION_KEY): نفس شروط waLinkMissing في src/dashboard/wa-link.ts
 * (SECRETS_KEY يفحصه checkSecretsKey). بدونها صفحة «الحسابات» تقول «غير متاح».
 */
function checkWaLink(env: Env): Check {
  if (!has(env, 'GATEWAY_PROVISION_KEY')) return { id: 'wa_link', ok: true, level: 'warn', message_ar: 'ربط واتساب من اللوحة مو مضبوط (GATEWAY_PROVISION_KEY فاضي) — اختياري' }
  const missing: string[] = []
  if (!has(env, 'GATEWAY_URL')) missing.push('GATEWAY_URL (رابط الوسيط — من صاحب الوسيط)')
  if ((env.WEBHOOK_SECRET || '').trim().length < 16) missing.push('WEBHOOK_SECRET (16 حرفاً أو أكثر — اطلب من Claude: «ولّد WEBHOOK_SECRET»)')
  if (!hasPublicUrl(env)) missing.push('PUBLIC_URL (رابط عام — على Railway تلقائي بعد Generate Domain)')
  return missing.length
    ? { id: 'wa_link', ok: false, level: 'error', message_ar: `GATEWAY_PROVISION_KEY مضبوط لكن ربط واتساب من اللوحة ناقصه: ${missing.join('، ')}` }
    : { id: 'wa_link', ok: true, level: 'error', message_ar: 'متطلبات ربط واتساب من اللوحة كاملة (GATEWAY_URL وWEBHOOK_SECRET والرابط العام)' }
}

/** متغيرات يضبطها Railway نفسه داخل الخدمة (مو RAILWAY_API_TOKEN اللي يضبطه المالك) */
const RAILWAY_RUNTIME = ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']
export const isRailway = (env: Env) => RAILWAY_RUNTIME.some((k) => has(env, k))

/** الربط وفكّه ينهيان العملية (process.exit(75)) — على غير Railway لازم سياسة إعادة تشغيل */
function checkRestart(env: Env): Check {
  if (!has(env, 'GATEWAY_PROVISION_KEY')) return { id: 'restart', ok: true, level: 'warn', message_ar: 'إعادة التشغيل التلقائية مو مطلوبة (ربط واتساب من اللوحة مو مضبوط)' }
  return isRailway(env)
    ? { id: 'restart', ok: true, level: 'warn', message_ar: 'على Railway — يعيد تشغيل المساعد تلقائياً بعد ربط واتساب' }
    : { id: 'restart', ok: false, level: 'warn', message_ar: 'ربط واتساب يعيد تشغيل المساعد — تأكد إن الاستضافة تعيد التشغيل تلقائياً (Railway تلقائي؛ Docker: restart: unless-stopped؛ systemd: Restart=always — docs/TEMPLATE.md القسم ٨). لو بتنشر على Railway تجاهل هذا' }
}

function checkPublicUrl(env: Env): Check {
  return hasPublicUrl(env)
    ? { id: 'public_url', ok: true, level: 'warn', message_ar: 'الرابط العام موجود — تيليجرام يشتغل بالويبهوك' }
    : { id: 'public_url', ok: false, level: 'warn', message_ar: 'ما فيه PUBLIC_URL ولا RAILWAY_PUBLIC_DOMAIN — تيليجرام بيشتغل بالاستطلاع (long polling). على Railway: Settings ← Networking ← Generate Domain' }
}

function checkGithubToken(env: Env): Check {
  return has(env, 'GITHUB_TOKEN')
    ? { id: 'github_token', ok: true, level: 'warn', message_ar: 'GITHUB_TOKEN موجود — التطوير الذاتي متاح' }
    : { id: 'github_token', ok: false, level: 'warn', message_ar: 'ما فيه GITHUB_TOKEN — طلبات تعديل الكود (التطوير الذاتي) معطّلة' }
}

/** كل الفحوص بالترتيب. `configText` = نص assistant.config.json، أو null إن لم يوجد. */
export function runChecks(env: Env, configText: string | null): Check[] {
  return [
    checkConfig(configText),
    checkChannel(env),
    checkLinkCode(env),
    checkAi(env),
    checkDashboard(env),
    checkSecretsKey(env),
    checkWaLink(env),
    checkRestart(env),
    checkPublicUrl(env),
    checkGithubToken(env),
  ]
}

// ===== فحص أونلاين (npm run doctor -- --online) =====
// منفصل عن runChecks (اللي يبقى نقياً): يكلّم تيليجرام وGemini بالمفاتيح المضبوطة. لا يطبع أي قيمة سرية،
// ومشكلة الشبكة تنبيه (⚠️) مو خطأ — الخطأ (❌) فقط لما الخدمة نفسها ترفض التوكن أو المفتاح.

export type OnlineOptions = { fetch?: typeof fetch; timeoutMs?: number }
export const ONLINE_TIMEOUT_MS = 8_000

type Probe = { status: number; body: any } | null

/** طلب واحد بمهلة؛ null عند أي فشل شبكة أو مهلة (بدون أي تفاصيل — رسالة الخطأ قد تحوي الرابط وفيه التوكن) */
async function probe(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Probe> {
  try {
    const res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    const body = await res.json().catch(() => null)
    return { status: res.status, body }
  } catch {
    return null
  }
}

export type GetMeResult = { kind: 'ok'; username: string } | { kind: 'bad' } | { kind: 'unreachable' }

/** Telegram getMe: يتحقق من التوكن ويرجع اسم مستخدم البوت (يُستخدم أيضاً في scripts/telegram-link.mjs) */
export async function telegramGetMe(token: string, opts: OnlineOptions = {}): Promise<GetMeResult> {
  const f = opts.fetch ?? fetch
  const r = await probe(f, `https://api.telegram.org/bot${token.trim()}/getMe`, { method: 'GET' }, opts.timeoutMs ?? ONLINE_TIMEOUT_MS)
  if (!r) return { kind: 'unreachable' }
  // 401 = توكن مرفوض؛ 404 = صيغة التوكن نفسها غلط
  if (r.status === 401 || r.status === 404) return { kind: 'bad' }
  const username = r.body?.ok === true ? r.body?.result?.username : undefined
  if (r.status === 200 && typeof username === 'string' && /^\w{1,64}$/.test(username)) return { kind: 'ok', username }
  return { kind: 'unreachable' }
}

async function checkTelegramOnline(token: string, opts: OnlineOptions): Promise<Check> {
  const r = await telegramGetMe(token, opts)
  if (r.kind === 'ok') return { id: 'telegram_online', ok: true, level: 'error', message_ar: `توكن تيليجرام صحيح — البوت @${r.username}` }
  if (r.kind === 'bad') return { id: 'telegram_online', ok: false, level: 'error', message_ar: 'توكن تيليجرام غلط — انسخه من BotFather مرة ثانية (افتح @BotFather ← /mybots ← بوتك ← API Token) والصقه في TELEGRAM_BOT_TOKEN' }
  return { id: 'telegram_online', ok: false, level: 'warn', message_ar: 'ما قدرت أتحقق من توكن تيليجرام (مشكلة اتصال أو تيليجرام ما رد) — تأكد من الإنترنت وجرّب بعدين' }
}

async function checkGeminiOnline(key: string, opts: OnlineOptions): Promise<Check> {
  // المفتاح في الترويسة (x-goog-api-key) مو في الرابط
  const r = await probe(opts.fetch ?? fetch, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    { method: 'GET', headers: { 'x-goog-api-key': key.trim() } }, opts.timeoutMs ?? ONLINE_TIMEOUT_MS)
  if (r && r.status === 200) return { id: 'gemini_online', ok: true, level: 'error', message_ar: 'مفتاح Gemini صحيح' }
  if (r && [400, 401, 403].includes(r.status)) {
    return { id: 'gemini_online', ok: false, level: 'error', message_ar: 'مفتاح Gemini غلط أو موقوف — انسخه مرة ثانية من https://aistudio.google.com/apikey والصقه في GEMINI_API_KEY' }
  }
  return { id: 'gemini_online', ok: false, level: 'warn', message_ar: 'ما قدرت أتحقق من مفتاح Gemini (مشكلة اتصال أو Google ما رد) — تأكد من الإنترنت وجرّب بعدين' }
}

/** الفحوص الأونلاين للمفاتيح المضبوطة فقط (غير المضبوط يغطيه runChecks) */
export async function runOnlineChecks(env: Env, opts: OnlineOptions = {}): Promise<Check[]> {
  const jobs: Promise<Check>[] = []
  if (has(env, 'TELEGRAM_BOT_TOKEN')) jobs.push(checkTelegramOnline(env.TELEGRAM_BOT_TOKEN!, opts))
  if (has(env, 'GEMINI_API_KEY')) jobs.push(checkGeminiOnline(env.GEMINI_API_KEY!, opts))
  return Promise.all(jobs)
}

const ICON = { ok: '✅', warn: '⚠️', error: '❌' } as const

/** يحوّل الفحوص لنص مطبوع ورمز خروج (1 عند أي خطأ) */
export function formatReport(checks: Check[]): { text: string; exitCode: 0 | 1 } {
  const lines = checks.map((c) => `${c.ok ? ICON.ok : ICON[c.level]} ${c.message_ar}`)
  const errors = checks.filter((c) => !c.ok && c.level === 'error').length
  const warns = checks.filter((c) => !c.ok && c.level === 'warn').length
  const summary = errors
    ? `النتيجة: ${errors} خطأ لازم يتصلح (❌) و${warns} تنبيه — لا تنشر قبل ما تصلح الأخطاء`
    : warns ? `النتيجة: جاهز مع ${warns} تنبيه (⚠️)` : 'النتيجة: كل شي جاهز'
  return { text: [...lines, '', summary].join('\n'), exitCode: errors ? 1 : 0 }
}
