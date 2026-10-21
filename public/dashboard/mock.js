// In-memory mock backend for demos: open the dashboard with ?mock=1 (add &loggedout=1 to see login).
// Password in mock mode: anything non-empty except "wrong".
import { ApiError } from './api.js'
import { handleWaLink } from './mock-wa-link.js'

const qs = new URLSearchParams(location.search)
let loggedIn = !qs.has('loggedout')
const NOW = Date.now(), H = 3600e3, D = 24 * H
const iso = (ms) => new Date(ms).toISOString()
const ago = (ms) => iso(NOW - ms), ahead = (ms) => iso(NOW + ms)
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const ymd = (ms) => new Date(ms + 3 * H).toISOString().slice(0, 10)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let nextId = 100

let tasks = [
  { id: 1, title: 'مراجعة عرض «شركة المثال» للعميل التجريبي', notes: 'إضافة شعار العميل في شريحة العملاء وتحديث أرقام 2026', due_at: ahead(5 * H), remind_at: ahead(4 * H), priority: 'high', status: 'open', created_at: ago(2 * D), done_at: null },
  { id: 2, title: 'الرد على أحمد بخصوص الطلب التجريبي', notes: 'قسم الجودة — يحتاج نسخة من الشهادة', due_at: ago(20 * H), remind_at: null, priority: 'high', status: 'open', created_at: ago(3 * D), done_at: null },
  { id: 3, title: 'تجديد استمارة السيارة', notes: '', due_at: ago(2 * D), remind_at: null, priority: 'normal', status: 'open', created_at: ago(9 * D), done_at: null },
  { id: 4, title: 'حجز موعد أسنان للوالدة', notes: 'عيادة المثال — الفترة المسائية', due_at: ahead(2 * D), remind_at: ahead(D + 10 * H), priority: 'normal', status: 'open', created_at: ago(D), done_at: null },
  { id: 5, title: 'دفع فاتورة الإنترنت', notes: null, due_at: ahead(6 * D), remind_at: ahead(5 * D), priority: 'low', status: 'open', created_at: ago(4 * H), done_at: null },
  { id: 6, title: 'تجهيز جدول المناوبات للأسبوع القادم', notes: 'مراجعة الإجازات قبل النشر', due_at: ahead(3 * D), remind_at: null, priority: 'normal', status: 'open', created_at: ago(6 * H), done_at: null },
  { id: 7, title: 'شراء هدية لتخرّج سالم', notes: '', due_at: null, remind_at: null, priority: 'normal', status: 'open', created_at: ago(5 * D), done_at: null },
  { id: 8, title: 'إرسال الفاتورة لشركة المثال', notes: 'فاتورة سبتمبر', due_at: ago(3 * D), remind_at: null, priority: 'normal', status: 'done', created_at: ago(6 * D), done_at: ago(3 * D + 2 * H) },
  { id: 9, title: 'متابعة مراجعة الفيديو التجريبي', notes: 'الخط Tajawal والتعليقات', due_at: null, remind_at: null, priority: 'low', status: 'done', created_at: ago(8 * D), done_at: ago(D) },
  { id: 10, title: 'تحويل إيجار الشقة', notes: '', due_at: ago(4 * D), remind_at: null, priority: 'high', status: 'done', created_at: ago(12 * D), done_at: ago(4 * D) },
]
let contacts = [
  { id: 1, name: 'أحمد المثال', phone: '966500000001', aliases: ['أحمد', 'أبو سالم'] },
  { id: 2, name: 'الوالدة', phone: '966500000002', aliases: ['أمي', 'ماما'] },
  { id: 3, name: 'سالم المثال', phone: '966500000003', aliases: ['أبو سالم', 'سالم'] },
  { id: 4, name: 'م. فهد التجريبي', phone: '966500000004', aliases: ['فهد'] },
  { id: 5, name: 'مكتب المحاسبة — أحمد', phone: '966500000005', aliases: ['المحاسب', 'أحمد'] },
  { id: 6, name: 'د. سارة المثال', phone: '966500000006', aliases: ['سارة'] },
]
const REPO = [['البوابة', 'sample-gateway', ['واتساب', 'الوسيط'], true], ['الحضور', 'sample-attendance', ['تحضير'], true], ['الجداول', 'sample-schedules', ['المناوبات'], false],
  ['المنصة', 'sample-hub', ['الهب'], true], ['المساعد', 'sample-assistant', ['البوت'], true], ['النقل', 'sample-transfer', [], false], ['الموقع', 'sample-site', ['موقعي'], true],
  ['الفواتير', 'invoices-app', [], false], ['الأدوات', 'sample-tools', [], false], ['الفيديو', 'sample-video-studio', [], false]]
