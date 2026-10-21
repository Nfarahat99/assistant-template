/**
 * سياق طلبات الكود الغني — وحدات صافية: التصحيحات، تجميع البرومبت والقص، قسم التحقق، صدق القدرات.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCorrection, detectCorrections, looksLikeDataBug, buildCodePrompt, extractVerification, withoutVerification,
  parseVerdict, parseInvestigationPlan, evidencePreview, investigate, SCOPE_GUARD, MAX_PROMPT_BYTES,
  investigateSystem, judgeSystem, type CodeContext, type EvidenceDbs,
  testsNotRun, dataScriptFiles, hasDryRunResult, mergeGateReason, wantsReportOnly, linkedFor, isShortReferral, parseLinkedRepos, mentionedRepos,
} from './lib/code-context.js'
import { verificationBlock } from './format.js'

test('كشف التصحيحات: "لا غلط" / "مو كذا" / "الصحيح…" / "قصدي" — والبلاغ العادي ليس تصحيحاً', () => {
  for (const t of ['لا غلط، في مثابر المعلم يضغط حضر بالزي', 'مو كذا', 'الصحيح إن الالتزام = حضر بالزي', 'لا، غلط فهمت', 'قصدي نبراس مو قنديل', 'المفروض يطلع ملتزم']) {
    assert.ok(isCorrection(t), t)
  }
  for (const t of ['ليش ماجد طالع غير ملتزم؟', 'أضف endpoint للصحة', 'مهامي']) assert.ok(!isCorrection(t), t)
})

test('التصحيحات: كل ما في النافذة الحالية + من الأسبوع فقط ما يخص نفس الموضوع، بلا تكرار', () => {
  const recent = [{ text: 'ليش ماجد بازرعة غير ملتزم في نبراس؟' }, { text: 'لا غلط، في مثابر المعلم يضغط حضر بالزي' }]
  const older = [
    { text: 'الصحيح إن نبراس يقرأ الالتزام من مثابر' },          // نفس الموضوع (نبراس/الالتزام)
    { text: 'لا غلط، الرسالة لأحمد مو لسامي' },                // موضوع آخر
    { text: 'لا غلط، في مثابر المعلم يضغط حضر بالزي' },          // مكرر
  ]
  const c = detectCorrections(recent, older, 'إصلاح الالتزام في نبراس')
  assert.deepEqual(c, ['الصحيح إن نبراس يقرأ الالتزام من مثابر', 'لا غلط، في مثابر المعلم يضغط حضر بالزي'])
})

test('خلل بيانات/سلوك يُكتشف ("ليش طالع"، "مو صحيح"، "مشكلة في الربط"، "شيك") — وطلب الميزة لا', () => {
  for (const t of ['ليش طالع ماجد غير ملتزم', 'الرقم مو صحيح', 'فيه مشكلة في الربط بين مثابر ونبراس', 'شيك على الطالب ماجد']) assert.ok(looksLikeDataBug(t), t)
  for (const t of ['أضف زر تصدير', 'غيّر لون الهيدر']) assert.ok(!looksLikeDataBug(t), t)
})

const ctx = (over: Partial<CodeContext> = {}): CodeContext => ({
  owner_turns: ['ليش ماجد بازرعة ملتزم في مثابر وغير ملتزم في فلك نبراس؟', '🎤 لا غلط في مثابر المعلم يضغط حضر بالزي', 'خلي كلود يصلحها'],
  corrections: ['لا غلط في مثابر المعلم يضغط حضر بالزي'],
  related: [{ request: 'إصلاح حساب الالتزام', status: 'مسكّر/مرفوض ✋', pr_url: 'https://github.com/x/sirajplus/pull/12', when: '2026-10-05 14:00' }],
  evidence: {
    verdict: 'supports', summary: 'في مثابر: حضر بالزي، وفي نبراس: غير ملتزم', question: null,
    items: [{ db: 'falak', db_name: 'نبراس', why: 'حالة الطالب', sql: 'select 1', columns: ['name', 'compliant'], rows: [{ name: 'ماجد بازرعة', compliant: false }], truncated: false, masked: [] }],
  },
  ...over,
})

test('البرومبت: الأقسام الأربعة + النطاق + التحقق، وكلام المالك حرفياً (مع الصوتية)', () => {
  const p = buildCodePrompt('إصلاح ربط الالتزام', ctx())
  for (const h of ['## طلب المالك (حرفياً)', '## تصحيحات المالك (قيود ملزمة)', '## الأدلة', '## طلبات سابقة ذات صلة', '## التحقق']) assert.ok(p.includes(h), h)
  assert.ok(p.includes(SCOPE_GUARD))
  assert.ok(p.includes('> 🎤 لا غلط في مثابر المعلم يضغط حضر بالزي'))
  assert.ok(p.includes('1. «لا غلط في مثابر المعلم يضغط حضر بالزي»'))
  assert.match(p, /"name":"ماجد بازرعة","compliant":"false"/)
  assert.match(p, /pull\/12/)
  assert.ok(p.indexOf('## طلب المالك') < p.indexOf('## تصحيحات') && p.indexOf('## تصحيحات') < p.indexOf('## الأدلة') && p.indexOf('## الأدلة') < p.indexOf('## طلبات سابقة'))
})

test('البرومبت بلا سياق (طلب قديم): الملخص + النطاق + التحقق فقط', () => {
  const p = buildCodePrompt('أضف endpoint للصحة', null)
  assert.ok(p.includes('أضف endpoint للصحة') && p.includes(SCOPE_GUARD) && p.includes('## التحقق'))
  assert.ok(!p.includes('## الأدلة') && !p.includes('## طلب المالك'))
})

test('القص ضمن حد GitHub: الأقدم أولاً — آخر رسالة والتصحيحات تبقى', () => {
  const turns = Array.from({ length: 15 }, (_, i) => `رسالة ${i + 1} ` + 'ك'.repeat(1900))
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: `طالب ${i}`, note: 'ن'.repeat(250) }))
  const big = ctx({
    owner_turns: turns,
    related: Array.from({ length: 10 }, (_, i) => ({ request: `طلب قديم ${i} ` + 'ط'.repeat(290), status: 'مدموج ✅', pr_url: null, when: `2026-10-0${i % 9}` })),
  })
  big.evidence!.items[0] = { ...big.evidence!.items[0], columns: ['name', 'note'], rows }
  const p = buildCodePrompt('ملخص', big, 20_000)
  assert.ok(Buffer.byteLength(p, 'utf8') <= 20_000, `${Buffer.byteLength(p, 'utf8')}`)
  assert.ok(p.includes('رسالة 15 '), 'آخر رسالة للمالك تبقى')
  assert.ok(!p.includes('رسالة 1 '), 'الأقدم يُحذف أولاً')
  assert.ok(p.includes('لا غلط في مثابر المعلم يضغط حضر بالزي'), 'التصحيحات لا تُحذف')
  assert.ok(p.includes(SCOPE_GUARD) && p.includes('## التحقق'))
  // الحد الافتراضي تحت ٦٥ ألف
  assert.ok(MAX_PROMPT_BYTES < 65_535)
  const full = buildCodePrompt('ملخص', big)
  assert.ok(Buffer.byteLength(full, 'utf8') <= MAX_PROMPT_BYTES)
})

test('قسم التحقق من وصف الـ PR: يُستخرج حتى العنوان التالي، ويُحذف من الملخص؛ وغيابه = null', () => {
  const body = '## الملخص\nتعديل\n\n## التحقق\n- أضفت اختبار muthabir-mubarak.test.ts (يفشل قبل وينجح بعد)\n- npm test: 41 pass\n\n## الملفات\na.ts'
  assert.equal(extractVerification(body), '- أضفت اختبار muthabir-mubarak.test.ts (يفشل قبل وينجح بعد)\n- npm test: 41 pass')
  assert.ok(!withoutVerification(body)!.includes('npm test'))
  assert.ok(withoutVerification(body)!.includes('## الملفات'))
  assert.equal(extractVerification('## Summary\nfoo'), null)
  assert.equal(extractVerification('## التحقق\n\n## other'), null, 'قسم فاضي = بدون تحقق')
  assert.equal(extractVerification(null), null)
  assert.match(verificationBlock(null), /⚠️ بدون تحقق/)
  assert.match(verificationBlock('npm test'), /🧪 التحقق:\nnpm test/)
  assert.equal(verificationBlock(undefined), '', 'حمولة قديمة')
})

test('الحكم: تعارض بلا سؤال لا يوقف الطلب؛ والخطة تقبل القواعد المعروفة فقط وبحد ٣', () => {
  assert.equal(parseVerdict('{"verdict":"contradicts","summary":"x"}').verdict, 'unclear')
  assert.deepEqual(parseVerdict('{"verdict":"contradicts","summary":"x","question":"متأكد؟"}'), { verdict: 'contradicts', summary: 'x', question: 'متأكد؟' })
  assert.equal(parseVerdict('مو JSON').verdict, 'unclear')
  const plan = parseInvestigationPlan(JSON.stringify({ queries: [
    { db: 'falak', sql: 'select 1', why: 'a' }, { db: 'evil', sql: 'select 2' }, { db: 'falak', sql: 'select 3' }, { db: 'falak', sql: 'select 4' }, { db: 'falak', sql: 'select 5' },
  ] }), ['falak'])
  assert.deepEqual(plan.map((q) => q.sql), ['select 1', 'select 3', 'select 4'])
})

test('التحقيق (قاعدة مزيّفة): الاستعلامات تمر بمسار القراءة، والخطأ يُسجَّل دليلاً لا انهياراً، و≤٥٠ صف', async () => {
  const audits: string[] = []
  const dbs: EvidenceDbs = {
    list: () => [{ key: 'falak', name_ar: 'نبراس', project: 'falak', aliases: ['فلك نبراس'] }, { key: 'qandeel', name_ar: 'قنديل', project: 'qandeel', aliases: ['مثابر'] }],
    async schema(k) { return k === 'falak' ? 'students(name text, compliant bool)' : 'muthabir(name text, status text)' },
    async query(k, sql) {
      if (sql.includes('boom')) throw new Error('relation "x" does not exist')
      const rows = Array.from({ length: 60 }, (_, i) => ({ name: i ? `طالب ${i}` : 'ماجد بازرعة', status: k }))
      return { columns: ['name', 'status'], rows: rows.slice(0, 50), rowCount: 50, truncated: true, masked: [], sql }
    },
  }
  const prompts: string[] = []
  const inv = await investigate({
    dbs,
    async complete(sys, user) {
      prompts.push(user)
      if (sys === investigateSystem()) return JSON.stringify({ queries: [{ db: 'falak', sql: 'select * from students', why: 'نبراس' }, { db: 'qandeel', sql: 'select boom', why: 'مثابر' }] })
      if (sys === judgeSystem()) return JSON.stringify({ verdict: 'supports', summary: 'غير ملتزم في نبراس' })
      throw new Error('?')
    },
    async audit(k, _sql, rows, err) { audits.push(`${k}:${rows}:${err ? 'err' : 'ok'}`) },
  }, 'ليش ماجد بازرعة غير ملتزم في فلك نبراس وهو ملتزم في مثابر')
  assert.ok(inv)
  assert.equal(inv!.verdict, 'supports')
  assert.equal(inv!.items[0].rows.length, 50)
  assert.match(inv!.items[1].error!, /does not exist/)
  assert.deepEqual(audits, ['falak:50:ok', 'qandeel:null:err'])
  assert.match(prompts[0], /students\(name text/)
  assert.match(prompts[0], /muthabir\(name text/, 'القاعدتان المذكورتان (نبراس + مثابر) في الخطة')
  const pv = evidencePreview(inv)
  assert.match(pv, /^🔎 الأدلة:\nغير ملتزم في نبراس\n• نبراس: 50\+ صف/)
  assert.match(pv, /• قنديل: ❌ تعذّر الاستعلام/)
})

test('بوابة الدمج: "could not run" / "npm ci failed" / "لم أشغّل" ← سبب رفض؛ والتحقق الحقيقي لا', () => {
  assert.match(testsNotRun('- tsc/vitest/eslint could not run (npm ci failed)', null)!, /could not run/)
  assert.match(testsNotRun(null, '## Notes\nNot run against a live DB')!, /Not run against/)
  assert.match(testsNotRun('لم أشغّل الاختبارات لأن البيئة ناقصة', null)!, /لم أشغّل/)
  assert.equal(testsNotRun('- npm test: 41 pass\n- tsc: 0 errors', '## التحقق\n- npm test: 41 pass'), null)
  assert.deepEqual(dataScriptFiles(['src/a.ts', 'scripts/backfill-uniform.ts', 'prisma/migrations/1/migration.sql']), ['scripts/backfill-uniform.ts', 'prisma/migrations/1/migration.sql'])
  assert.ok(hasDryRunResult('## Dry-run\nwould change 32 of 109'))
  assert.ok(!hasDryRunResult('## التحقق\nnpm test'))
  assert.equal(mergeGateReason({}), null)
  assert.match(mergeGateReason({ tests_not_run: 'npm ci failed', no_dry_run: ['scripts/x.ts'] })!, /الاختبارات ما اشتغلت.*dry-run/)
})

test('تقرير فقط: "شيك/قارن" بلا كلمة إصلاح؛ والمستودعات المرتبطة؛ والإحالة القصيرة', () => {
  assert.ok(wantsReportOnly('شيك الكود في مثابر وشيك الكود في نبراس، لازم نتأكد إنه اثنينهم متوافقين'))
  assert.ok(!wantsReportOnly('شيك الربط وصلحه'))
  assert.ok(!wantsReportOnly('أضف زر تصدير'))
  assert.deepEqual(linkedFor('example-user/sirajplus').map((l) => l.repo), ['example-user/qandeel-hub'])
  assert.deepEqual(linkedFor('example-user/qandeel-hub').map((l) => l.repo), ['example-user/sirajplus'])
  assert.deepEqual(linkedFor('example-user/nuqta'), [])
  const p = buildCodePrompt('مراجعة', ctx({ mode: 'report', linked: [{ repo: 'example-user/qandeel-hub', note: 'عقد الربط' }] }))
  assert.ok(p.includes('## وضع التقرير فقط') && p.includes('## مستودعات مرتبطة') && !p.includes('التحقق (إلزامي في وصف الـ PR)'))
  for (const t of ['حل المشكلة', 'طيب حلها', 'كمل']) assert.ok(isShortReferral(t), t)
  assert.ok(!isShortReferral('حل مشكلة الزي في نبراس لماجد بازرعة اللي قلت لك عنه أمس'))
})

test('المستودعات المرتبطة من البيئة (LINKED_REPOS JSON) — لا شيء مدمج في الكود', () => {
  assert.deepEqual(parseLinkedRepos(undefined), [])
  assert.deepEqual(parseLinkedRepos(''), [])
  assert.deepEqual(parseLinkedRepos('nope'), [])
  assert.deepEqual(parseLinkedRepos('{"repos":[]}'), [])
  assert.deepEqual(parseLinkedRepos('[{"repos":["a/x","b/y"]}]'), [{ repos: ['a/x', 'b/y'], words: [], note: '' }])
  const groups = parseLinkedRepos('[{"repos":["a/x","b/y"],"words":["w"],"note":"n"},{"repos":["only/one"]}]')
  assert.equal(groups.length, 1, 'مجموعة بمستودع واحد تُسقط')
  assert.deepEqual(linkedFor('A/X', groups), [{ repo: 'b/y', note: 'n', words: ['w'] }])
  assert.deepEqual(linkedFor('c/z', groups), [])
})

test('mentionedRepos: البدائل مشتقة من LINKED_REPOS[].words (لا خريطة مالك مدمجة) — الكلمة تشير لكل مستودعات مجموعتها', () => {
  const groups = parseLinkedRepos('[{"repos":["Acme/Shop","acme/feed"],"words":["المتجر الكبير","widget"],"note":"n"}]')
  assert.deepEqual(mentionedRepos('فيه خلل في widget اليوم', [], groups).sort(), ['acme/feed', 'acme/shop'])
  assert.deepEqual(mentionedRepos('فيه خلل في widget اليوم', [], []), [], 'بلا مجموعات: لا بدائل')
  assert.deepEqual(mentionedRepos('مشكلة في متجري', [{ repo: 'Acme/Store', names: ['متجري'] }], []), ['acme/store'])
})

test('اسم المساعد كلمة غير مميزة للموضوع — مشتق من profile().assistant.name لا مكتوب في الكود', async () => {
  const { setProfile, profile } = await import('./profile.js')
  const saved = profile()
  const older = [{ text: 'لا غلط، فهد يرسل التقرير الصبح' }, { text: 'لا غلط، سراج يرسل التقرير الصبح' }]
  try {
    // "فهد" اسم المساعد ← لا يربط الموضوع؛ "سراج" كلمة عادية ← يربط
    setProfile({ ...saved, assistant: { name: 'فهد' } })
    assert.deepEqual(detectCorrections([], older, 'فهد سراج زر جديد'), ['لا غلط، سراج يرسل التقرير الصبح'])
    setProfile({ ...saved, assistant: { name: 'سراج' } })
    assert.deepEqual(detectCorrections([], older, 'فهد سراج زر جديد'), ['لا غلط، فهد يرسل التقرير الصبح'])
  } finally { setProfile(saved) }
})
