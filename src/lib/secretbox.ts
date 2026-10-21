import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export class SecretboxError extends Error {}
export const isValidKey = (keyHex: string) => /^[0-9a-f]{64}$/i.test(keyHex)

function key(keyHex: string): Buffer {
  if (!isValidKey(keyHex)) throw new SecretboxError('SECRETS_KEY لازم 64 خانة hex')
  return Buffer.from(keyHex, 'hex')
}

export function seal(plain: string, keyHex: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(keyHex), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':')
}

export function open(sealed: string, keyHex: string): string {
  const parts = sealed.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new SecretboxError('صيغة غير معروفة')
  try {
    const d = createDecipheriv('aes-256-gcm', key(keyHex), Buffer.from(parts[1], 'base64'))
    d.setAuthTag(Buffer.from(parts[2], 'base64'))
    return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8')
  } catch (e) {
    if (e instanceof SecretboxError) throw e
    throw new SecretboxError('فشل فك التشفير (مفتاح خاطئ أو بيانات معدّلة)')
  }
}
