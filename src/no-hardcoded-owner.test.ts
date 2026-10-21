/**
 * هوية المالك ما تُكتب في كود المساعد — تأتي من assistant.config.json عبر profile() فقط.
 * (أ) لا مصطلح من قائمة DENY (hash فقط، src/lib/hygiene-deny.ts) في الكود المشحون — عام ويصلح لأي ريبو.
 * (ب) إن كان في assistant.config.json قيم مالك حقيقية: اسمه وأرقامه وحسابه في GitHub لا تظهر حرفياً في الكود المشحون.
 * الفحص على النص الأصلي ونسخته المفكوكة (\u و \x و [c]) — لا يُخفى شيء بالترميز.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DENY } from './lib/hygiene-deny.js'
import { decodedView, deniedTerms, termHash, tokens } from './lib/hygiene.js'
import { PROFILE_PLACEHOLDERS } from './profile.js'

const ROOTS = ['src', 'public']
/** الاختبارات والـ fixtures وملف الملف الشخصي التجريبي ليست كوداً مشحوناً */
const SKIP = [/\.test\.ts$/, /^src[\\/]evals[\\/]/, /^src[\\/]selfreview[\\/]fixtures\.ts$/, /^src[\\/]test-/]

type Src = { rel: string; text: string }

function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|js)$/.test(n)) yield p
  }
}

function shipped(): Src[] {
  const out: Src[] = []
  for (const root of ROOTS) for (const f of walk(root)) {
    const rel = relative('.', f)
    if (!SKIP.some((s) => s.test(rel))) out.push({ rel, text: readFileSync(f, 'utf8') })
  }
  return out
}

/** (أ) الملفات التي فيها مصطلح ممنوع (العدد فقط — لا نطبع المصطلح) */
function denyHits(srcs: Src[], deny: ReadonlySet<string>): string[] {
  return srcs.flatMap(({ rel, text }) => {
    const n = deniedTerms(text, deny)
    return n ? [`${rel}: ${n} denied term(s)`] : []
  })
}

type Config = {
  owner?: { name?: string; phone?: string }
  github?: { owner?: string; self_repo?: string; projects_remote?: string; claude_config_repo?: string }
  direct_send_allowlist?: string[]
}
type Needle = { kind: 'name' | 'phone' | 'github'; value: string }

/** (ب) قيم الهوية من الإعدادات — بدون قيم المثال (القالب) */
function identityNeedles(cfg: Config): Needle[] {
  const placeholderOwner = PROFILE_PLACEHOLDERS.repo.split('/')[0]!
  const repoOwner = (r?: string) => r?.split('/')[0]
  const phones = [cfg.owner?.phone, ...(cfg.direct_send_allowlist ?? [])]
    .flatMap((p) => (p ? (p.startsWith('9665') ? [p, `0${p.slice(3)}`] : [p]) : []))
  const raw: Needle[] = [
    { kind: 'name', value: cfg.owner?.name ?? '' },
    ...[cfg.github?.owner, repoOwner(cfg.github?.self_repo), repoOwner(cfg.github?.projects_remote), repoOwner(cfg.github?.claude_config_repo)]
      .map((value) => ({ kind: 'github' as const, value: value ?? '' })),
    ...phones.map((value) => ({ kind: 'phone' as const, value })),
  ]
  const seen = new Set<string>()
  return raw.filter(({ value }) => {
    const v = value.trim()
    if (!v || v === PROFILE_PLACEHOLDERS.owner || v === placeholderOwner || seen.has(v)) return false
    seen.add(v)
    return true
  })
}

/** كلمات النص الموحّدة بين مسافات — مطابقة كلمة/عبارة كاملة لا جزء كلمة */
const phrase = (s: string) => ` ${tokens(s).join(' ')} `

function identityHits(srcs: Src[], needles: Needle[]): string[] {
  const ns = needles.map((n) => ({ ...n, p: phrase(n.value) })).filter((n) => n.p.trim())
  const hits: string[] = []
  for (const { rel, text } of srcs) {
    const views = [phrase(text), phrase(decodedView(text))]
    for (const n of ns) if (views.some((v) => v.includes(n.p))) hits.push(`${rel}: owner ${n.kind} from assistant.config.json`)
  }
  return hits
}

const CONFIG = 'assistant.config.json'
const needles = existsSync(CONFIG) ? identityNeedles(JSON.parse(readFileSync(CONFIG, 'utf8')) as Config) : []

test('(a) no denied term (hash list) in shipped source', () => {
  assert.ok(DENY.size >= 30, 'deny list loaded')
  const hits = denyHits(shipped(), DENY)
  assert.deepEqual(hits, [], `denied term in shipped source:\n${hits.join('\n')}`)
})

test('(b) owner name, phones and GitHub owner from assistant.config.json are not hardcoded in shipped source',
  { skip: !needles.length && 'no assistant.config.json with real owner values (template)' }, () => {
    const hits = identityHits(shipped(), needles)
    assert.deepEqual(hits, [], `hardcoded identity found:\n${hits.join('\n')}`)
  })

test('self-test: (a) and (b) catch an injected fake value', () => {
  // (أ) كلمة وهمية تُحسب hash وقت التشغيل — حرفياً، ومع سابقة، ومرمّزة \u
  const fake = 'زهلونيا'
  const deny = new Set([termHash(fake)])
  const escaped = [...fake].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  assert.deepEqual(denyHits([{ rel: 'src/x.ts', text: `const n = 'و${fake}'` }], deny), ['src/x.ts: 1 denied term(s)'])
  assert.deepEqual(denyHits([{ rel: 'src/y.ts', text: `const re = /${escaped}/` }], deny), ['src/y.ts: 1 denied term(s)'])
  assert.deepEqual(denyHits([{ rel: 'src/z.ts', text: 'const n = profile().owner.name' }], deny), [])

  // (ب) إعدادات مؤقتة بقيم وهمية
  const cfg: Config = {
    owner: { name: 'فهد التجريبي', phone: '966500000077' },
    github: { owner: 'fake-owner-zz', self_repo: 'fake-owner-zz/bot', claude_config_repo: 'fake-owner-zz/cfg' },
    direct_send_allowlist: ['966511111199'],
  }
  const ns = identityNeedles(cfg)
  assert.deepEqual(ns.map((n) => n.kind), ['name', 'github', 'phone', 'phone', 'phone', 'phone'])
  const hit = (text: string) => identityHits([{ rel: 'src/x.ts', text }], ns)
  assert.deepEqual(hit('// كلّم فهد التجريبي'), ['src/x.ts: owner name from assistant.config.json'])
  assert.deepEqual(hit("const to = '0500000077'"), ['src/x.ts: owner phone from assistant.config.json'])
  assert.deepEqual(hit('https://github.com/fake-owner-zz/x'), ['src/x.ts: owner github from assistant.config.json'])
  assert.deepEqual(hit(String.raw`/fake\-owner\-z[z]/`), ['src/x.ts: owner github from assistant.config.json'], 'decoded view')
  assert.deepEqual(hit('فهد وحده، و fake-owner-zzz، و 9665000000771'), [], 'whole words only')
  // قيم المثال (القالب) لا تُفحص
  assert.deepEqual(identityNeedles({ owner: { name: PROFILE_PLACEHOLDERS.owner }, github: { owner: 'github-user', self_repo: PROFILE_PLACEHOLDERS.repo } }), [])
})
