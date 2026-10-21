import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signBody, verifySignature } from './hmac.js'

const secret = 's3cret-مفتاح'
const body = Buffer.from(JSON.stringify({ event: 'message', text: 'مرحبا' }))

test('توقيع صحيح يُقبل', () => {
  assert.equal(verifySignature(body, signBody(body, secret), secret), true)
})

test('توقيع بسر مختلف يُرفض', () => {
  assert.equal(verifySignature(body, signBody(body, 'other'), secret), false)
})

test('أي تعديل على الجسم يُسقط التوقيع (حتى مسافة)', () => {
  const sig = signBody(body, secret)
  const tampered = Buffer.from(body.toString().replace('{', '{ '))
  assert.equal(verifySignature(tampered, sig, secret), false)
})

test('ترويسة مفقودة أو بصيغة خاطئة تُرفض بلا استثناء', () => {
  for (const h of [undefined, '', 'abc', 'sha1=' + 'a'.repeat(40), 'sha256=zz', 'sha256=' + 'a'.repeat(63)]) {
    assert.equal(verifySignature(body, h, secret), false, `كان يجب رفض ${h}`)
  }
})

test('سر فارغ = رفض دائماً (لا نقبل ويبهوك بلا إعداد)', () => {
  assert.equal(verifySignature(body, signBody(body, ''), ''), false)
})

test('الحروف الكبيرة في الـ hex مقبولة', () => {
  const sig = signBody(body, secret)
  assert.equal(verifySignature(body, 'sha256=' + sig.slice(7).toUpperCase(), secret), true)
})
