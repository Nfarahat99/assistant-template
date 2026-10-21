import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Db } from '../db/index.js'

/**
 * مصادقة لوحة التحكم: كلمة مرور واحدة (DASHBOARD_PASSWORD) ← جلسة عشوائية.
 *  - الرمز يُخزَّن مجزّأً (sha256) فقط — تسريب القاعدة لا يكشف جلسات صالحة.
 *  - كل جلسة مربوطة ببصمة كلمة المرور: تغيير DASHBOARD_PASSWORD يُبطل كل الجلسات القديمة.
 *  - قفل المحاولات: 10 فشل خلال 15 دقيقة لكل IP ← 429، وسقف عام يحمي من تدوير العناوين.
 */
export const SESSION_COOKIE = 'dash_sid'
export const SESSION_TTL_MS = 30 * 86_400_000
export const LOCK_WINDOW_MS = 15 * 60_000
export const LOCK_MAX_PER_IP = 10
export const LOCK_MAX_GLOBAL = 100

export const DASH_SCHEMA = `
CREATE TABLE IF NOT EXISTS dash_sessions (
  token_hash  TEXT PRIMARY KEY,
  pw_fp       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS dash_sessions_exp_idx ON dash_sessions (expires_at);
`

const sha256 = (s: string) => createHash('sha256').update(s).digest()
const hex = (s: string) => sha256(s).toString('hex')

/** مقارنة بزمن ثابت بغض النظر عن الطول (نقارن الملخّصين) */
export function passwordMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false
  return timingSafeEqual(sha256(`dash:${given}`), sha256(`dash:${expected}`))
}

/** IP العميل: على ريلواي آخر قيمة في X-Forwarded-For أضافها الوكيل نفسه (لا ما أرسله العميل) */
export function clientIp(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff.join(',') : xff
  const last = raw?.split(',').map((s) => s.trim()).filter(Boolean).pop()
  return last || req.ip || 'unknown'
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return null
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${token}; Path=/api/dash; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}`
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/api/dash; HttpOnly; Secure; SameSite=Strict; Max-Age=0`

/** قفل المحاولات في الذاكرة — يكفي لنسخة واحدة؛ إعادة التشغيل تمسحه (مقبول) */
export class LoginLimiter {
  private byIp = new Map<string, number[]>()
  private global: number[] = []
  constructor(private now: () => number = Date.now) {}

  private prune(list: number[]) {
    const cut = this.now() - LOCK_WINDOW_MS
    while (list.length && list[0] <= cut) list.shift()
    return list
  }
  /** ثوانٍ حتى فك القفل، أو 0 إن لم يكن مقفلاً */
  lockedFor(ip: string): number {
    const mine = this.prune(this.byIp.get(ip) ?? [])
    const all = this.prune(this.global)
    const oldest = mine.length >= LOCK_MAX_PER_IP ? mine[0] : all.length >= LOCK_MAX_GLOBAL ? all[0] : null
    return oldest === null ? 0 : Math.max(1, Math.ceil((oldest + LOCK_WINDOW_MS - this.now()) / 1000))
  }
  fail(ip: string) {
    const t = this.now()
    const mine = this.byIp.get(ip) ?? []
    mine.push(t); this.byIp.set(ip, mine)
    this.global.push(t)
    if (this.byIp.size > 5000) for (const [k, v] of this.byIp) if (!this.prune(v).length) this.byIp.delete(k)
  }
  success(ip: string) { this.byIp.delete(ip) }
}

export class SessionStore {
  private readonly fp: string
  constructor(private db: Db, password: string, private now: () => Date = () => new Date()) {
    this.fp = hex(`fp:${password}`).slice(0, 32)
  }

  async create(ip: string): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    await this.db.query(`DELETE FROM dash_sessions WHERE expires_at <= $1`, [now])
    await this.db.query(
      `INSERT INTO dash_sessions (token_hash, pw_fp, created_at, expires_at, last_seen, ip) VALUES ($1,$2,$3,$4,$3,$5)`,
      [hex(token), this.fp, now, new Date(now.getTime() + SESSION_TTL_MS), ip])
    return token
  }

  async valid(token: string | null): Promise<boolean> {
    if (!token || token.length > 200) return false
    const now = this.now()
    const rows = await this.db.query(
      `UPDATE dash_sessions SET last_seen=$3 WHERE token_hash=$1 AND pw_fp=$2 AND expires_at > $3 RETURNING token_hash`,
      [hex(token), this.fp, now])
    return rows.length === 1
  }

  async destroy(token: string | null) {
    if (token) await this.db.query(`DELETE FROM dash_sessions WHERE token_hash=$1`, [hex(token)])
  }
}
