/**
 * تحقيق قبل الإصلاح + سياق غني لطلبات الكود (من حادثة ماجد بازرعة):
 * بلاغ خلل بيانات ← استعلامات قراءة فقط ← "🔎 الأدلة" في المعاينة ← "نعم N" ← برومبت فيه كلام المالك
 * حرفياً وتصحيحاته وأدلته وطلباته السابقة. والأدلة المخالفة ← سؤال واحد بدل الإرسال.
 * والدمج: قسم «## التحقق» يظهر بوضوح، وغيابه ← ⚠️ بدون تحقق (و«نعم N» مطلوبة كالعادة).
 */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { loadConfig } from './config.js'
import { createDb, type Db } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant, type InboundPayload } from './assistant.js'
import { ProjectRegistry, parseProjects } from './projects.js'
import { DatabaseRegistry } from './clients/databases.js'
import { pglitePool } from './test-fixtures.js'
import { investigateSystem, judgeSystem, scopeSystem } from './lib/code-context.js'
import { sqlSystemRead, summarySystem } from './ai/dbsql.js'
import type { GatewayClient } from './clients/gateway.js'
import type { GitHubClient } from './clients/github.js'
import type { LlmClient } from './ai/providers.js'

const OWNER = '966500000001'
const ASSISTANT = '966500000002'
const cfg = loadConfig({ OWNER_PHONE: OWNER, ASSISTANT_PHONE: ASSISTANT, GATEWAY_URL: 'http://gw', GATEWAY_API_KEY: 'k', TZ: 'Asia/Riyadh' } as any)

// الأدوار تُختم بوقت القاعدة الفعلي — الساعة الحقيقية حتى تقع داخل نافذة "آخر يومين"
let clock = new Date()
const sent: string[] = []
const gateway: GatewayClient = {
  async sendText(_f, _t, text) { sent.push(text); return { id: `g${sent.length}`, status: 'queued' } },
  async getMessage(id) { return { id, status: 'sent' } },
}

const script: Record<string, any> = {}
let plan: any = { queries: [] }
let verdict: any = { verdict: 'supports', summary: '' }
const investigatePrompts: string[] = []
const understandPrompts: string[] = []
let scope: any = { creep: false, note: '' }
const sqlFor: Record<string, string> = {}
const llm: LlmClient = {
  async complete(system, user) {
    if (system === investigateSystem()) { investigatePrompts.push(user); return JSON.stringify(plan) }
    if (system === judgeSystem()) return JSON.stringify(verdict)
    if (system === scopeSystem()) return JSON.stringify(scope)
    if (system === sqlSystemRead()) {
      const req = user.split('الطلب:\n')[1].split('\n\n')[0].trim()
      return JSON.stringify({ sql: sqlFor[req] })
    }
    if (system.startsWith(summarySystem().slice(0, 40))) return 'خلاصة'
    understandPrompts.push(user)
    const msg = user.split('رسالة وليد الجديدة:\n')[1].split('\n\nتنبيه:')[0].trim().split('\n(تنبيه سياق')[0].trim()
    return JSON.stringify(script[msg] ?? { actions: [{ type: 'answer', text: 'تمام' }], reply: '' })
  },
}

const dispatched: { repo: string; prompt: string }[] = []
let prForBranch: any = null
let prFilesList: any[] = [{ filename: 'a.ts', additions: 4, deletions: 1 }]
let reportIssue: any = null
const prsByNumber: Record<number, any> = {}
const github: GitHubClient = {
  async dispatchWorkflow(repo, _wf, _ref, inputs) { dispatched.push({ repo, prompt: inputs.prompt }) },
  async listRuns() { return [] },
  async findPrByBranch() { return prForBranch },
  async getPr(_repo, n) { return prsByNumber[n] ?? prForBranch },
  async prFiles() { return prFilesList },
  async findIssue(_repo, prefix) { return reportIssue && prefix === reportIssue.prefix ? reportIssue : null },
  async mergePr() { return { sha: 'merged-sha' } },
  async closePr() {},
  async deleteBranch() {},
  async getFileContent() { return '[]' },
}