const extra = ['crm-lite', 'expense-tracker', 'clinic-booking', 'quran-timer', 'inventory', 'hr-portal', 'landing-kit', 'fleet', 'school-bus', 'menu-qr', 'survey', 'events', 'tickets', 'real-estate', 'gym', 'library', 'pharmacy', 'mosque-times', 'charity', 'donations', 'freelance', 'shop', 'blog', 'portfolio', 'api-gateway', 'scraper', 'reports', 'ocr-tool', 'translator']
let projects = [...REPO.map(([a, r, al, ad]) => ({ alias: a, aliases: al, repo: `demo-user/${r}`, default_branch: 'main', auto_deploy: ad })),
  ...extra.map((r, i) => ({ alias: r.replace(/-/g, ' '), aliases: [], repo: `demo-user/${r}`, default_branch: i % 5 ? 'main' : 'master', auto_deploy: i % 3 === 0 }))]
const jobs = [
  { request_id: 'a91f2c3e', project: 'البوابة', repo: 'demo-user/sample-gateway', request: 'أضف مراقبة لحالة الاتصال وأرسل تنبيه على تيليجرام عند الانقطاع', status: 'running', run_url: 'https://github.com/demo-user/sample-gateway/actions/runs/1', pr_url: null, dispatched_at: ago(6 * 60e3), updated_at: ago(60e3) },
  { request_id: 'b22d8e10', project: 'الجداول', repo: 'demo-user/sample-schedules', request: 'زر تصدير الجدول الأسبوعي PDF بالعربي', status: 'awaiting_merge', run_url: 'https://github.com/demo-user/sample-schedules/actions/runs/2', pr_url: 'https://github.com/demo-user/sample-schedules/pull/41', dispatched_at: ago(3 * H), updated_at: ago(2 * H) },
  { request_id: 'c7e1a004', project: 'المنصة', repo: 'demo-user/sample-hub', request: 'تحديث صفحة الهبوط بشعار الشريك التجريبي', status: 'merged', run_url: 'https://github.com/demo-user/sample-hub/actions/runs/3', pr_url: 'https://github.com/demo-user/sample-hub/pull/12', dispatched_at: ago(D + 4 * H), updated_at: ago(D) },
  { request_id: 'd019bb72', project: 'الحضور', repo: 'demo-user/sample-attendance', request: 'إصلاح خطأ التاريخ في تقرير الحضور', status: 'failed', run_url: 'https://github.com/demo-user/sample-attendance/actions/runs/4', pr_url: null, dispatched_at: ago(2 * D), updated_at: ago(2 * D - 20 * 60e3) },
  { request_id: 'e5520c19', project: 'الموقع', repo: 'demo-user/sample-site', request: 'أضف قسم «أعمالي» مع ثلاث بطاقات', status: 'merged', run_url: 'https://github.com/demo-user/sample-site/actions/runs/5', pr_url: 'https://github.com/demo-user/sample-site/pull/8', dispatched_at: ago(4 * D), updated_at: ago(4 * D - 2 * H) },
  { request_id: 'f3a8d6e2', project: 'المساعد', repo: 'demo-user/sample-assistant', request: 'لوحة تحكم للمالك', status: 'no_changes', run_url: 'https://github.com/demo-user/sample-assistant/actions/runs/6', pr_url: null, dispatched_at: ago(6 * D), updated_at: ago(6 * D) },
]
const convo = [
  ['owner', 'ذكرني بكرة الساعة 9 أراجع العرض التجريبي', 'telegram', 26 * H], ['bot', 'تم ✅ أضفت مهمة «مراجعة العرض التجريبي» مع تذكير غداً 9:00 ص.', 'telegram', 26 * H - 5e3],
  ['owner', '[رسالة صوتية 0:14] قول لأبو سالم إني بتأخر نص ساعة', 'telegram', 5 * H], ['bot', 'جهّزت الرسالة لسالم المثال:\n«هلا أبو سالم، بتأخر نص ساعة إن شاء الله — المالك»\nhttps://wa.me/966500000003?text=…', 'telegram', 5 * H - 8e3],
  ['owner', 'في مشروع الجداول ضيف زر تصدير PDF', 'telegram', 3 * H], ['bot', 'أرسلت الطلب لمشروع «الجداول» (demo-user/sample-schedules). سأبلغك عند فتح طلب الدمج.', 'telegram', 3 * H - 6e3],
  ['bot', 'طلب الدمج #41 جاهز في «الجداول»: زر تصدير PDF. رد بـ «موافق» للدمج.', 'telegram', 2 * H],
  ['owner', 'لخص لي https://youtu.be/xyz', 'telegram', 40 * 60e3], ['bot', 'ملخّص الفيديو (12 دقيقة):\n• الفكرة الرئيسية: إدارة الوقت بالكتل الزمنية\n• 3 نصائح عملية…', 'telegram', 39 * 60e3],
  ['owner', 'وش عندي اليوم؟', 'telegram', 10 * 60e3], ['bot', 'عندك 6 مهام مفتوحة، 2 منها متأخرة:\n1. الرد على أحمد (متأخرة)\n2. تجديد استمارة السيارة (متأخرة)\n3. مراجعة العرض التجريبي — 5 م', 'telegram', 9 * 60e3],
].map(([role, text, channel, a], i) => ({ id: i + 1, role, text, channel, created_at: ago(a) }))
const gem = (model, fb = 'gemini-3.5-flash-lite') => ({ provider: 'gemini', model, ...(fb ? { fallback: { provider: 'gemini', model: fb } } : {}) })
let settings = {
  features: { voice: true, reminders: true, briefs: true, youtube: true, third_party_replies: false, code_changes: true }, morning_brief_at: '07:30', evening_review_at: '21:00', send_mode: 'link', owner_signature: '— المالك', llm_model: 'gemini-3.8-flash', llm_fallback_model: 'gemini-3.5-flash-lite',
  // مثال: الفهم على Claude بلا مفتاح (شارة كهرمانية)، والبحث بلا احتياطي
  models: {
    understand: { provider: 'anthropic', model: 'claude-opus-5-5', fallback: { provider: 'gemini', model: 'gemini-3.8-flash' } },
    general: gem('gemini-3.8-flash'), voice: gem('gemini-3.5-flash-lite', null), vision: gem('gemini-3.8-flash'), video: gem('gemini-3.8-flash'), research: gem('gemini-3.8-flash', null),
  },
}
// GET /api/dash/models — نفس شكل الخادم؛ المفاتيح التجريبية: Gemini وGroq فقط
const MODELS_META = {
  roles: ['understand', 'general', 'voice', 'vision', 'video', 'research'],
  providers: ['gemini', 'groq', 'nvidia', 'anthropic', 'openai'],
  caps: { gemini: ['text', 'audio', 'vision', 'video', 'search'], groq: ['text', 'audio'], nvidia: ['text'], anthropic: ['text', 'vision'], openai: ['text'] },
  needs: { understand: 'text', general: 'text', voice: 'audio', vision: 'vision', video: 'video', research: 'search' },
}
const MOCK_KEYS = { gemini: true, groq: true, nvidia: false, anthropic: false, openai: false }
const mockKeyStatus = () => MODELS_META.roles.map((role) => {
  const m = settings.models[role]
  return { role, provider: m.provider, hasKey: MOCK_KEYS[m.provider], ...(m.fallback ? { fallbackProvider: m.fallback.provider, fallbackHasKey: MOCK_KEYS[m.fallback.provider] } : {}) }
})
let knowledge = { markdown: `# عن المالك\n- الاسم: المالك التجريبي — الرياض (توقيت +3)\n- القناة الأساسية: تيليجرام (واتساب غير مربوط في هذا العرض)\n\n# الأشخاص\n- **أبو سالم** = سالم المثال، صديق\n- **أحمد المثال**: فريق «شركة المثال» — تحقق من ردوده قبل اعتبار الموضوع بلا رد\n\n# المشاريع\n- «البوابة» = بوابة واتساب (sample-gateway)\n- «الحضور» = sample-attendance، «الجداول» = sample-schedules\n\n# أسلوب الردود\n- عربي مختصر، لهجة سعودية خفيفة\n- لا ترسل شيئاً لأي شخص دون موافقتي\n`, updated_at: ago(3 * D) }
let qrPolls = 0

