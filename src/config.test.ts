import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig, aiKeyWarning } from './config.js'

test('تحذير المفاتيح: الصوت فقط حين يوجد مزوّد نصي آخر؛ لا ادعاء بتعطّل الفهم مع Claude/OpenAI', () => {
  assert.equal(aiKeyWarning(loadConfig({ GEMINI_API_KEY: 'g' } as any)), null)
  assert.equal(aiKeyWarning(loadConfig({ GROQ_API_KEY: 'q' } as any)), null)
  for (const env of [{ ANTHROPIC_API_KEY: 'a' }, { OPENAI_API_KEY: 'o' }, { NVIDIA_API_KEY: 'n' }]) {
    const w = aiKeyWarning(loadConfig(env as any))!
    assert.match(w, /الصوت معطّل/)
    assert.doesNotMatch(w, /الفهم والصوت معطلان/)
  }
  assert.match(aiKeyWarning(loadConfig({} as any))!, /الفهم والصوت معطلان/)
})
