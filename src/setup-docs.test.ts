/**
 * وثائق الإعداد متسقة مع الكود: onboarding/interview.md صار مؤشراً لمهارة assistant-builder،
 * وجدول الحلول في docs/START-HERE.md يقتبس رسائل doctor الحالية.
 * (تفاصيل المقابلة نفسها يفحصها اختبار العقد في ريبو assistant-builder.)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runChecks, runOnlineChecks, type Check } from './doctor.js'

// ويندوز (core.autocrlf) يسحب الملفات بـ CRLF — نوحّد قبل المطابقة
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const interview = read('onboarding/interview.md')
const startHere = read('docs/START-HERE.md')
const pkg = JSON.parse(read('package.json')) as { assistantTemplate?: { onboardingContract?: unknown } }

test('package.json declares the onboarding contract number', () => {
  assert.equal(pkg.assistantTemplate?.onboardingContract, 1)
})

test('interview.md points to the assistant-builder skill, with install commands and a fallback', () => {
  for (const s of [
    '/assistant-builder:build-assistant',
    'claude plugin marketplace add Nfarahat99/assistant-builder',
    'claude plugin install assistant-builder@assistant-builder',
    '/reload-plugins',
    'git clone --depth 1 https://github.com/Nfarahat99/assistant-builder.git',
    'plugins/assistant-builder/skills/build-assistant/SKILL.md',
  ]) assert.ok(interview.includes(s), `missing: ${s}`)
  assert.ok(interview.split('\n').length < 60, 'pointer stays short')
})

test('START-HERE uses the skill path', () => {
  for (const s of ['/plugin marketplace add Nfarahat99/assistant-builder', '/plugin install assistant-builder@assistant-builder', '/assistant-builder:build-assistant'])
    assert.ok(startHere.includes(s), `missing: ${s}`)
})

/** بداية رسالة الفحص (قبل أول « — » أو «:» أو «(») — الجزء اللي يقتبسه جدول الحلول */
const head = (c: Check) => c.message_ar.split(/ — |: | \(/)[0]!.trim()
const pick = (checks: Check[], id: string) => checks.find((c) => c.id === id)!

test('START-HERE troubleshooting table quotes the current doctor messages', async () => {
  const offline = runChecks({ GATEWAY_PROVISION_KEY: 'p' }, null)
  const badLink = runChecks({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_LINK_CODE: 'has space' }, null)
  const noLink = runChecks({ TELEGRAM_BOT_TOKEN: 'x' }, null)
  const json = (status: number) => new Response('{}', { status })
  const bad = await runOnlineChecks({ TELEGRAM_BOT_TOKEN: 't', GEMINI_API_KEY: 'g' }, { fetch: (async (u: string) => json(String(u).includes('telegram') ? 401 : 400)) as typeof fetch })
  const down = await runOnlineChecks({ TELEGRAM_BOT_TOKEN: 't' }, { fetch: (async () => { throw new Error('x') }) as typeof fetch })
  const quoted: Check[] = [
    pick(offline, 'channel'), pick(offline, 'wa_link'), pick(offline, 'restart'), pick(offline, 'dashboard'), pick(offline, 'github_token'),
    pick(noLink, 'link_code'), pick(badLink, 'link_code'),
    pick(bad, 'telegram_online'), pick(bad, 'gemini_online'),
  ]
  for (const c of quoted) {
    assert.equal(c.ok, false, c.id)
    assert.ok(startHere.includes(head(c)), `START-HERE row missing for ${c.id}: «${head(c)}»`)
  }
  assert.match(startHere, /ما قدرت أتحقق من توكن تيليجرام/)
  assert.match(pick(down, 'telegram_online').message_ar, /^ما قدرت أتحقق من توكن تيليجرام/)
})
