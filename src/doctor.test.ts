import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runChecks, runOnlineChecks, formatReport, type Check } from './doctor.js'
import { PROFILE_PLACEHOLDERS } from './profile.js'

/** مالك وهمي — لا بيانات حقيقية */
const VALID = JSON.stringify({
  owner: { name: 'سلمان' },
  assistant: { name: 'رفيق' },
  user_type: 'non_programmer',
  github: { owner: 'salman-demo', self_repo: 'salman-demo/rafiq-assistant', default_branch: 'main' },
})
const KEY64 = 'a'.repeat(64)
/** بيئة جاهزة: كل الفحوص تنجح */
const FULL = {
  TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LINK_CODE: 'x', GEMINI_API_KEY: 'x', DASHBOARD_PASSWORD: 'x',
  SECRETS_KEY: KEY64, PUBLIC_URL: 'https://bot.example.com', GITHUB_TOKEN: 'x',
}

const pick = (checks: Check[], id: string) => {
  const c = checks.find((x) => x.id === id)
  assert.ok(c, `missing check ${id}`)
  return c
}
const run = (env: Record<string, string | undefined>, config: string | null = VALID) => runChecks(env, config)

test('full env + valid config: every check ok', () => {
  const r = run(FULL)
  assert.deepEqual(r.map((c) => c.id), ['config', 'channel', 'link_code', 'ai', 'dashboard', 'secrets_key', 'wa_link', 'restart', 'public_url', 'github_token'])
  for (const c of r) assert.equal(c.ok, true, `${c.id}: ${c.message_ar}`)
  for (const c of r) assert.ok(c.message_ar.length > 0)
})

// ===== config =====
test('config: valid → ok, mentions assistant name', () => {
  const c = pick(run(FULL), 'config')
  assert.equal(c.ok, true)
  assert.equal(c.level, 'error')
  assert.match(c.message_ar, /رفيق/)
})

test('config: missing file → error pointing to the interview', () => {
  const c = pick(run(FULL, null), 'config')
  assert.equal(c.ok, false)
  assert.equal(c.level, 'error')
  assert.match(c.message_ar, /onboarding\/interview\.md/)
})

test('config: invalid JSON → error', () => {
  const c = pick(run(FULL, '{ not json'), 'config')
  assert.equal(c.ok, false)
  assert.match(c.message_ar, /JSON/)
})

test('config: example placeholder values → error pointing to the interview', () => {
  const example = readFileSync('assistant.config.example.json', 'utf8')
  const c = pick(run(FULL, example), 'config')
  assert.equal(c.ok, false)
  assert.equal(c.level, 'error')
  assert.match(c.message_ar, /القيم التجريبية/)
  assert.match(c.message_ar, /onboarding\/interview\.md/)
  // أي قيمة تجريبية وحدها تكفي للرفض
  const onlyRepo = JSON.parse(VALID)
  onlyRepo.github.self_repo = PROFILE_PLACEHOLDERS.repo
  assert.equal(pick(run(FULL, JSON.stringify(onlyRepo)), 'config').ok, false)
})

test('config: schema violation → error naming the field', () => {
  const bad = JSON.parse(VALID)
  bad.user_type = 'wizard'
  const c = pick(run(FULL, JSON.stringify(bad)), 'config')
  assert.equal(c.ok, false)
  assert.match(c.message_ar, /user_type/)
})

// ===== channel =====
test('channel: telegram token → ok', () => {
  assert.equal(pick(run({ TELEGRAM_BOT_TOKEN: 'x' }), 'channel').ok, true)
})

test('channel: full whatsapp gateway (no telegram) → ok', () => {
  const c = pick(run({ GATEWAY_URL: 'https://gw.example.com', GATEWAY_API_KEY: 'k', ASSISTANT_PHONE: '966500000001' }), 'channel')
  assert.equal(c.ok, true)
})