let db: Db, store: Store, a: Assistant, pg: PGlite
let seq = 0
const say = async (text: string) => {
  clock = new Date(clock.getTime() + 2_000)
  await a.accept({
    event: 'message', session_phone: ASSISTANT, message_id: `R${++seq}`, from: OWNER, from_jid: `${OWNER}@s.whatsapp.net`,
    timestamp: Math.floor(clock.getTime() / 1000), type: 'text', text, media: null, quoted_message_id: null,
  } as InboundPayload)
  await a.idle()
  return sent.at(-1) ?? ''
}
const codePending = async () => (await store.openPending(clock)).filter((p) => p.kind === 'code_change')

const BUG = 'ليش ماجد بازرعة طالع غير ملتزم في فلك نبراس وهو ملتزم في مثابر؟'
const FIX = 'لا غلط، في مثابر المعلم يضغط حضر بالزي'
const ASK = 'خلي كلود يصلح الربط في نبراس'

before(async () => {
  pg = await PGlite.create('memory://')
  await pg.exec(`
    CREATE TABLE falak_students (id SERIAL PRIMARY KEY, name TEXT, compliant BOOLEAN, password_hash TEXT);
    CREATE TABLE muthabir_attendance (id SERIAL PRIMARY KEY, student_name TEXT, status TEXT);
    INSERT INTO falak_students (name, compliant, password_hash) VALUES ('ماجد بازرعة', false, 'SECRETHASH'), ('سالم', true, 'H2');
    INSERT INTO muthabir_attendance (student_name, status) VALUES ('ماجد بازرعة', 'حضر بالزي');
  `)
  const conns = [
    { key: 'falak', name_ar: 'نبراس', aliases: ['فلك نبراس'], project: 'falak', url: 'postgres://x', deny_tables: [] },
    { key: 'qandeel', name_ar: 'قنديل', aliases: ['مثابر'], project: 'qandeel', url: 'postgres://y', deny_tables: [] },
  ]
  db = await createDb({ pgliteDir: 'memory://' })
  await migrate(db)
  store = new Store(db)
  const projects = new ProjectRegistry(parseProjects(JSON.stringify([
    { folder: 'sirajplus', repo: 'example-user/sirajplus', default_branch: 'main', aliases: ['نبراس', 'فلك نبراس', 'سراج بلس'] },
    { folder: 'qandeel', repo: 'example-user/qandeel-hub', default_branch: 'main', aliases: ['قنديل', 'مثابر'] },
  ])))
  a = new Assistant({
    cfg, store, llm, stt: { async transcribe() { return '' } }, gateway, github, projects,
    now: () => clock, railway: null, databases: new DatabaseRegistry(conns as any, pglitePool(pg)),
  })
  // طلب سابق على نفس المستودع رفضه المالك (مثل PR #12 أمس)
  await store.addJob({ request_id: 'old00001', project: 'falak', repo: 'example-user/sirajplus', default_branch: 'main', request: 'حساب الالتزام من الحضور فقط', dispatched_at: new Date(clock.getTime() - 86400_000) })
  await store.updateJob('old00001', { status: 'closed', pr_url: 'https://github.com/example-user/sirajplus/pull/12' })
})
after(async () => { await db.close(); await pg.close() })
beforeEach(async () => { sent.length = 0; dispatched.length = 0; await a.settings.update({ features: { db_access: true, code_changes: true } }) })

