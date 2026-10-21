/**
 * القالب عام: ممنوع يرجع له اسم حقيقي، أو ريبو خاص، أو رقم جوال حقيقي، أو إيميل شخصي، أو نطاق استضافة حقيقي، أو سر.
 * المصطلحات الممنوعة محفوظة كـ SHA-256 فقط (scripts/hygiene-hash.mjs يحسبها).
 * يشتغل في ريبو القالب نفسه فقط — ريبو كل مالك فيه اسمه وبياناته طبيعي.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tokens, termHash, textHashes, ruleViolations, scanFile, decodedView, deniedTerms } from './lib/hygiene.js'
import { DENY } from './lib/hygiene-deny.js'


/** git يرمي عند الفشل — لا قائمة ملفات فارغة صامتة */
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' })
let origin = ''
try { origin = git('remote', 'get-url', 'origin').trim() } catch { /* بلا origin = ليس ريبو القالب المنشور */ }
const HASH_FILES = new Set(['src/public-hygiene.test.ts', 'src/lib/hygiene-deny.ts'])
const enabled =process.env.PUBLIC_HYGIENE === '1' || /[:/]Nfarahat99\/assistant-template(\.git)?$/i.test(origin)

test('hygiene helpers: tokenizing, hashing, rules', () => {
  assert.deepEqual(tokens('Hello-World  مرحبا، يا'), ['hello', 'world', 'مرحبا', 'يا'])
  assert.equal(termHash('Foo-Bar'), termHash('foo bar'))
  assert.ok(textHashes('a foo-bar b').has(termHash('foo bar')))
  assert.throws(() => termHash('a b c'))
  assert.deepEqual(ruleViolations('966500000001 0500000012 966511111113'), [])
  assert.deepEqual(ruleViolations('call 9665' + '12345678'), ['phone'])
  assert.deepEqual(ruleViolations('x@' + 'gmail.com'), ['personal-email'])
  assert.deepEqual(ruleViolations('https://example-web.up.railway.app'), [])
  assert.deepEqual(ruleViolations('https://web-production-1a2b.up.' + 'railway.app'), ['railway-host'])
  assert.deepEqual(ruleViolations('ghp_' + 'a'.repeat(36)), ['secret'])
})

test('hygiene helpers: Arabic attached prefixes and tatweel still hit the denied term', () => {
  const deny = new Set([termHash('قمرون'), termHash('قمرون زهلان')])
  const hit = (t: string) => [...textHashes(t)].some((h) => deny.has(h))
  for (const t of ['وقمرون', 'لقمرون', 'بقمرون', 'فقمرون', 'كقمرون', 'لـقمرون', 'قمـرون', 'والقمرون', 'بالقمرون', 'للقمرون', 'وبقمرون', 'ولـقمرون']) assert.ok(hit(t), t)
  assert.ok(textHashes('وقمرون بزهلان').has(termHash('قمرون زهلان')), 'pair with prefixes')
  assert.ok(textHashes('القمرون وزهلان').has(termHash('قمرون زهلان')), 'pair, ال + و')
  assert.ok(!hit('قمر ونجوم'), 'unrelated words')
})

test('hygiene helpers: phone rule normalizes +966/00966, separators and Arabic-Indic digits', () => {
  const p = (s: string) => ruleViolations(s)
  for (const t of ['00966 5' + '12345678', '+966 5' + '1234 5678', '+966-5' + '1-234-5678', '05' + '1 234 5678', '05' + '1-234-5678', '٠٥١٢' + '٣٤٥٦٧٨', '+٩٦٦٥' + '١٢٣٤٥٦٧٨']) assert.deepEqual(p(`tel ${t}.`), ['phone'], t)
  for (const t of ['+966 50000 0001', '00966 51111 1113', '0500 000 012', '051111-1113', '٠٥٠٠٠٠٠٠١٢', '+٩٦٦٥٠٠٠٠٠٠٠١']) assert.deepEqual(p(`tel ${t}.`), [], t)
})

test('hygiene helpers: OpenAI keys are secrets; sk-ant- still counted once', () => {
  assert.deepEqual(ruleViolations('k=sk-' + 'proj-' + 'Ab1'.repeat(12)), ['secret'])
  assert.deepEqual(ruleViolations('k=sk-' + 'Ab1x'.repeat(12)), ['secret'])
  assert.deepEqual(ruleViolations('k=sk-' + 'ant-' + 'a'.repeat(30)), ['secret'])
  assert.deepEqual(ruleViolations('task-runner-config sk-short'), [])
})

test('hygiene helpers: decodedView unescapes \\u, \\u{}, \\x, single-char [c] classes and escaped punctuation', () => {
  assert.equal(decodedView(String.raw`قمرون`), 'قمرون')
  assert.equal(decodedView(String.raw`\u{642}\u{645}رون \u{1F600}`), 'قمرون 😀')
  assert.equal(decodedView(String.raw`\x71am\x72oon`), 'qamroon')
  assert.equal(decodedView('qa[m]ro[o]n'), 'qamroon')
  assert.equal(decodedView(String.raw`qam\-roon\.x [\.]`), 'qam-roon.x .')
  assert.equal(decodedView(String.raw`\bqamroon\s\d+\n`), String.raw`\bqamroon\s\d+\n`, 'regex/escape letters stay as separators')
  assert.equal(decodedView('[ab] [] x'), '[ab] [] x', 'multi-char classes untouched')
})