function overview() {
  const daily = Array.from({ length: 30 }, (_, i) => { const c = Math.round(40 + rnd() * 90 + (i > 22 ? 40 : 0)); return { date: ymd(NOW - (29 - i) * D), llm_calls: c, input_tokens: c * Math.round(1800 + rnd() * 900), output_tokens: c * Math.round(250 + rnd() * 150) } })
  const td = Array.from({ length: 14 }, (_, i) => ({ date: ymd(NOW - (13 - i) * D), created: Math.round(rnd() * 6), done: Math.round(rnd() * 5) }))
  const open = tasks.filter((t) => t.status !== 'done')
  return {
    bot: { version: '1.4.2', commit: '9f3c2a17be', built_at: ago(2 * D + 3 * H), uptime_s: 2 * 86400 + 3 * 3600 + 17 * 60 },
    channels: { whatsapp: { status: 'disconnected', banned: true, reason: 'الرقم غير مربوط (بيانات تجريبية)', down_since: ago(4 * D) }, telegram: { bound: true } },
    send_mode: settings.send_mode,
    usage: { today: { llm_calls: 143, input_tokens: 318400, output_tokens: 41200, audio_seconds: 412, est_cost_usd: 0 }, month: { llm_calls: 3210, input_tokens: 7.1e6, output_tokens: 9.4e5, audio_seconds: 8900, est_cost_usd: 0.84 }, daily },
    tasks: { open: open.length, overdue: open.filter((t) => t.due_at && Date.parse(t.due_at) < NOW).length, done_7d: 9, created_7d: 14, daily: td },
    messages: { in_today: 18, out_today: 21, links_7d: 12 },
    code_jobs: { running: 1, awaiting_merge: 1, merged_30d: 11, failed_30d: 2 },
  }
}
function filterTasks(p) {
  const st = p.get('status') || 'open', q = (p.get('q') || '').trim()
  let r = tasks.filter((t) => st === 'all' || (st === 'done' ? t.status === 'done' : t.status !== 'done' && (st !== 'overdue' || (t.due_at && Date.parse(t.due_at) < Date.now()))))
  if (q) r = r.filter((t) => (t.title + ' ' + (t.notes || '')).includes(q))
  return r.sort((a, b) => (a.status === 'done' ? Date.parse(b.done_at) - Date.parse(a.done_at) : (Date.parse(a.due_at || '2100-01-01') - Date.parse(b.due_at || '2100-01-01'))))
}

