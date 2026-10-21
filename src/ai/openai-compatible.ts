import { HttpError, metered, type LlmClient } from './providers.js'

/** أي مزوّد بواجهة OpenAI chat/completions (OpenRouter، Together، OpenAI…) — fetch مباشر */
export function openaiCompatibleLlm(baseUrl: string, apiKey: string, model: () => string): LlmClient {
  return {
    async complete(system, user) {
      const m = model()
      return metered('openai', m, async () => {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
          signal: AbortSignal.timeout(120_000),
        })
        if (!res.ok) throw new HttpError(`openai-compatible ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status)
        const j: any = await res.json()
        const text = j?.choices?.[0]?.message?.content
        if (typeof text !== 'string') throw new HttpError('openai-compatible: empty response', 502)
        return { value: text, input_tokens: j?.usage?.prompt_tokens ?? 0, output_tokens: j?.usage?.completion_tokens ?? 0 }
      })
    },
  }
}