test('بلاغ خلل بيانات ← تحقيق قراءة فقط ← "🔎 الأدلة" في المعاينة ← نعم N ← برومبت غني بالأقسام الأربعة', async () => {
  plan = { queries: [
    { db: 'falak', sql: "select name, compliant, password_hash from falak_students where name ilike '%ماجد%'", why: 'حالته في نبراس' },
    { db: 'qandeel', sql: "select student_name, status from muthabir_attendance where student_name ilike '%ماجد%'", why: 'حالته في مثابر' },
  ] }
  verdict = { verdict: 'supports', summary: 'في مثابر «حضر بالزي» وفي نبراس غير ملتزم — الخلل موجود' }
  await say(BUG)
  await say(FIX)
  script[ASK] = { actions: [{ type: 'code_change', project_query: 'نبراس', request: 'إصلاح ربط الالتزام بين مثابر ونبراس' }], reply: '' }
  const preview = await say(ASK)
  assert.match(preview, /📝 جهزت الطلب \(ما نفّذته بعد\)/)
  assert.match(preview, /🔎 الأدلة:\nفي مثابر «حضر بالزي» وفي نبراس غير ملتزم/)
  assert.match(preview, /• نبراس: 1 صف — حالته في نبراس/)
  assert.match(preview, /• قنديل: 1 صف/)
  assert.match(preview, /📌 أرسل معه كلامك حرفياً \+ 1 تصحيح/)
  assert.equal(dispatched.length, 0, 'لا إرسال قبل نعم N')
  // المخططات أُعطيت للنموذج، والاستعلامات سُجّلت في db_audit كقراءة
  assert.match(investigatePrompts.at(-1)!, /falak_students\(/)
  const audit = await store.recentDbAudit(10)
  assert.ok(audit.filter((r) => r.kind === 'read' && r.ok).length >= 2)

  const [p] = await codePending()
  await say(`نعم ${p.short_no}`)
  assert.equal(dispatched.length, 1)
  const prompt = dispatched[0].prompt
  assert.ok(prompt.startsWith('## الملخص'))
  assert.ok(prompt.includes('إصلاح ربط الالتزام بين مثابر ونبراس'))
  assert.ok(prompt.includes(`> ${BUG}`), 'كلام المالك حرفياً')
  assert.ok(prompt.includes(`> ${FIX}`))
  assert.ok(prompt.includes(`1. «${FIX}»`), 'التصحيح قيد ملزم')
  assert.ok(prompt.includes('## الأدلة') && prompt.includes('"status":"حضر بالزي"'))
  assert.ok(!prompt.includes('SECRETHASH'), 'الأعمدة الحساسة محجوبة في الأدلة')
  assert.ok(prompt.includes('## طلبات سابقة ذات صلة') && prompt.includes('pull/12') && prompt.includes('مسكّر/مرفوض'))
  assert.ok(prompt.includes('نفّذ المطلوب فقط — لا ميزات إضافية غير مطلوبة؛ إن رأيت تحسيناً اقترحه في وصف الـ PR فقط'))
  assert.ok(prompt.includes('«## التحقق»'))
  assert.ok(prompt.includes('CLARIFICATION PROTOCOL'))
})

test('الأدلة تخالف كلام المالك ← سؤال واحد مركّز ولا طلب ولا إرسال؛ وإن أصرّ يُجهَّز الطلب مع ملاحظة الإصرار', async () => {
  plan = { queries: [{ db: 'falak', sql: "select name, compliant from falak_students where name ilike '%سالم%'", why: 'حالته في نبراس' }] }
  verdict = { verdict: 'contradicts', summary: 'سالم ملتزم في نبراس فعلاً', question: 'سالم طالع ملتزم في نبراس — تقصد طالب ثاني؟' }
  const q = 'ليش سالم طالع غير ملتزم في نبراس؟ خلي كلود يصلحها'
  script[q] = { actions: [{ type: 'code_change', project_query: 'نبراس', request: 'إصلاح التزام سالم في نبراس' }], reply: '' }
  const before = (await codePending()).length
  const out = await say(q)
  assert.match(out, /🔎 الأدلة:\nسالم ملتزم في نبراس فعلاً/)
  assert.match(out, /⚠️ الأدلة ما تطابق الوصف — ما أرسلت شي لـ Claude بعد/)
  assert.match(out, /تقصد طالب ثاني؟$/)
  assert.equal((await codePending()).length, before, 'لا طلب معلّق')
  assert.equal(dispatched.length, 0)

  const insist = 'لا هو سالم نفسه، نفذ'
  script[insist] = { actions: [{ type: 'code_change', project_query: 'نبراس', request: 'إصلاح التزام سالم في نبراس (المالك متأكد)' }], reply: '' }
  const pv = await say(insist)
  assert.match(pv, /📝 جهزت الطلب/)
  const p = (await codePending()).at(-1)!
  await say(`نعم ${p.short_no}`)
  assert.equal(dispatched.length, 1)
  assert.match(dispatched[0].prompt, /عُرض التعارض على المالك وأصرّ على طلبه/)
})

test('معاينة الدمج: قسم التحقق يظهر أولاً؛ غيابه ← ⚠️ بدون تحقق — و«نعم» بلا رقم لا تدمج في الحالتين', async () => {
  for (const [body, expectWarn] of [
    ['## Summary\nfix', true],
    ['## الملخص\nإصلاح\n\n## التحقق\n- tests/mubarak.test.ts: يفشل قبل وينجح بعد\n- npm test: 12 pass', false],
  ] as const) {
    sent.length = 0
    const id = Math.random().toString(16).slice(2, 10).padEnd(8, '0')
    await store.addJob({ request_id: id, project: 'falak', repo: 'example-user/sirajplus', default_branch: 'main', request: `طلب ${id}`, dispatched_at: clock })
    prForBranch = { number: 40, html_url: 'https://github.com/example-user/sirajplus/pull/40', title: '[claude] fix', body, state: 'open',
      head: { sha: `sha-${id}`, ref: `claude/req-${id}` }, base: { ref: 'main' } }
    await a.pollJobs()
    await a.idle()
    const msg = sent.at(-1)!
    assert.match(msg, /✅ جاهز التعديل في falak/)
    if (expectWarn) {
      assert.match(msg, /⚠️ بدون تحقق/)
    } else {
      assert.doesNotMatch(msg, /بدون تحقق/)
      assert.match(msg, /✅ جاهز التعديل في falak:\n🧪 التحقق:\n- tests\/mubarak\.test\.ts: يفشل قبل وينجح بعد\n- npm test: 12 pass/)
      assert.equal((msg.match(/npm test/g) ?? []).length, 1, 'التحقق لا يتكرر في الملخص')
    }
    assert.match(msg, /أدمجه؟ رد: نعم \d+/)
    const merge = (await store.openPending(clock)).filter((p) => p.kind === 'merge_pr').at(-1)!
    await say('نعم')
    assert.equal((await store.getJob(id))!.status, 'awaiting_merge', '"نعم" بلا رقم لا تدمج')
    await say(`نعم ${merge.short_no}`)
    assert.equal((await store.getJob(id))!.status, 'merged')
  }
  prForBranch = null
})

test('طلب ميزة عادي (ليس خلل بيانات) ← لا تحقيق ولا أدلة', async () => {
  const n = investigatePrompts.length
  const q = 'خلي كلود يضيف زر تصدير في نبراس'
  script[q] = { actions: [{ type: 'code_change', project_query: 'نبراس', request: 'إضافة زر تصدير' }], reply: '' }
  const out = await say(q)
  assert.match(out, /📝 جهزت الطلب/)
  assert.doesNotMatch(out, /🔎 الأدلة/)
  assert.equal(investigatePrompts.length, n)
})

// ───── من تقييم عمر ─────

test('بحث الاسم في قاعدة: ة/ه في الطرفين، "با زرعة"≈"بازرعة"، وكل جزء AND — والتطبيع في الكود لا عبر النموذج', async () => {
  await pg.exec(`CREATE TABLE IF NOT EXISTS registrations (id INT, full_name TEXT, uniform_compliant BOOLEAN);
    DELETE FROM registrations;
    INSERT INTO registrations VALUES (249, 'ماجد احمد ماجد بازرعة', true), (12, 'عمر ماجد الزهراني', false);`)
  // نفس SQL أمس: العمود مطبّع (ة←ه) والنص لا ← كان صفر صفوف
  const q1 = 'هل ماجد بازرعة ملتزم بالزي في قنديل؟'
  script[q1] = { actions: [{ type: 'db_query', db_query: 'قنديل', question: q1 }], reply: '' }
  sqlFor[q1] = "select full_name, uniform_compliant from registrations where translate(full_name,'أإآىةؤئ','ااايهوي') ilike '%ماجد%' and translate(full_name,'أإآىةؤئ','ااايهوي') ilike '%بازرعة%'"
  const out1 = await say(q1)
  assert.doesNotMatch(out1, /ما لقيت/)
  assert.equal(out1, 'خلاصة')
  // "با زرعة" بمسافة يطابق "بازرعة"
  const q2 = 'وش حالة ماجد با زرعة في قنديل؟'
  script[q2] = { actions: [{ type: 'db_query', db_query: 'قنديل', question: q2 }], reply: '' }
  sqlFor[q2] = "select full_name from registrations where full_name ilike '%ماجد با زرعة%'"
  assert.equal(await say(q2), 'خلاصة')
})

test('مستودعات مرتبطة: طلب على سراج بلس يحمل عقد الربط مع قنديل وطلبات قنديل السابقة بوصف الـ PR', async () => {
  await store.addJob({ request_id: 'msk00031', project: 'قنديل', repo: 'example-user/qandeel-hub', default_branch: 'main', request: 'زر حضر بالزي', dispatched_at: new Date(clock.getTime() - 3600_000) })
  await store.updateJob('msk00031', { status: 'merged', pr_number: 31, pr_url: 'https://github.com/example-user/qandeel-hub/pull/31' })
  prsByNumber[31] = { number: 31, title: '[claude] زر حضر بالزي', body: '## Summary\nuniformViolation is never set by any UI — always false', state: 'closed', head: { sha: 'x' } }
  plan = { queries: [] }
  const q = 'خلي كلود يضيف قراءة uniformCompliant في نبراس'
  script[q] = { actions: [{ type: 'code_change', project_query: 'نبراس', request: 'قراءة uniformCompliant من مثابر' }], reply: '' }
  const pv = await say(q)
  assert.match(pv, /🔗 مرتبط بـ example-user\/qandeel-hub/)
  const p = (await codePending()).at(-1)!
  await say(`نعم ${p.short_no}`)
  const prompt = dispatched.at(-1)!.prompt
  assert.ok(prompt.includes('## مستودعات مرتبطة') && prompt.includes('example-user/qandeel-hub') && prompt.includes('/api/falak/v1/daily'))
  assert.ok(prompt.includes('example-user/qandeel-hub — مدموج'))
  assert.ok(prompt.includes('uniformViolation is never set by any UI'), 'اكتشاف Claude في المستودع الآخر يصل')
})

test('"شيك وقارن" بلا طلب إصلاح ← تقرير فقط: لا PR، والتقرير من issue يوصل للمالك', async () => {
  plan = { queries: [] }
  const q = 'شيك الكود في مثابر وشيك الكود في نبراس، لازم نتأكد إنه اثنينهم متوافقين'
  script[q] = { actions: [{ type: 'code_change', project_query: 'نبراس', request: 'مراجعة توافق قراءة الزي بين مثابر ونبراس' }], reply: '' }
  const pv = await say(q)
  assert.match(pv, /📋 تقرير فقط/)
  const p = (await codePending()).at(-1)!
  await say(`نعم ${p.short_no}`)
  const prompt = dispatched.at(-1)!.prompt
  assert.ok(prompt.includes('## وضع التقرير فقط') && prompt.includes('REPORT-ONLY MODE'))
  const job = (await store.recentJobs(1))[0]
  assert.ok(prompt.includes(`[claude-report] ${job.request_id}`))
  reportIssue = { prefix: `[claude-report] ${job.request_id}`, number: 5, html_url: 'https://github.com/x/issues/5', body: 'نبراس يقرأ uniformViolation فقط ويتجاهل uniformCompliant' }
  prForBranch = null
  sent.length = 0
  await a.pollJobs(); await a.idle()
  assert.match(sent.at(-1)!, /📋 تقرير Claude عن/)
  assert.match(sent.at(-1)!, /يتجاهل uniformCompliant/)
  assert.equal((await store.getJob(job.request_id))!.status, 'reported')
  reportIssue = null
})

const offerPr = async (body: string, files: any[] = [{ filename: 'a.ts', additions: 4, deletions: 1 }]) => {
  const id = Math.random().toString(16).slice(2, 10).padEnd(8, '0')
  await store.addJob({ request_id: id, project: 'سراج بلس', repo: 'example-user/sirajplus', default_branch: 'main', request: 'افحص مزامنة الزي', dispatched_at: clock })
  prFilesList = files
  prForBranch = { number: 41, html_url: 'https://github.com/example-user/sirajplus/pull/41', title: '[claude] fix', body, state: 'open', head: { sha: `sha-${id}`, ref: `claude/req-${id}` }, base: { ref: 'main' } }
  prsByNumber[41] = prForBranch
  sent.length = 0
  await a.pollJobs(); await a.idle()
  prForBranch = null
  const merge = (await store.openPending(clock)).filter((x) => x.kind === 'merge_pr').at(-1)!
  return { id, msg: sent.at(-1)!, no: merge.short_no }
}

test('بوابة الدمج: "الاختبارات ما اشتغلت" ← «نعم N» مرفوضة، و«نعم N بدون فحص» تدمج', async () => {
  const { id, msg, no } = await offerPr('## الملخص\nإصلاح\n\n## التحقق\n- tsc/vitest/eslint could not run (npm ci failed)')
  assert.match(msg, /⛔ الاختبارات ما اشتغلت/)
  const r = await say(`نعم ${no}`)
  assert.match(r, /⛔ ما أدمجه/)
  assert.match(r, new RegExp(`نعم ${no} بدون فحص`))
  assert.equal((await store.getJob(id))!.status, 'awaiting_merge')
  await say(`نعم ${no} بدون فحص`)
  assert.equal((await store.getJob(id))!.status, 'merged')
})

test('سكربت backfill بلا نتيجة dry-run ← ممنوع بالدمج العادي؛ ومع قسم Dry-run يمر', async () => {
  const files = [{ filename: 'scripts/backfill-uniform.ts', additions: 40, deletions: 0 }]
  const a1 = await offerPr('## الملخص\nbackfill\n\n## التحقق\n- npm test: 10 pass', files)
  assert.match(a1.msg, /⛔ سكربت بيانات\/ترحيل بدون نتيجة dry-run: scripts\/backfill-uniform\.ts/)
  assert.match(await say(`نعم ${a1.no}`), /dry-run/)
  assert.equal((await store.getJob(a1.id))!.status, 'awaiting_merge')
  const a2 = await offerPr('## الملخص\nbackfill\n\n## التحقق\n- npm test: 10 pass\n\n## Dry-run\nwould change 32 of 109 rows', files)
  assert.doesNotMatch(a2.msg, /dry-run:/)
  await say(`نعم ${a2.no}`)
  assert.equal((await store.getJob(a2.id))!.status, 'merged')
})

test('تجاوز النطاق يظهر في معاينة الدمج (🚧) — تنبيه فقط', async () => {
  scope = { creep: true, note: 'أضاف زر «حضر بالزي» بنقرة واحدة والطلب كان فحصاً فقط' }
  const { id, msg, no } = await offerPr('## التحقق\n- npm test: 5 pass')
  assert.match(msg, /🚧 خارج المطلوب: أضاف زر «حضر بالزي»/)
  await say(`نعم ${no}`)
  assert.equal((await store.getJob(id))!.status, 'merged')
  scope = { creep: false, note: '' }
})

test('إشعار خلفي لا يخطف الموضوع: "حل المشكلة" بعده تعود لرسائل المالك الأخيرة', async () => {
  await say('ماجد بازرعة طالع غير ملتزم بالزي في نبراس')
  await a.say('❌ فشل دمج PR #56 في البوت (تعارض)')        // إشعار خلفي (بلا رسالة مالك)
  const turns = await store.lastTurns(1)
  assert.ok(turns[0].text.startsWith('🔔 [إشعار تلقائي] '), 'الإشعار معلَّم في السجل')
  understandPrompts.length = 0
  await say('حل المشكلة')
  const u = understandPrompts.at(-1)!
  assert.match(u, /تنبيه سياق: آخر رسالة من البوت إشعار تلقائي عن موضوع آخر/)
  assert.match(u, /ماجد بازرعة طالع غير ملتزم بالزي في نبراس/)
})
