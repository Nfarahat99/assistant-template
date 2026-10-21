/**
 * لوحة التحكم: المصادقة (401، القفل 429، الكوكي، CSRF) وشكل كل مسار على PGlite في الذاكرة.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Settings, getSetting } from './settings.js'
import { ProjectRegistry, parseProjects } from './projects.js'
import { buildServer } from './server.js'
import { profile, setProfile } from './profile.js'
import type { GatewayClient } from './clients/gateway.js'
import { LoginLimiter, LOCK_MAX_PER_IP, LOCK_WINDOW_MS } from './dashboard/auth.js'
import { parseSources, joinProjects } from './dashboard/projects-info.js'

const PASSWORD = 'correct horse'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ ASSISTANT_PHONE: ASSISTANT, OWNER_PHONE: '966500000001', TZ: 'Asia/Riyadh', PROJECTS_FILE: './projects.json' } as any)

let db: Db
let store: Store
let settings: Settings
let app: ReturnType<typeof buildServer>
const snap = { status: 'connected', reason: null as string | null, paused_reason: null as string | null, banned: false, down_since: null as string | null }
let relinks = 0
const gateway: GatewayClient = {
  async sendText() { throw new Error('no') },
  async getMessage() { throw new Error('no') },
  async getStatus() { return { status: snap.status as any } },
  async relink() { relinks++ },
  async qrPng() { return Buffer.from('PNGDATA') },
}

let cookie = ''
const H = (extra: Record<string, string> = {}) => ({ cookie, 'x-requested-with': 'dash', ...extra })
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = H()) {
  const res = await app.inject({ method: method as any, url, headers: body !== undefined ? { ...headers, 'content-type': 'application/json' } : headers, payload: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: res.statusCode, body: res.body ? (() => { try { return JSON.parse(res.body) } catch { return res.body } })() : null, headers: res.headers }
}

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  settings = new Settings(cfg, store)
  await settings.load()
  await store.setKv('knowledge_md', '# عن المالك\n- وليد')
  const projects = new ProjectRegistry(parseProjects(JSON.stringify([
    { folder: 'C:/whatsappSiraj', repo: 'example-user/whatsapp-siraj', default_branch: 'main', aliases: ['واتساب سراج'], railway_project: 'whatsapp-siraj' },
    { folder: 'C:/hudoor', repo: 'example-user/hudoor', default_branch: 'master', aliases: ['تحضير سراج'] },
  ])))
  app = buildServer({
    assistant: {} as any,
    webhookSecret: 'x',
    dashboard: {
      password: PASSWORD, db, store, cfg, settings, projects, gateway,
      watchdog: { snapshot: () => snap },
      telegram: { bound: true },
      version: { sha: 'abcdef1234567', message: 'feat', date: '2026-09-29T00:00:00Z', built_at: '2026-09-29T01:00:00Z', source: 'test' },
      keyStatus: () => [{ role: 'understand', provider: 'anthropic', hasKey: false, fallbackProvider: 'gemini', fallbackHasKey: true }],
      railwayInfo: async () => [
        { project: 'whatsapp-siraj', repo: 'example-user/whatsapp-siraj', domain: 'wa.example.app', deployed: true },
      ],
    },
  })
  await app.ready()
})
after(async () => { await app.close(); await db.close() })

test('dashboard: بلا كلمة مرور ← لا لوحة (404)', async () => {
  const bare = buildServer({ assistant: {} as any, webhookSecret: 'x' })
  assert.equal((await bare.inject({ url: '/dashboard/' })).statusCode, 404)
  assert.equal((await bare.inject({ url: '/api/dash/overview' })).statusCode, 404)
  await bare.close()
})

test('dashboard: الواجهة الثابتة + CSP + X-Frame-Options', async () => {
  const r = await app.inject({ url: '/dashboard/' })
  assert.equal(r.statusCode, 200)
  assert.match(r.body, /لوحة مساعد سراج/)
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'; img-src 'self' data:; style-src 'self' https:\/\/fonts.googleapis.com/)
  assert.match(String(r.headers['content-security-policy']), /font-src https:\/\/fonts.gstatic.com/)
  assert.equal(r.headers['x-frame-options'], 'DENY')
  assert.equal((await app.inject({ url: '/dashboard/api.js' })).statusCode, 200)
  assert.equal((await app.inject({ url: '/dashboard' })).statusCode, 301)
  const fallback = await app.inject({ url: '/dashboard/tasks' })
  assert.equal(fallback.statusCode, 200)
  assert.match(fallback.body, /<!doctype html>/i)
  assert.equal((await app.inject({ url: '/dashboard/nope.js' })).statusCode, 404)
})

test('dashboard: الصفحة تحمل اسم مساعد المالك من الملف الشخصي (مهرّباً) — لا «سراج» مدمجة', async () => {
  const before = profile()
  try {
    setProfile({ ...before, assistant: { name: 'سند <b>&' } })
    for (const url of ['/dashboard/', '/dashboard/index.html', '/dashboard/tasks']) {
      const r = await app.inject({ url })
      assert.equal(r.statusCode, 200, url)
      assert.match(r.body, /<title>لوحة مساعد سند &lt;b&gt;&amp;<\/title>/, url)
      assert.match(r.body, /<meta name="assistant-name" content="سند &lt;b&gt;&amp;">/, url)
      assert.doesNotMatch(r.body, /سراج|\{\{/, url)
      assert.match(String(r.headers['content-type']), /text\/html/)
      assert.equal(r.headers['x-frame-options'], 'DENY')
    }
  } finally { setProfile(before) }
  assert.match((await app.inject({ url: '/dashboard/' })).body, /<b>مساعد سراج<\/b>/)
})

test('dashboard: بلا جلسة ← 401 JSON بالعربي', async () => {
  const r = await call('GET', '/api/dash/overview', undefined, {})
  assert.equal(r.status, 401)
  assert.match(r.body.error, /سجّل الدخول/)
  assert.equal((await call('GET', '/api/dash/tasks', undefined, { cookie: 'dash_sid=forged' })).status, 401)
})

test('dashboard: CSRF — التعديل بلا X-Requested-With ← 403', async () => {
  const r = await call('POST', '/api/dash/login', { password: PASSWORD }, {})
  assert.equal(r.status, 403)
})

test('dashboard: الدخول يضع كوكي httpOnly Secure SameSite=Strict لمدة 30 يوماً', async () => {
  const bad = await call('POST', '/api/dash/login', { password: 'nope' }, { 'x-requested-with': 'dash', 'x-forwarded-for': '10.0.0.9' })
  assert.equal(bad.status, 401)
  const r = await call('POST', '/api/dash/login', { password: PASSWORD }, { 'x-requested-with': 'dash' })
  assert.equal(r.status, 200)
  const set = String(r.headers['set-cookie'])
  assert.match(set, /^dash_sid=[\w-]{40,};/)
  assert.match(set, /HttpOnly/)
  assert.match(set, /Secure/)
  assert.match(set, /SameSite=Strict/)
  assert.match(set, /Max-Age=2592000/)
  cookie = set.split(';')[0]
  // الرمز مخزّن مجزّأً فقط
  const [row] = await db.query<any>(`SELECT token_hash FROM dash_sessions LIMIT 1`)
  assert.notEqual(row.token_hash, cookie.split('=')[1])
  assert.equal((await call('GET', '/api/dash/overview')).status, 200)
  // التعديل بجلسة صالحة لكن بلا الترويسة ← 403
  assert.equal((await call('POST', '/api/dash/tasks', { title: 'x' }, { cookie })).status, 403)
})

test('dashboard: قفل بعد 10 محاولات خاطئة خلال 15 دقيقة ← 429 (حتى بكلمة صحيحة)', async () => {
  const hdr = { 'x-requested-with': 'dash', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' }
  for (let i = 0; i < 10; i++) assert.equal((await call('POST', '/api/dash/login', { password: 'bad' + i }, hdr)).status, 401)
  const locked = await call('POST', '/api/dash/login', { password: PASSWORD }, hdr)
  assert.equal(locked.status, 429)
  assert.ok(Number(locked.headers['retry-after']) > 0)
  // IP آخر غير متأثر
  assert.equal((await call('POST', '/api/dash/login', { password: PASSWORD }, { 'x-requested-with': 'dash', 'x-forwarded-for': '198.51.100.1' })).status, 200)
})

test('dashboard: LoginLimiter يفك القفل بعد انتهاء النافذة', () => {
  let t = 1_000_000
  const l = new LoginLimiter(() => t)
  for (let i = 0; i < LOCK_MAX_PER_IP; i++) l.fail('ip')
  assert.ok(l.lockedFor('ip') > 0)
  t += LOCK_WINDOW_MS + 1
  assert.equal(l.lockedFor('ip'), 0)
})

test('dashboard: overview بالشكل الكامل', async () => {
  await store.addUsage({ ts: new Date(), provider: 'gemini', model: 'gemini-3.8-flash', purpose: 'understand', input_tokens: 1200, output_tokens: 300, audio_seconds: 12, latency_ms: 500, ok: true, est_list_usd: 0.002, est_cost_usd: 0 })
  await store.addTask({ title: 'متأخرة', due_at: new Date(Date.now() - 3600_000) })
  await store.addTurn('user', 'مرحبا')
  await store.addTurn('assistant', 'هلا')
  await store.addJob({ request_id: 'r1', project: 'C:/whatsappSiraj', repo: 'example-user/whatsapp-siraj', default_branch: 'main', request: 'زر', dispatched_at: new Date() })
  const { status, body: d } = await call('GET', '/api/dash/overview')
  assert.equal(status, 200)
  assert.equal(d.bot.commit, 'abcdef1234567')
  assert.equal(d.bot.built_at, '2026-09-29T01:00:00Z')
  assert.equal(typeof d.bot.uptime_s, 'number')
  assert.deepEqual(d.channels, { whatsapp: { status: 'connected', banned: false, reason: null, down_since: null }, telegram: { bound: true } })
  assert.equal(d.send_mode, 'link')
  assert.deepEqual(Object.keys(d.usage.today).sort(), ['audio_seconds', 'est_cost_usd', 'input_tokens', 'llm_calls', 'output_tokens'])
  assert.equal(d.usage.today.llm_calls, 1)
  assert.equal(d.usage.today.input_tokens, 1200)
  assert.equal(d.usage.month.llm_calls, 1)
  assert.equal(d.usage.daily.length, 30)
  assert.equal(d.usage.daily.at(-1).llm_calls, 1)
  assert.match(d.usage.daily[0].date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(d.usage.quota_calls, 250)
  assert.equal(d.tasks.open, 1)
  assert.equal(d.tasks.overdue, 1)
  assert.equal(d.tasks.created_7d, 1)
  assert.equal(d.tasks.daily.length, 14)
  assert.deepEqual(d.messages, { in_today: 1, out_today: 1, links_7d: 0 })
  assert.deepEqual(d.code_jobs, { running: 1, awaiting_merge: 0, merged_30d: 0, failed_30d: 0 })
})

test('dashboard: المهام — إضافة، بحث، إنجاز، تصفية، حذف', async () => {
  const c = await call('POST', '/api/dash/tasks', { title: 'الاتصال بالمحاسب', notes: 'فاتورة سبتمبر', due_at: new Date(Date.now() + 86_400_000).toISOString(), remind_at: null, priority: 'high' })
  assert.equal(c.status, 201)
  assert.equal(c.body.status, 'open')
  assert.equal(c.body.source, 'dashboard')
  assert.equal((await call('POST', '/api/dash/tasks', { title: '' })).status, 400)
  const found = await call('GET', '/api/dash/tasks?status=open&q=' + encodeURIComponent('فاتورة'))
  assert.deepEqual(found.body.items.map((t: any) => t.id), [c.body.id])
  assert.equal((await call('GET', '/api/dash/tasks?status=overdue')).body.items.length, 1)
  const done = await call('PATCH', `/api/dash/tasks/${c.body.id}`, { status: 'done' })
  assert.equal(done.body.status, 'done')
  assert.ok(done.body.done_at)
  assert.ok((await call('GET', '/api/dash/tasks?status=done')).body.items.some((t: any) => t.id === c.body.id))
  assert.ok(!(await call('GET', '/api/dash/tasks?status=open')).body.items.some((t: any) => t.id === c.body.id))
  const edited = await call('PATCH', `/api/dash/tasks/${c.body.id}`, { title: 'عنوان جديد', status: 'open' })
  assert.equal(edited.body.title, 'عنوان جديد')
  assert.equal(edited.body.done_at, null)
  assert.equal((await call('PATCH', '/api/dash/tasks/99999', { title: 'x' })).status, 404)
  assert.equal((await call('PATCH', `/api/dash/tasks/${c.body.id}`, { hacked: 1 })).status, 400)
  assert.equal((await call('DELETE', `/api/dash/tasks/${c.body.id}`)).status, 200)
  assert.equal((await call('DELETE', `/api/dash/tasks/${c.body.id}`)).status, 404)
  assert.ok((await call('GET', '/api/dash/tasks?status=all')).body.items.length >= 1)
})

test('dashboard: طلبات الكود بالاسم العربي بلا مسارات محلية', async () => {
  const { body } = await call('GET', '/api/dash/jobs')
  const j = body.items.find((x: any) => x.request_id === 'r1')
  assert.equal(j.project, 'واتساب سراج')
  assert.equal(j.status, 'dispatched')
  assert.ok('run_url' in j && 'pr_url' in j && 'dispatched_at' in j && 'deploy_status' in j)
  assert.doesNotMatch(JSON.stringify(body), /C:\//)
})

test('dashboard: جهات الاتصال — أرقام فقط، ألقاب مصفوفة، تكرار الرقم ← 409', async () => {
  const c = await call('POST', '/api/dash/contacts', { name: 'فهد', phone: '+966 50 000 2233', aliases: ['أبو فهد', ' ', 'أبو فهد'] })
  assert.equal(c.status, 201)
  assert.equal(c.body.phone, '966500002233')
  assert.deepEqual(c.body.aliases, ['أبو فهد'])
  assert.equal((await call('POST', '/api/dash/contacts', { name: 'آخر', phone: '966500002233' })).status, 409)
  assert.equal((await call('POST', '/api/dash/contacts', { name: 'خطأ', phone: '0500002233' })).status, 400)
  const p = await call('PATCH', `/api/dash/contacts/${c.body.id}`, { aliases: ['فهد'] })
  assert.deepEqual(p.body.aliases, ['فهد'])
  assert.equal((await call('GET', '/api/dash/contacts')).body.items.length, 1)
  assert.equal((await call('DELETE', `/api/dash/contacts/${c.body.id}`)).status, 200)
  assert.equal((await call('GET', '/api/dash/contacts')).body.items.length, 0)
})

test('dashboard: المشاريع — الاسم، الفرع، النشر التلقائي والنطاق من Railway، بلا مجلدات', async () => {
  const { body } = await call('GET', '/api/dash/projects')
  const wa = body.items.find((p: any) => p.repo === 'example-user/whatsapp-siraj')
  assert.deepEqual(wa, { alias: 'واتساب سراج', aliases: ['واتساب سراج'], repo: 'example-user/whatsapp-siraj', default_branch: 'main', auto_deploy: true, domain: 'wa.example.app' })
  const th = body.items.find((p: any) => p.repo === 'example-user/hudoor')
  assert.equal(th.auto_deploy, false)
  assert.equal(th.default_branch, 'master')
  assert.doesNotMatch(JSON.stringify(body), /C:\/|folder/)
  const r = await call('POST', '/api/dash/projects/reload')
  assert.equal(r.status, 200)
  assert.equal(typeof r.body.count, 'number')
})

test('dashboard: parseSources/joinProjects', () => {
  const infos = parseSources({ projects: { edges: [{ node: { name: 'x', services: { edges: [{ node: { name: 's', serviceInstances: { edges: [{ node: {
    source: { repo: 'O/R' }, domains: { serviceDomains: [{ domain: 'example-r.up.railway.app' }], customDomains: [] }, latestDeployment: { status: 'SUCCESS' },
  } }] } } }] } } }] } })
  assert.deepEqual(infos, [{ project: 'x', repo: 'O/R', domain: 'example-r.up.railway.app', deployed: true }])
  const [p] = joinProjects([{ folder: 'f', repo: 'o/r', default_branch: 'main', aliases: [], railway_project: null }], infos)
  assert.equal(p.auto_deploy, true)
  assert.equal(p.alias, 'r')
})

test('dashboard: المحادثات — owner|bot والقناة', async () => {
  const { body } = await call('GET', '/api/dash/conversations?limit=50')
  assert.deepEqual(body.items.map((m: any) => m.role), ['bot', 'owner'])
  assert.ok(body.items.every((m: any) => 'channel' in m && m.created_at))
})

test('dashboard: الإعدادات — ذهاب وإياب + getSetting + التحقق', async () => {
  const g = await call('GET', '/api/dash/settings')
  for (const k of ['voice', 'reminders', 'briefs', 'youtube', 'third_party_replies', 'code_changes', 'web_research', 'ai_news_digest']) assert.equal(typeof g.body.features[k], 'boolean', k)
  for (const k of ['morning_brief_at', 'evening_review_at', 'ai_news_at', 'send_mode', 'owner_signature', 'llm_model', 'llm_fallback_model']) assert.ok(k in g.body, k)
  const put = await call('PUT', '/api/dash/settings', { features: { youtube: false, ai_news_digest: true }, morning_brief_at: '06:45', ai_news_at: '09:15', owner_signature: '— ن' })
  assert.equal(put.status, 200)
  assert.equal(put.body.features.youtube, false)
  assert.equal(put.body.features.voice, true)
  assert.equal(getSetting('morning_brief_at'), '06:45')
  assert.equal(getSetting('features')?.ai_news_digest, true)
  // محفوظ في kv ويُعاد تحميله
  const fresh = new Settings(cfg, store)
  await fresh.load()
  assert.equal(fresh.get().ai_news_at, '09:15')
  assert.equal(fresh.get().features.youtube, false)
  assert.equal((await call('GET', '/api/dash/settings')).body.owner_signature, '— ن')
  assert.equal((await call('PUT', '/api/dash/settings', { morning_brief_at: '25:00' })).status, 400)
  assert.equal((await call('PUT', '/api/dash/settings', { send_mode: 'direct' })).status, 400)
  assert.equal((await call('PUT', '/api/dash/settings', { send_mode: 'direct', confirm_direct: true })).body.send_mode, 'direct')
  await call('PUT', '/api/dash/settings', { send_mode: 'link' })
})

test('GET /api/dash/models returns roles, capabilities and key status', async () => {
  const r = await call('GET', '/api/dash/models')
  assert.equal(r.status, 200)
  assert.ok(r.body.roles.includes('voice'))
  assert.ok(r.body.providers.includes('anthropic'))
  assert.deepEqual(r.body.caps.anthropic, ['text', 'vision'])
  assert.equal(r.body.needs.voice, 'audio')
  assert.equal(r.body.status[0].hasKey, false)
  assert.equal(r.body.status[0].fallbackHasKey, true)
  // بلا جلسة ← 401
  assert.equal((await call('GET', '/api/dash/models', undefined, {})).status, 401)
})

test('PUT /api/dash/settings rejects voice → anthropic with 400', async () => {
  const orig = settings.get().models
  const r = await call('PUT', '/api/dash/settings', { models: { voice: { provider: 'anthropic', model: 'claude-opus-5-5' } } })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /voice/)
  const ok = await call('PUT', '/api/dash/settings', { models: { understand: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } } } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.models.understand.provider, 'anthropic')
  assert.equal(ok.body.models.voice.provider, 'gemini')
  // حصة اللوحة تتبع نماذج Gemini الفعلية في الفهم/العام (لا llm_model القديم)
  const lite = await call('PUT', '/api/dash/settings', { models: { understand: { provider: 'openai', model: 'gpt-x' }, general: { provider: 'gemini', model: 'gemini-3.5-flash-lite' } } })
  assert.equal(lite.status, 200)
  assert.equal((await call('GET', '/api/dash/overview')).body.usage.quota_calls, 1000)
  // إرجاع الإعدادات حتى لا يتسرّب understand=anthropic لبقية الاختبارات
  const back = await call('PUT', '/api/dash/settings', { models: orig })
  assert.equal(back.status, 200)
  assert.deepEqual(settings.get().models, orig)
})

test('dashboard: ملف المعرفة — قراءة، حفظ، حد 30KB', async () => {
  const g = await call('GET', '/api/dash/knowledge')
  assert.match(g.body.markdown, /وليد/)
  const p = await call('PUT', '/api/dash/knowledge', { markdown: '# جديد' })
  assert.equal(p.status, 200)
  assert.ok(p.body.updated_at)
  assert.equal(await store.getKv('knowledge_md'), '# جديد')
  assert.equal((await call('GET', '/api/dash/knowledge')).body.updated_at, p.body.updated_at)
  assert.equal((await call('PUT', '/api/dash/knowledge', { markdown: 'x'.repeat(30 * 1024 + 1) })).status, 413)
  assert.equal((await call('PUT', '/api/dash/knowledge', { markdown: '   ' })).status, 400)
  // CRLF (ويندوز) يُحفظ \n — المحرر يقارن بنص موحّد فلا «تعديلات غير محفوظة» زائفة
  const crlf = await call('PUT', '/api/dash/knowledge', { markdown: '# جديد\r\n- سطر\r\n' })
  assert.equal(crlf.status, 200)
  assert.equal(crlf.body.markdown, '# جديد\n- سطر\n')
  assert.equal(await store.getKv('knowledge_md'), '# جديد\n- سطر\n')
  assert.equal((await call('PUT', '/api/dash/knowledge', { markdown: '\r\n\r\n' })).status, 400)
})

test('dashboard: إعادة المقابلة — 401 بلا جلسة، و200 يصفّر الحالة دون لمس ملف المعرفة', async () => {
  assert.equal((await call('POST', '/api/dash/onboarding/restart', {}, { 'x-requested-with': 'dash' })).status, 401)
  await store.setKv('onboarding_state', JSON.stringify({ status: 'done', index: 8, answers: { who: 'مدير قانوني' }, startedAt: '2026-10-01T00:00:00Z' }))
  const before = await store.getKv('knowledge_md')
  const r = await call('POST', '/api/dash/onboarding/restart', {})
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { ok: true })
  const s = JSON.parse((await store.getKv('onboarding_state'))!)
  assert.equal(s.status, 'stopped')
  assert.equal(s.index, 0)
  assert.deepEqual(s.answers, {})
  assert.equal(await store.getKv('knowledge_md'), before)
})

test('dashboard: واتساب — QR وإعادة الربط، ويرفض إن كان محظوراً', async () => {
  snap.status = 'qr'
  const q = await call('GET', '/api/dash/wa/qr')
  assert.deepEqual(q.body, { status: 'qr', qr_png_base64: Buffer.from('PNGDATA').toString('base64') })
  assert.equal((await call('POST', '/api/dash/wa/relink')).status, 200)
  assert.equal(relinks, 1)
  snap.banned = true
  const r = await call('POST', '/api/dash/wa/relink')
  assert.equal(r.status, 409)
  assert.match(r.body.error, /محظور/)
  assert.equal(relinks, 1)
  assert.equal((await call('GET', '/api/dash/overview')).body.channels.whatsapp.banned, true)
  snap.banned = false; snap.status = 'connected'
  assert.equal((await call('GET', '/api/dash/wa/qr')).body.status, 'connected')
})

test('dashboard: الخروج يبطل الجلسة', async () => {
  const r = await call('POST', '/api/dash/logout')
  assert.equal(r.status, 200)
  assert.match(String(r.headers['set-cookie']), /Max-Age=0/)
  assert.equal((await call('GET', '/api/dash/overview')).status, 401)
})
