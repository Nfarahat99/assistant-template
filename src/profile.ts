import { readFileSync } from 'node:fs'
import { z } from 'zod'

/**
 * هوية المالك والمساعد — المصدر الوحيد (assistant.config.json).
 * لا يقرأ أحد الملف غير هذا الموديول؛ الباقي يستخدم profile().
 */
const REPO = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'لازم بصيغة owner/name')

export const ProfileSchema = z.object({
  owner: z.object({
    name: z.string().trim().min(1),
    phone: z.string().regex(/^\d{8,15}$/).optional(),
  }),
  assistant: z.object({ name: z.string().trim().min(1) }),
  language: z.enum(['ar', 'en']).default('ar'),
  timezone: z.literal('Asia/Riyadh', { message: 'المرحلة 1 تدعم Asia/Riyadh فقط' }).default('Asia/Riyadh'),
  /** أيام الدوام: 0=الأحد … 6=السبت */
  workweek: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4]),
  signature: z.string().max(80).default(''),
  user_type: z.enum(['programmer', 'non_programmer']),
  github: z.object({
    owner: z.string().trim().min(1),
    self_repo: REPO,
    default_branch: z.string().trim().min(1).default('main'),
    template_repo: REPO.optional(),
    /** owner/repo/path لملف projects.json بعيد (للمبرمج فقط) */
    projects_remote: z.string().optional(),
    /** مستودع إعدادات Claude (اختياري — المبرمج فقط) */
    claude_config_repo: REPO.optional(),
  }),
  /** أسماء بديلة لمستودع المساعد نفسه ("البوت"، "نفسك" تضاف تلقائياً) */
  self_aliases: z.array(z.string()).default([]),
  /** اهتمامات المالك (لموجز الأخبار والبحث) — نص حر */
  interests: z.string().default(''),
  hosting: z.object({
    provider: z.enum(['railway', 'none']).default('railway'),
    railway_project: z.string().optional(),
  }).default({ provider: 'railway' }),
  /** أرقام يُسمح للبوت يراسلها مباشرة حتى في وضع link */
  direct_send_allowlist: z.array(z.string().regex(/^\d{8,15}$/)).default([]),
})
export type Profile = z.infer<typeof ProfileSchema>

export class ProfileError extends Error {}

/** قيم المثال الموجودة في assistant.config.example.json — وجودها يعني أن المقابلة التقنية لم تُشغَّل */
export const PROFILE_PLACEHOLDERS = { owner: 'اسم المالك', repo: 'github-user/my-assistant' } as const

/** يتحقق من كائن الإعدادات (zod + رفض القيم التجريبية). `source` للرسائل فقط. */
export function parseProfile(raw: unknown, source: string): Profile {
  const r = ProfileSchema.safeParse(raw)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new ProfileError(`خطأ في ${source} / invalid config: ${i.path.join('.') || '(root)'}: ${i.message}`)
  }
  if (r.data.owner.name === PROFILE_PLACEHOLDERS.owner || r.data.github.self_repo === PROFILE_PLACEHOLDERS.repo) {
    throw new ProfileError(`${source} لسا على القيم التجريبية — شغّل المقابلة التقنية (onboarding/interview.md) في Claude Code / config still has example values`)
  }
  return r.data
}

export function loadProfile(path = process.env.ASSISTANT_CONFIG || './assistant.config.json'): Profile {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch {
    throw new ProfileError(`ملف الإعدادات غير موجود / config file not found: ${path}`)
  }
  let json: unknown
  try { json = JSON.parse(raw) } catch (e) {
    throw new ProfileError(`ملف الإعدادات ليس JSON صالح / invalid JSON in ${path}: ${(e as Error).message}`)
  }
  return parseProfile(json, path)
}

let active: Profile | null = null
export function setProfile(p: Profile): void { active = p }
export function profile(): Profile {
  if (!active) throw new Error('profile not loaded')
  return active
}
export const ownerName = () => profile().owner.name
export const assistantName = () => profile().assistant.name
export const isProgrammer = () => profile().user_type === 'programmer'
