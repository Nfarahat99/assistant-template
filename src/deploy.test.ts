/**
 * Railway: قراءة الحالة، والتحقق من النشر بعد الدمج (نجاح، فشل بسجل، غير مربوط، عدة خدمات، مهلة)، وإعادة النشر بـ"نعم N".
 */
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects } from './projects.js'
import { httpRailway, errorLines, type RailwayClient, type RwService, type RwDeployment } from './clients/railway.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

// ───── عميل GraphQL الحقيقي على fetch مزيّف ─────
const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

test('httpRailway: يقرأ الخدمات من البيئة الأساسية، commitHash من meta، والتوكن لا يظهر في الأخطاء', async () => {
  const bodies: any[] = []
  globalThis.fetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body))
    assert.equal(init.headers.Authorization, 'Bearer SECRET-TOKEN')
    return new Response(JSON.stringify({ data: { projects: { edges: [{ node: {
      id: 'p1', name: 'waqti', primaryEnvironmentId: 'env-prod',
      environments: { edges: [
        { node: { id: 'env-pr', name: 'pr-12', serviceInstances: { edges: [{ node: { serviceId: 'x', serviceName: 'pr' } }] } } },
        { node: { id: 'env-prod', name: 'production', serviceInstances: { edges: [
          { node: { serviceId: 's-web', serviceName: 'web', environmentId: 'env-prod', source: { repo: 'example-user/waqti', image: null },
            latestDeployment: { id: 'd1', status: 'SUCCESS', createdAt: '2026-10-20T08:00:00Z', meta: { commitHash: 'abc123', commitMessage: 'feat: x' }, staticUrl: 'example-web.up.railway.app' },
            domains: { serviceDomains: [{ domain: 'example-web.up.railway.app' }], customDomains: [{ domain: 'waqti.example' }] } } },
          { node: { serviceId: 's-db', serviceName: 'Postgres', environmentId: 'env-prod', source: { repo: null, image: 'postgres:16' }, latestDeployment: null, domains: { serviceDomains: [], customDomains: [] } } },
        ] } } },
      ] },
    } }] } } }), { status: 200 })
  }) as any
  const rw = httpRailway('SECRET-TOKEN')
  const list = await rw.listServices()
  assert.equal(list.length, 2, 'بيئة PR مستبعدة')
  assert.equal(list[0].repo, 'example-user/waqti')
  assert.equal(list[0].latest!.commitHash, 'abc123')
  assert.deepEqual(list[0].domains, ['waqti.example', 'example-web.up.railway.app'])
  assert.match(bodies[0].query, /projects\(first: 100/)

  globalThis.fetch = (async () => new Response(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }), { status: 200 })) as any
  await assert.rejects(rw.listServices(), (e: any) => /Railway: Not Authorized/.test(e.message) && !e.message.includes('SECRET-TOKEN'))
})

test('errorLines: سطور الأخطاء فقط، آخر ١٥، بلا ألوان ANSI', () => {
  const logs = [
    { message: 'npm install', severity: 'info', timestamp: null },
    { message: '\u001b[31mnpm ERR! code ELIFECYCLE\u001b[0m', severity: 'info', timestamp: null },
    { message: 'Error: Cannot find module "zod"', severity: 'error', timestamp: null },
    { message: 'done', severity: 'info', timestamp: null },
  ]
  assert.deepEqual(errorLines(logs), ['npm ERR! code ELIFECYCLE', 'Error: Cannot find module "zod"'])
})

// ───── التكامل ─────
let clock = new Date('2026-10-20T08:00:00Z')
let services: RwService[] = []
const deployments: Record<string, RwDeployment[]> = {}
const redeployed: string[] = []
const railway: RailwayClient = {
  async listServices() { return services },
  async deployments(serviceId) { return deployments[serviceId] ?? [] },
  async logs(_id, kind) {
    return kind === 'build'
      ? [{ message: 'Installing deps', severity: 'info', timestamp: null }, { message: 'Error: Cannot find module "zod"', severity: 'error', timestamp: null }]
      : []
  },
  async redeploy(serviceId) { redeployed.push(serviceId) },
  async projects() { return [] }, async details() { return [] }, async findTargets() { return [] },
}
const svc = (id: string, name: string, repo: string | null, project = 'waqti', domain: string | null = `example-${id}.up.railway.app`): RwService => ({
  projectId: 'p', projectName: project, serviceId: id, serviceName: name, environmentId: 'env', environmentName: 'production',
  repo, image: null, latest: { id: `${id}-old`, status: 'SUCCESS', createdAt: clock.toISOString(), commitHash: 'old', commitMessage: null, url: null },
  domains: domain ? [domain] : [],
})
const dep = (id: string, status: RwDeployment['status'], sha: string): RwDeployment => ({ id, status, createdAt: clock.toISOString(), commitHash: sha, commitMessage: null, url: null })

