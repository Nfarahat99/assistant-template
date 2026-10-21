import Anthropic from '@anthropic-ai/sdk'
import { HttpError, metered, type LlmClient } from './providers.js'

/**
 * Claude عبر SDK الرسمي. maxRetries=0: إعادة المحاولة والاحتياط تتولاها سلسلة الأدوار (router).
 * الرفض (stop_reason=refusal) يُعامل كخطأ 451 لينتقل للمزوّد التالي في السلسلة.
 */
export function anthropicLlm(apiKey: string, model: () => string): LlmClient {
  // fetch يُقرأ عند كل طلب (الـ SDK يلتقط fetch العام وقت الإنشاء) — يبقى متسقاً مع بقية المزوّدين ومع الاختبارات
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 120_000, fetch: (...a) => globalThis.fetch(...a) })

  async function run(system: string, content: Anthropic.MessageParam['content']): Promise<string> {
    const m = model()
    // metered: يسجّل الاستهلاك ويضبط served (المزوّد/النموذج الذي أجاب فعلاً) كبقية المزوّدين
    return metered('anthropic', m, async () => {
      try {
        const res = await client.messages.create({
          model: m,
          max_tokens: 16000,
          system,
          messages: [{ role: 'user', content }],
        })
        if (res.stop_reason === 'refusal') throw new HttpError('anthropic: refusal', 451)
        const value = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('')
        return { value, input_tokens: res.usage?.input_tokens ?? 0, output_tokens: res.usage?.output_tokens ?? 0 }
      } catch (err) {
        if (err instanceof HttpError) throw err
        if (err instanceof Anthropic.APIError) throw new HttpError(`anthropic ${err.status}: ${err.message}`, err.status ?? 500)
        throw err
      }
    })
  }

  return {
    complete: (system, user) => run(system, user),
    completeWithMedia: (system, user, media) => run(system, [
      { type: 'image', source: { type: 'base64', media_type: media.mimetype.split(';')[0].trim() as Anthropic.Base64ImageSource['media_type'], data: media.base64 } },
      { type: 'text', text: user },
    ]),
  }
}