test('channel: none (or partial gateway, or blank token) → error', () => {
  for (const env of [{}, { GATEWAY_URL: 'https://gw.example.com', GATEWAY_API_KEY: 'k' }, { TELEGRAM_BOT_TOKEN: '   ' }]) {
    const c = pick(run(env), 'channel')
    assert.equal(c.ok, false)
    assert.equal(c.level, 'error')
    assert.match(c.message_ar, /TELEGRAM_BOT_TOKEN/)
  }
})

// ===== link_code =====
test('link_code: telegram + TELEGRAM_LINK_CODE or TELEGRAM_OWNER_CHAT_ID → ok', () => {
  assert.equal(pick(run({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LINK_CODE: 'c' }), 'link_code').ok, true)
  assert.equal(pick(run({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_OWNER_CHAT_ID: '12345' }), 'link_code').ok, true)
})

test('link_code: no telegram → ok (not applicable)', () => {
  const c = pick(run({}), 'link_code')
  assert.equal(c.ok, true)
  assert.equal(c.level, 'warn')
})

test('link_code: telegram without link code or owner chat id → warn', () => {
  for (const env of [{ TELEGRAM_BOT_TOKEN: 'x' }, { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LINK_CODE: '  ', TELEGRAM_OWNER_CHAT_ID: '' }]) {
    const c = pick(run(env), 'link_code')
    assert.equal(c.ok, false)
    assert.equal(c.level, 'warn')
    assert.match(c.message_ar, /TELEGRAM_LINK_CODE/)
    assert.match(c.message_ar, /\/start/)
  }
})

test('link_code: code with characters a t.me deep link rejects → warn to regenerate', () => {
  for (const TELEGRAM_LINK_CODE of ['has space', 'رمز-عربي', 'a+b/c', 'x'.repeat(65)]) {
    const c = pick(run({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LINK_CODE }), 'link_code')
    assert.equal(c.ok, false, TELEGRAM_LINK_CODE)
    assert.equal(c.level, 'warn')
    assert.match(c.message_ar, /TELEGRAM_LINK_CODE/)
    assert.ok(!c.message_ar.includes(TELEGRAM_LINK_CODE), 'never echoes the code')
  }
  // TELEGRAM_OWNER_CHAT_ID يغني عن الرمز
  assert.equal(pick(run({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LINK_CODE: 'has space', TELEGRAM_OWNER_CHAT_ID: '1' }), 'link_code').ok, true)
})

// ===== ai =====
test('ai: understand defaults to gemini → GEMINI_API_KEY present → ok', () => {
  const c = pick(run({ GEMINI_API_KEY: 'x' }), 'ai')
  assert.equal(c.ok, true)
  assert.match(c.message_ar, /gemini/)
})

test('ai: no key → warn only, names GEMINI_API_KEY', () => {
  const c = pick(run({}), 'ai')
  assert.equal(c.ok, false)
  assert.equal(c.level, 'warn')
  assert.match(c.message_ar, /GEMINI_API_KEY/)
})

test('ai: env routes understand to nvidia (with its key) → ok without gemini', () => {
  const c = pick(run({ LLM_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'x' }), 'ai')
  assert.equal(c.ok, true)
  assert.match(c.message_ar, /nvidia/)
})

// ===== dashboard =====
test('dashboard: password present → ok; missing → warn', () => {
  assert.equal(pick(run({ DASHBOARD_PASSWORD: 'x' }), 'dashboard').ok, true)
  const c = pick(run({}), 'dashboard')
  assert.equal(c.ok, false)
  assert.equal(c.level, 'warn')
  assert.match(c.message_ar, /DASHBOARD_PASSWORD/)
})

// ===== secrets_key =====
test('secrets_key: GATEWAY_PROVISION_KEY set + valid SECRETS_KEY → ok', () => {
  const c = pick(run({ GATEWAY_PROVISION_KEY: 'p', SECRETS_KEY: KEY64 }), 'secrets_key')
  assert.equal(c.ok, true)
})

test('secrets_key: GATEWAY_PROVISION_KEY set + missing/invalid SECRETS_KEY → error', () => {
  for (const SECRETS_KEY of [undefined, 'short', 'z'.repeat(64)]) {
    const c = pick(run({ GATEWAY_PROVISION_KEY: 'p', SECRETS_KEY }), 'secrets_key')
    assert.equal(c.ok, false)
    assert.equal(c.level, 'error')
    assert.match(c.message_ar, /SECRETS_KEY/)
  }
})