const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}
let prState: any = null
let mergeShaSeq = 0
const github: GitHubClient = {
  async dispatchWorkflow() {}, async listRuns() { return [] },
  async findPrByBranch() { return prState },
  async getPr() { return prState },
  async prFiles() { return [{ filename: 'a.ts', additions: 1, deletions: 0 }] },
  async mergePr() { return { sha: `merge${++mergeShaSeq}sha` } }, async closePr() {}, async deleteBranch() {}, async getFileContent() { return '[]' },
}
const script: Record<string, any> = {}
const llm: LlmClient = {
  async complete(_s, user) {
    const msg = user.split('رسالة وليد الجديدة:\n')[1].trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: '?' }], reply: '' })
  },
}
let db: Db, store: Store, a: Assistant
const healthHits: string[] = []
let seq = 0
const say = async (text: string) => {
  clock = new Date(clock.getTime() + 2_000)
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `W${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await a.idle()
}
const openNo = async (kind: string) => (await store.openPending(clock)).filter((p) => p.kind === kind).at(-1)!.short_no

/** يمرّر طلب كود حتى الدمج ويرجع sha الدمج */
async function mergeFlow(project: string, repo: string): Promise<string> {
  const text = `عدل في ${project}: تحسين`
  script[text] = { actions: [{ type: 'code_change', project_query: project, request: 'تحسين' }], reply: '' }
  await say(text)
  await say(`نعم ${await openNo('code_change')}`)
  prState = { number: 3, html_url: `https://github.com/${repo}/pull/3`, title: 'تحسين', body: '', state: 'open', head: { sha: 'h1', ref: 'x' }, base: { ref: 'main' } }
  await a.pollJobs()
  await say(`نعم ${await openNo('merge_pr')}`)
  return `merge${mergeShaSeq}sha`
}
const poll = async (advanceMs: number) => { clock = new Date(clock.getTime() + advanceMs); await a.pollDeploys(); await a.idle() }

before(async () => {
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  const projects = new ProjectRegistry(parseProjects(JSON.stringify([
    { folder: 'C:/planners', repo: 'example-user/waqti', default_branch: 'main', aliases: ['جداول سراج'], railway_project: 'waqti' },
    { folder: 'C:/hudoor', repo: 'example-user/hudoor', default_branch: 'main', aliases: ['تحضير سراج'], railway_project: 'hudoor-attendance' },
    { folder: 'C:/x', repo: 'example-user/ghost', default_branch: 'main', aliases: ['مشروع شبح'] },
  ])))
  a = new Assistant({ cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects, now: () => clock, railway,
    httpGet: async (url) => { healthHits.push(url); return url.endsWith('/health') ? 200 : 200 } })
})
after(async () => { await db.close() })
beforeEach(() => { sent.length = 0; healthHits.length = 0 })

test('بعد الدمج (عدة خدمات): 🚀 بدأ ← ✅ نجح لكل خدمة + فحص صحة، والحالة في "طلباتي"', async () => {
  services = [svc('s-web', 'web', 'example-user/waqti'), svc('s-solver', 'solver', 'example-user/waqti', 'waqti', null)]
  const sha = await mergeFlow('جداول سراج', 'example-user/waqti')
  assert.match(sent.at(-1)!, new RegExp(`✅ دمجته في جداول سراج \\(commit ${sha.slice(0, 7)}\\) — أتابع النشر على Railway`))

  deployments['s-web'] = [dep('d-web', 'BUILDING', sha)]
  deployments['s-solver'] = [dep('d-sol', 'QUEUED', sha)]
  await poll(20_000)
  assert.ok(sent.includes('🚀 بدأ النشر على web (جداول سراج)…'))
  assert.ok(sent.includes('🚀 بدأ النشر على solver (جداول سراج)…'))
  const n = sent.length
  await poll(20_000)
  assert.equal(sent.length, n, 'لا تكرار لرسالة البدء')

  deployments['s-web'] = [dep('d-web', 'SUCCESS', sha)]
  deployments['s-solver'] = [dep('d-sol', 'SUCCESS', sha)]
  for (const s of services) s.latest = dep(`d-${s.serviceId}`, 'SUCCESS', sha)
  await poll(20_000)
  assert.ok(sent.some((m) => m === '✅ انتشر بنجاح على web (example-s-web.up.railway.app) — الفحص: /health 200 ✅'))
  assert.ok(sent.some((m) => m.startsWith('✅ انتشر بنجاح على solver')))
  assert.deepEqual(healthHits, ['https://example-s-web.up.railway.app/health'])

  await poll(20_000)
  assert.equal(sent.filter((m) => m.startsWith('✅ انتشر')).length, 2, 'لا تكرار بعد النجاح')
  await say('طلباتي')
  assert.match(sent.at(-1)!, /النشر: ✅ انتشر https:\/\/example-s-web\.up\.railway\.app/)
  await say('هل انتشر آخر دمج؟')
  assert.match(sent.at(-1)!, /web: ✅ شغّال — هذا هو آخر دمج/)
})

