import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChatScreenshot, readChatScreenshot } from './ai/third-party.js'

test('تحليل متسامح: رسالة معطوبة لا تُسقط الباقي، ومرادفات from تُقبل', () => {
  const r = parseChatScreenshot({
    contact_name: ' أحمد ',
    messages: [
      { from: 'them', text: 'مرحبا' },
      { from: 'unknown', text: 'غامضة' },
      { sender: 'Me', message: 'هلا' },
      { from: 'them', text: '' },
      null,
      { from: 'incoming', text: 'x'.repeat(3000) },
    ],
  })
  assert.equal(r.contact_name_guess, 'أحمد')
  assert.deepEqual(r.messages.map((m) => m.from), ['them', 'me', 'them'])
  assert.equal(r.messages[2].text.length, 2000)
})

test('مصفوفة مباشرة، وأكثر من ٤٠ رسالة لا تُفقد', () => {
  const arr = Array.from({ length: 60 }, (_, i) => ({ from: 'them', text: `m${i}` }))
  assert.equal(parseChatScreenshot(arr).messages.length, 60)
})

test('readChatScreenshot يعيد المحاولة مرة عند فشل عابر', async () => {
  let n = 0
  const llm: any = {
    completeWithMedia: async () => {
      if (++n === 1) throw new Error('503')
      return '{"messages":[{"from":"them","text":"ok"}]}'
    },
  }
  const r = await readChatScreenshot(llm, { base64: 'x', mimetype: 'image/png' })
  assert.equal(n, 2)
  assert.equal(r?.messages[0].text, 'ok')
})