test('secrets_key: no provision key → never an error (invalid key = warn, empty = ok)', () => {
  const invalid = pick(run({ SECRETS_KEY: 'short' }), 'secrets_key')
  assert.equal(invalid.ok, false)
  assert.equal(invalid.level, 'warn')
  const empty = pick(run({}), 'secrets_key')
  assert.equal(empty.ok, true)
  assert.equal(empty.level, 'warn')
})

// ===== wa_link (ربط واتساب من اللوحة) =====
const WA_READY = { GATEWAY_PROVISION_KEY: 'p', GATEWAY_URL: 'https://gw.example.com', SECRETS_KEY: KEY64, WEBHOOK_SECRET: 'w'.repeat(16), PUBLIC_URL: 'https://bot.example.com' }

test('wa_link: no provision key → ok (not applicable)', () => {
  const c = pick(run({}), 'wa_link')
  assert.equal(c.ok, true)
})

test('wa_link: provision key + gateway url + 16-char webhook secret + public url → ok', () => {
  assert.equal(pick(run(WA_READY), 'wa_link').ok, true)
  // RAILWAY_PUBLIC_DOMAIN يكفي كرابط عام
  const { PUBLIC_URL: _, ...noPublic } = WA_READY
  assert.equal(pick(run({ ...noPublic, RAILWAY_PUBLIC_DOMAIN: 'example-rafiq.up.railway.app' }), 'wa_link').ok, true)
})

test('wa_link: provision key set → each missing prerequisite is an error naming it', () => {
  const cases: Array<[Record<string, string | undefined>, RegExp]> = [
    [{ ...WA_READY, GATEWAY_URL: '' }, /GATEWAY_URL/],
    [{ ...WA_READY, WEBHOOK_SECRET: undefined }, /WEBHOOK_SECRET/],
    [{ ...WA_READY, WEBHOOK_SECRET: 'short-secret' }, /WEBHOOK_SECRET/],
    [{ ...WA_READY, WEBHOOK_SECRET: '   ' + 'x'.repeat(10) + '   ' }, /WEBHOOK_SECRET/],
    [{ ...WA_READY, PUBLIC_URL: undefined }, /PUBLIC_URL/],
  ]
  for (const [env, re] of cases) {
    const c = pick(run(env), 'wa_link')
    assert.equal(c.ok, false, JSON.stringify(Object.keys(env)))
    assert.equal(c.level, 'error')
    assert.match(c.message_ar, re)
  }
  // كل الناقص في رسالة واحدة
  const all = pick(run({ GATEWAY_PROVISION_KEY: 'p' }), 'wa_link')
  for (const re of [/GATEWAY_URL/, /WEBHOOK_SECRET/, /PUBLIC_URL/]) assert.match(all.message_ar, re)
})

// ===== restart (إعادة التشغيل بعد ربط واتساب) =====
test('restart: no provision key → ok (not applicable)', () => {
  assert.equal(pick(run({}), 'restart').ok, true)
})

test('restart: provision key on Railway → ok', () => {
  for (const k of ['RAILWAY_ENVIRONMENT', 'RAILWAY_PROJECT_ID', 'RAILWAY_SERVICE_ID']) {
    assert.equal(pick(run({ ...WA_READY, [k]: 'x' }), 'restart').ok, true, k)
  }
})

test('restart: provision key off Railway → warn about automatic restart', () => {
  const c = pick(run(WA_READY), 'restart')
  assert.equal(c.ok, false)
  assert.equal(c.level, 'warn')
  assert.match(c.message_ar, /ربط واتساب يعيد تشغيل المساعد — تأكد إن الاستضافة تعيد التشغيل تلقائياً/)
  // RAILWAY_API_TOKEN يضبطه المالك بنفسه — مو دليل إننا على Railway
  assert.equal(pick(run({ ...WA_READY, RAILWAY_API_TOKEN: 't' }), 'restart').ok, false)
})