test('فشل النشر: سطور الأخطاء + "النسخة القديمة لسا شغالة" + إعادة المحاولة بـ"نعم N" فقط', async () => {
  services = [svc('s-web', 'web', 'example-user/waqti')]
  const sha = await mergeFlow('جداول سراج', 'example-user/waqti')
  deployments['s-web'] = [dep('d-fail', 'FAILED', sha)]
  await poll(20_000)
  const msg = sent.find((m) => m.startsWith('❌ فشل النشر على web'))!
  assert.match(msg, /النسخة القديمة لسا شغالة/)
  assert.match(msg, /Error: Cannot find module "zod"/)
  assert.doesNotMatch(msg, /Installing deps/, 'سطور عادية ظهرت')
  const no = await openNo('railway_redeploy')
  assert.match(msg, /أعد المحاولة؟\n\[\d+\] 🚂 جهزت إعادة نشر \(ما نفّذتها بعد\): waqti \/ web \(production\)/)
  assert.ok(msg.includes(`أنفّذها؟ رد: نعم ${no}`))

  for (const w of ['تمام', 'يلا']) { await say(w); assert.deepEqual(redeployed, [], `"${w}" أعاد النشر`) }
  await say(`نعم ${no}`)
  assert.deepEqual(redeployed, ['s-web'])
  assert.match(sent.at(-1)!, /🔁 أعدت نشر waqti \/ web — أتابع النتيجة/)

  // المتابعة تُستأنف: النشر الجديد بنفس الـ commit نجح
  deployments['s-web'] = [dep('d-retry', 'SUCCESS', sha), dep('d-fail', 'FAILED', sha)]
  await poll(20_000)
  assert.ok(sent.some((m) => m.startsWith('✅ انتشر بنجاح على web')))
})

test('غير مربوط بـ GitHub (رفع يدوي): "ما ينشر تلقائياً"، وبلا خدمة إطلاقاً: رسالة واضحة', async () => {
  services = [svc('s-att', 'attendance', null, 'hudoor-attendance')]
  await mergeFlow('تحضير سراج', 'example-user/hudoor')
  await poll(20_000)
  assert.match(sent.at(-1)!, /⚠️ تحضير سراج ما ينشر تلقائياً \(الخدمة attendance على Railway مرفوعة يدوياً\) — الدمج تم في GitHub بس الموقع ما تغير/)
  const n = sent.length
  await poll(20_000)
  assert.equal(sent.length, n, 'يُبلَّغ مرة واحدة')

  services = []
  await mergeFlow('مشروع شبح', 'example-user/ghost')
  await poll(20_000)
  assert.match(sent.at(-1)!, /ما لقيت خدمة على Railway مربوطة بـ example-user\/ghost/)
})

test('مهلة: لا نشر خلال ٣ دقائق ← تنبيه، و٢٠ دقيقة ← انتهت المتابعة', async () => {
  services = [svc('s-web', 'web', 'example-user/waqti')]
  deployments['s-web'] = [dep('d-other', 'SUCCESS', 'someoldsha')]
  await mergeFlow('جداول سراج', 'example-user/waqti')
  await poll(60_000)
  assert.ok(!sent.some((m) => m.includes('مرّت ٣ دقايق')))
  await poll(3 * 60_000)
  assert.ok(sent.some((m) => m.startsWith('⚠️ مرّت ٣ دقايق وما بدأ نشر لـ web (جداول سراج)')))
  await poll(17 * 60_000)
  assert.ok(sent.some((m) => m.startsWith('⌛ نشر جداول سراج طوّل أكثر من ٢٠ دقيقة')))
  const n = sent.length
  await poll(60_000)
  assert.equal(sent.length, n, 'توقفت المتابعة')
})

test('"حالة ريلوي" و"لوقات": قراءة فقط، والنشر التلقائي نعم/لا', async () => {
  services = [svc('s-web', 'web', 'example-user/waqti'), svc('s-att', 'attendance', null, 'hudoor-attendance')]
  await say('حالة ريلوي')
  const m = sent.at(-1)!
  assert.match(m, /📦 waqti\n• web — ✅ شغّال/)
  assert.match(m, /نشر تلقائي: نعم \(example-user\/waqti\)/)
  assert.match(m, /نشر تلقائي: لا \(رفع يدوي\)/)
  await say('لوقات جداول سراج')
  assert.match(sent.at(-1)!, /🚂 جداول سراج على Railway/)
  assert.doesNotMatch(sent.at(-1)!, /📜/)
})

test('حالة ريلوي بالاسم العربي: "تحضير سراج" ← اسم مشروع Railway من قائمة المشاريع', async () => {
  const asked: (string | undefined)[] = []
  const origDetails = railway.details, origProjects = railway.projects
  railway.details = async (q) => { asked.push(`details:${q}`); return [] }
  railway.projects = async (q) => { asked.push(q); return [] }
  try {
    script['شيك تحضير سراج'] = { actions: [{ type: 'railway_status', project_query: 'تحضير سراج', detail: 'details' }], reply: '' }
    await say('شيك تحضير سراج')
    for (let i = 0; i < 50 && !asked.length; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(asked, ['hudoor-attendance'])
  } finally { railway.details = origDetails; railway.projects = origProjects }
})