test('hygiene helpers: escaped or bracket-split fake terms and phones are caught in the decoded view', () => {
  const deny = new Set([termHash('قمرون'), termHash('qamroon zahlan')])
  const utf8 = (s: string) => Buffer.from(s, 'utf8')
  assert.equal(deniedTerms(String.raw`const re = /قمرون/`, deny), 1)
  assert.equal(deniedTerms(String.raw`/قمرون/ و قمرون`, deny), 1, 'raw + decoded counted once')
  assert.equal(deniedTerms(String.raw`/\x71amroon[ ]zahl[a]n/i`, deny), 1, 'pair through \\x and [c]')
  assert.deepEqual(scanFile('a.ts', utf8(String.raw`x = 'قمرون'`), deny), ['a.ts: 1 denied term(s)'])
  // الرقم يُبنى وقت التشغيل — مصدر الاختبار نفسه نظيف
  const split = '/9665' + '[1]' + '2345678/'
  assert.deepEqual(ruleViolations(split), ['phone'])
  assert.deepEqual(scanFile('b.ts', utf8(`const re = ${split}`), deny), ['b.ts: phone'])
  assert.deepEqual(ruleViolations('/9665' + '0[0]' + '000001/'), [], 'fake prefix stays allowed after decoding')
  assert.deepEqual(ruleViolations(String.raw`9665` + '12345678'), ['phone'], 'escaped digit')
  assert.deepEqual(ruleViolations(String.raw`https://web\-production\-1a2b\.up\.` + String.raw`railway\.app`), ['railway-host'])
})

test('hygiene helpers: hash-only lines are not phone-scanned when skipHashLines is set', () => {
  const digits = '9665' + '12345678'
  const line = `  '${'a'.repeat(20)}${digits}${'b'.repeat(32)}',`
  assert.equal(line.trim().length, 64 + 3)
  assert.deepEqual(ruleViolations(line), ['phone'])
  assert.deepEqual(ruleViolations(line, { skipHashLines: true }), [])
  assert.deepEqual(ruleViolations(`${line}\ncall ${digits}`, { skipHashLines: true }), ['phone'], 'other lines still scanned')
  assert.deepEqual(scanFile('src/lib/hygiene-deny.ts', Buffer.from(line), new Set(), { skipHashLines: true }), [])
})

test('hygiene helpers: scanFile checks the path, UTF-16 text and unexpected binaries', () => {
  const deny = new Set([termHash('قمرون')])
  const utf8 = (s: string) => Buffer.from(s, 'utf8')
  assert.deepEqual(scanFile('docs/وقمرون/a.md', utf8('ok'), deny), ['docs/وقمرون/a.md: denied term in path'])
  assert.deepEqual(scanFile('a.md', utf8('هذا القمرون'), deny), ['a.md: 1 denied term(s)'])
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('مرحبا قمرون', 'utf16le')])
  assert.deepEqual(scanFile('a.txt', le, deny), ['a.txt: 1 denied term(s)'])
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('x@' + 'gmail.com', 'utf16le').swap16()])
  assert.deepEqual(scanFile('b.txt', be, deny), ['b.txt: personal-email'])
  const bin = Buffer.from([0x89, 0x50, 0x00, 0x01])
  assert.deepEqual(scanFile('img/logo.png', bin, deny), [])
  assert.deepEqual(scanFile('font.WOFF2', bin, deny), [])
  assert.deepEqual(scanFile('notes.txt', bin, deny), ['notes.txt: unexpected binary'])
  assert.deepEqual(scanFile('package-lock.json', utf8('x@' + 'gmail.com قمرون'), deny, { rules: false }), ['package-lock.json: 1 denied term(s)'])
})

test('tracked files carry no denied term, real phone, personal email, real host or secret', { skip: !enabled && 'not the template repo' }, () => {
  assert.ok(DENY.size >= 30, 'deny list loaded')
  const files = git('ls-files', '-z').split('\0').filter(Boolean)
  assert.ok(files.length > 100, `git ls-files returned only ${files.length} files`)
  const hits: string[] = []
  for (const f of files) {
    let buf: Buffer | null = null
    try { buf = readFileSync(f) } catch { /* محذوف من مجلد العمل — نفحص المسار فقط */ }
    // package-lock: المصطلحات فقط (أسماء حزم/hashes تطابق القواعد صدفة)
    // ملفات قائمة الـ hashes: سطر hash وحده لا يُفحص كرقم جوال
    hits.push(...scanFile(f, buf, DENY, { rules: f !== 'package-lock.json', skipHashLines: HASH_FILES.has(f) }))
  }
  assert.deepEqual(hits, [])
})
