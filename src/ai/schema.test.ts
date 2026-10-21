import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLlmOutput } from './schema.js'

test('مخرج صالح بعدة إجراءات', () => {
  const r = parseLlmOutput(JSON.stringify({
    actions: [
      { type: 'set_reminder', text: 'أرسل العرض لسامي', at: '2026-09-29T09:00:00+03:00' },
      { type: 'add_task', title: 'مراجعة العقد', priority: 'high', due_at: null },
      { type: 'send_whatsapp', contact_query: 'أحمد', text: 'بتأخر شوي' },
    ],
    reply: 'أبشر',
  }))
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.value.actions.length, 3)
    assert.equal((r.value.actions[1] as any).due_at, undefined)   // null → undefined
  }
})

test('JSON داخل ```json``` يُستخرج', () => {
  const r = parseLlmOutput('```json\n{"actions":[{"type":"answer","text":"هلا"}],"reply":""}\n```')
  assert.equal(r.ok, true)
})

test('نوع إجراء غير معروف يُرفض', () => {
  const r = parseLlmOutput('{"actions":[{"type":"delete_everything"}],"reply":"تم"}')
  assert.equal(r.ok, false)
})

test('حقل إلزامي ناقص يُرفض (send_whatsapp بلا نص)', () => {
  const r = parseLlmOutput('{"actions":[{"type":"send_whatsapp","contact_query":"أحمد"}],"reply":""}')
  assert.equal(r.ok, false)
})

test('complete_task يحتاج task_id أو query', () => {
  assert.equal(parseLlmOutput('{"actions":[{"type":"complete_task"}],"reply":"x"}').ok, false)
  assert.equal(parseLlmOutput('{"actions":[{"type":"complete_task","task_id":"3"}],"reply":""}').ok, true)
})

test('نص ليس JSON يُرفض', () => {
  assert.equal(parseLlmOutput('أبشر طال عمرك').ok, false)
})

test('رد فارغ بلا إجراءات يُرفض', () => {
  assert.equal(parseLlmOutput('{"actions":[],"reply":"  "}').ok, false)
})

test('فلتر قائمة غير معروف يسقط لـ all', () => {
  const r = parseLlmOutput('{"actions":[{"type":"list_tasks","filter":"tomorrow"}],"reply":""}')
  assert.equal(r.ok && (r.value.actions[0] as any).filter, 'all')
})
