import { createHmac, timingSafeEqual } from 'node:crypto'

/** يحسب التوقيع بنفس صيغة الوسيط: sha256=<hex> */
export function signBody(raw: Buffer | string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex')
}

/**
 * يتحقق من توقيع الويبهوك فوق الجسم الخام (لا بعد JSON.parse — أي إعادة تسلسل تكسر البصمة).
 * المقارنة بزمن ثابت لمنع هجمات التوقيت.
 */
export function verifySignature(raw: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim())
  if (!m) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  const given = Buffer.from(m[1], 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