export async function handle(method, path, body) {
  await sleep(180 + rnd() * 250)
  const [p, query] = path.split('?'), params = new URLSearchParams(query || '')
  if (p === '/login') { if (body?.password === 'wrong') throw new ApiError(401, 'bad'); loggedIn = true; return { ok: true } }
  if (!loggedIn) throw new ApiError(401, 'انتهت الجلسة')
  if (p.startsWith('/wa/link')) return handleWaLink(method, p, body, fakeQr)
  const [base, id] = p.split('/').filter(Boolean)
  const R = `${method} /${base}${id ? (['reload', 'qr', 'relink'].includes(id) ? '/' + id : '/:id') : ''}`
  switch (R) {
    case 'POST /logout': loggedIn = false; return { ok: true }
    case 'GET /overview': return overview()
    case 'GET /tasks': return { items: filterTasks(params) }
    case 'POST /tasks': { const t = { id: ++nextId, status: 'open', created_at: iso(Date.now()), done_at: null, ...body }; tasks.unshift(t); return t }
    case 'PATCH /tasks/:id': { const t = tasks.find((x) => String(x.id) === id); Object.assign(t, body); if (body.status) t.done_at = body.status === 'done' ? iso(Date.now()) : null; return t }
    case 'DELETE /tasks/:id': tasks = tasks.filter((x) => String(x.id) !== id); return { ok: true }
    case 'GET /jobs': return { items: jobs }
    case 'GET /contacts': return { items: contacts }
    case 'POST /contacts': { if (contacts.some((c) => c.phone === body.phone)) { const e = new ApiError(409, 'هذا الرقم مسجّل لجهة أخرى.'); e.field = 'phone'; throw e } const c = { id: ++nextId, ...body }; contacts.push(c); return c }
    case 'PATCH /contacts/:id': { const c = contacts.find((x) => String(x.id) === id); Object.assign(c, body); return c }
    case 'DELETE /contacts/:id': contacts = contacts.filter((x) => String(x.id) !== id); return { ok: true }
    case 'GET /projects': return { items: projects }
    case 'POST /projects/reload': return { ok: true, count: projects.length }
    case 'GET /conversations': return { items: convo.slice(-(+params.get('limit') || 50)).reverse() }
    case 'GET /settings': return JSON.parse(JSON.stringify(settings))
    case 'GET /models': return JSON.parse(JSON.stringify({ ...MODELS_META, status: mockKeyStatus() }))
    case 'PUT /settings': {
      // نفس قاعدة الخادم: المزوّد (والاحتياطي) يجب أن يدعم قدرة الدور ← 400 باسم الدور
      const bad = Object.entries(body.models || {}).flatMap(([r, m]) => [m, m.fallback].filter(Boolean)
        .filter((t) => !MODELS_META.caps[t.provider]?.includes(MODELS_META.needs[r])).slice(0, 1)
        .map(() => `models.${r}: ${r}: المزوّد ما يدعم ${MODELS_META.needs[r]}`))
      if (bad.length) throw new ApiError(400, bad.join('؛ '))
      const { models, ...rest } = body
      settings = { ...settings, ...rest, features: { ...settings.features, ...(body.features || {}) }, models: { ...settings.models, ...(models || {}) } }
      return JSON.parse(JSON.stringify(settings))
    }
    case 'GET /knowledge': return knowledge
    case 'PUT /knowledge': knowledge = { markdown: body.markdown, updated_at: iso(Date.now()) }; return knowledge
    case 'POST /onboarding/restart': return { ok: true }
    case 'POST /wa/relink': qrPolls = 0; return { ok: true }
    case 'GET /wa/qr': qrPolls++; return { status: 'qr', qr_png_base64: fakeQr() }
  }
  throw new ApiError(404, `مسار غير معروف في البيانات التجريبية: ${method} ${path}`)
}

// Deterministic QR-looking PNG drawn on a canvas (demo only).
function fakeQr() {
  const n = 29, s = 8, c = document.createElement('canvas'); c.width = c.height = n * s
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'
  let r = 99 + qrPolls
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { r = (r * 48271) % 2147483647; if (r % 2) g.fillRect(x * s, y * s, s, s) }
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) { g.fillStyle = '#fff'; g.fillRect(ox * s - s, oy * s - s, 9 * s, 9 * s); g.fillStyle = '#111'; g.fillRect(ox * s, oy * s, 7 * s, 7 * s); g.fillStyle = '#fff'; g.fillRect((ox + 1) * s, (oy + 1) * s, 5 * s, 5 * s); g.fillStyle = '#111'; g.fillRect((ox + 2) * s, (oy + 2) * s, 3 * s, 3 * s) }
  return c.toDataURL('image/png').split(',')[1]
}