// ===== public_url =====
test('public_url: PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN → ok', () => {
  assert.equal(pick(run({ PUBLIC_URL: 'https://bot.example.com' }), 'public_url').ok, true)
  assert.equal(pick(run({ RAILWAY_PUBLIC_DOMAIN: 'example-rafiq.up.railway.app' }), 'public_url').ok, true)
})

test('public_url: none → warn about long polling', () => {
  const c = pick(run({}), 'public_url')
  assert.equal(c.ok, false)
  assert.equal(c.level, 'warn')
  assert.match(c.message_ar, /long polling/)
})

// ===== github_token =====
test('github_token: present → ok; missing → warn', () => {
  assert.equal(pick(run({ GITHUB_TOKEN: 'x' }), 'github_token').ok, true)
  const c = pick(run({}), 'github_token')
  assert.equal(c.ok, false)
  assert.equal(c.level, 'warn')
  assert.match(c.message_ar, /GITHUB_TOKEN/)
})

// ===== online (npm run doctor -- --online) =====
type Call = { url: string; init?: RequestInit }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
/** fetch مزيّف: يسجّل الطلبات ويرد حسب المضيف */
function fakeFetch(tg: () => Response | Promise<Response>, gm: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return url.startsWith('https://api.telegram.org/') ? tg() : gm()
  }) as typeof fetch
  return { f, calls }
}
const TG_OK = () => json(200, { ok: true, result: { id: 1, is_bot: true, username: 'rafiq_test_bot' } })
const GM_OK = () => json(200, { models: [{ name: 'models/gemini-x' }] })
const ONLINE_ENV = { TELEGRAM_BOT_TOKEN: '123:tg-SECRET-abc', GEMINI_API_KEY: 'gm-SECRET-xyz' }
const online = (env: Record<string, string | undefined>, f: typeof fetch, timeoutMs?: number) => runOnlineChecks(env, { fetch: f, timeoutMs })

test('online: valid token and key → ok, names the bot', async () => {
  const { f, calls } = fakeFetch(TG_OK, GM_OK)
  const r = await online(ONLINE_ENV, f)
  assert.deepEqual(r.map((c) => c.id), ['telegram_online', 'gemini_online'])
  const tg = pick(r, 'telegram_online')
  assert.equal(tg.ok, true)
  assert.match(tg.message_ar, /توكن تيليجرام صحيح — البوت @rafiq_test_bot/)
  assert.equal(pick(r, 'gemini_online').ok, true)
  assert.equal(calls.length, 2)
  assert.match(calls[0]!.url, /^https:\/\/api\.telegram\.org\/bot.+\/getMe$/)
  // مفتاح Gemini في الترويسة، مو في الرابط
  const gm = calls[1]!
  assert.match(gm.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models/)
  assert.doesNotMatch(gm.url, /SECRET/)
  assert.equal(new Headers(gm.init?.headers).get('x-goog-api-key'), ONLINE_ENV.GEMINI_API_KEY)
  for (const c of calls) assert.ok(c.init?.signal, 'every request has a timeout signal')
})

test('online: wrong telegram token (401 or 404) → error telling him to copy it again', async () => {
  for (const status of [401, 404]) {
    const { f } = fakeFetch(() => json(status, { ok: false, error_code: status, description: 'Unauthorized' }), GM_OK)
    const c = pick(await online(ONLINE_ENV, f), 'telegram_online')
    assert.equal(c.ok, false)
    assert.equal(c.level, 'error')
    assert.match(c.message_ar, /توكن تيليجرام غلط — انسخه من BotFather مرة ثانية/)
  }
})

test('online: wrong Gemini key (400/401/403) → error', async () => {
  for (const status of [400, 401, 403]) {
    const { f } = fakeFetch(TG_OK, () => json(status, { error: { code: status, status: 'INVALID_ARGUMENT' } }))
    const c = pick(await online(ONLINE_ENV, f), 'gemini_online')
    assert.equal(c.ok, false)
    assert.equal(c.level, 'error')
    assert.match(c.message_ar, /مفتاح Gemini غلط/)
    assert.match(c.message_ar, /aistudio\.google\.com\/apikey/)
  }
})

