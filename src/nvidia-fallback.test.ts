import { test } from 'node:test'
import assert from 'node:assert/strict'
import { failureReason } from './ai/providers.js'

test('failureReason: 410 من نيفيديا ← "النموذج انتهى دعمه" مع التفاصيل، مو "مصادقة"', () => {
  const err = new Error('Nvidia LLM HTTP 410: {"type":"about:blank","title":"Gone","status":410,"detail":"The model \'meta/llama-3.3-70b-instruct\' has reached its end of life on 2026-08-26"}')
  const r = failureReason(err)
  assert.match(r, /النموذج انتهى دعمه/)
  assert.match(r, /\(410\)/)
  assert.match(r, /end of life/)
  assert.doesNotMatch(r, /مرفوض/)
})

test('failureReason: 401 ← المفتاح مرفوض؛ و status على الكائن يُقدَّم', () => {
  assert.match(failureReason(Object.assign(new Error('x'), { status: 401 })), /المفتاح مرفوض \(401\)/)
  assert.match(failureReason(new Error('Gemini HTTP 429: {"error":{"message":"quota"}}')), /تجاوز حد الاستخدام \(429\) quota/)
})

test('حقائق البوت تذكر النموذج الفعلي (لا "Gemini" من الذاكرة)', async () => {
  const { capabilitiesForPrompt } = await import('./capabilities.js')
  const txt = capabilitiesForPrompt({ githubConnected: true, githubOwner: 'x', projects: [], selfRepo: 'r', telegram: 'bound',
    whatsapp: { status: 'connected', banned: false }, sendMode: 'link', version: null, recentJobs: [],
    llm: { primary: 'NVIDIA (nvidia/nemotron-3-super-120b-a12b)', fallback: 'Google Gemini (gemini-3.8-flash)', lastServed: 'nvidia (nvidia/nemotron-3-super-120b-a12b)' } } as any)
  assert.match(txt, /الأساسي NVIDIA \(nvidia\/nemotron-3-super-120b-a12b\)/)
  assert.match(txt, /آخر رد فعلي جاء من: nvidia/)
})

test('isModelQuestion: أسئلة المالك الفعلية عن النموذج تُلتقط، والطلبات العادية لا', async () => {
  const { isModelQuestion } = await import('./assistant.js')
  for (const q of ['اي مودل انت؟', 'انت اي نموذج؟', 'ايش المودل تبعك؟', 'ايش المودل الان ؟', 'انت الان نيفيديا ؟', 'اي نموذج شغال', 'على أي نموذج أنت؟', 'ايش المودل حقك'])
    assert.ok(isModelQuestion(q), q)
  for (const q of ['ذكرني بكرة اكلم احمد', 'قارن بين نماذج الذكاء الاصطناعي الجديدة واعطني افضل واحد لمشروع قنديل', 'حالة المشاريع'])
    assert.ok(!isModelQuestion(q), q)
})