test('online: network failure, timeout or server error → warn, never error', async () => {
  const boom = () => { throw new TypeError('fetch failed') }
  for (const [tg, gm] of [[boom, boom], [() => json(502, {}), () => json(500, {})], [() => json(429, { ok: false }), () => json(429, {})]] as const) {
    const { f } = fakeFetch(tg, gm)
    for (const c of await online(ONLINE_ENV, f)) {
      assert.equal(c.ok, false)
      assert.equal(c.level, 'warn', c.id)
      assert.match(c.message_ar, /ما قدرت أتحقق/)
    }
  }
  // مهلة: الطلب المعلّق ينقطع بعد timeoutMs (الافتراضي ٨ ثوانٍ)
  const hanging = (async (_u: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, rej) => {
    // مؤقّت حيّ يمثّل السوكت المعلّق (مؤقّت AbortSignal.timeout ما يبقي العملية حيّة بنفسه)
    const keepAlive = setTimeout(() => {}, 5_000)
    init?.signal?.addEventListener('abort', () => { clearTimeout(keepAlive); rej(init.signal!.reason) })
  })) as typeof fetch
  const t0 = Date.now()
  const r = await online(ONLINE_ENV, hanging, 30)
  assert.ok(Date.now() - t0 < 2000)
  for (const c of r) { assert.equal(c.level, 'warn'); assert.equal(c.ok, false) }
})

test('online: unconfigured keys are skipped (no request)', async () => {
  const { f, calls } = fakeFetch(TG_OK, GM_OK)
  assert.deepEqual(await online({ TELEGRAM_BOT_TOKEN: '  ' }, f), [])
  assert.equal(calls.length, 0)
  const onlyTg = await online({ TELEGRAM_BOT_TOKEN: 'x' }, f)
  assert.deepEqual(onlyTg.map((c) => c.id), ['telegram_online'])
})

test('online: messages never contain the token or key', async () => {
  for (const [tg, gm] of [[TG_OK, GM_OK], [() => json(401, {}), () => json(400, {})], [() => { throw new Error('https://api.telegram.org/bot123:tg-SECRET-abc/getMe failed') }, () => { throw new Error('gm-SECRET-xyz') }]] as const) {
    const { f } = fakeFetch(tg, gm)
    const text = (await online(ONLINE_ENV, f)).map((c) => c.message_ar).join(' | ')
    assert.doesNotMatch(text, /SECRET/)
  }
})

// ===== secrets never leak =====
test('messages never contain secret values', () => {
  const env = { TELEGRAM_BOT_TOKEN: 'tg-SECRET-123', GEMINI_API_KEY: 'gm-SECRET-456', DASHBOARD_PASSWORD: 'pw-SECRET-789', SECRETS_KEY: 'sk-SECRET-bad', GITHUB_TOKEN: 'gh-SECRET-000', GATEWAY_PROVISION_KEY: 'pv-SECRET-111' }
  const all = run(env).map((c) => c.message_ar).join('\n')
  assert.doesNotMatch(all, /SECRET-/)
})

// ===== report =====
test('formatReport: ✅/⚠️/❌ lines and exit code 1 only on errors', () => {
  const bad = formatReport(run({}, null))
  assert.equal(bad.exitCode, 1)
  assert.match(bad.text, /❌/)
  assert.match(bad.text, /⚠️/)
  const warnOnly = formatReport(run({ TELEGRAM_BOT_TOKEN: 'x', GEMINI_API_KEY: 'x' }))
  assert.equal(warnOnly.exitCode, 0)
  assert.match(warnOnly.text, /✅/)
  assert.match(warnOnly.text, /⚠️/)
  assert.doesNotMatch(warnOnly.text, /❌/)
  const good = formatReport(run(FULL))
  assert.equal(good.exitCode, 0)
  assert.doesNotMatch(good.text, /❌|⚠️/)
})
