import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { GitHubClient } from './clients/github.js'
import { logger } from './logger.js'
import { profile } from './profile.js'

/**
 * نسخة البوت المنشورة — "نسختك" / "آخر تحديث".
 * المصادر بالترتيب: version.json (يكتبه scripts/version.mjs عند الإقلاع من GIT_SHA/RAILWAY_GIT_* أو git)،
 * ثم GitHub API لآخر commit في المستودع إن لم يُعرف الـ sha أو الرسالة.
 */
export interface BuildInfo { sha: string | null; message: string | null; date: string | null; built_at: string | null; source: string }

const here = dirname(fileURLToPath(import.meta.url))
/** مستودع المساعد نفسه — من الملف الشخصي */
export const selfRepo = () => profile().github.self_repo

export async function loadVersion(github: Pick<GitHubClient, 'getCommit'> | null): Promise<BuildInfo> {
  let info: BuildInfo = { sha: null, message: null, date: null, built_at: null, source: 'unknown' }
  try {
    const j = JSON.parse(await readFile(join(here, '..', 'version.json'), 'utf8'))
    info = { sha: j.sha || null, message: j.message || null, date: j.date || null, built_at: j.built_at || null, source: j.source || 'version.json' }
  } catch { /* لا ملف — نكمل */ }
  if ((!info.sha || !info.message) && github?.getCommit) {
    try {
      const c = await github.getCommit(selfRepo(), info.sha || 'main')
      info = { ...info, sha: c.sha, message: c.message, date: c.date, source: info.sha ? info.source : 'github-latest' }
    } catch (err) {
      logger.warn({ err: String(err) }, 'تعذّر جلب آخر commit من GitHub')
    }
  }
  return info
}

export function formatVersion(v: BuildInfo, repo = selfRepo()): string {
  if (!v.sha) return 'ما أعرف نسختي بالضبط 🤷 (لا version.json ولا وصول لـ GitHub)'
  const short = v.sha.slice(0, 7)
  const lines = [`🏷️ نسختي: ${short}${v.source === 'github-latest' ? ' (آخر commit في المستودع — قد لا يكون المنشور بعد)' : ''}`]
  if (v.message) lines.push(`📝 ${v.message.split('\n')[0].slice(0, 200)}`)
  if (v.date) lines.push(`📅 ${v.date}`)
  if (v.built_at) lines.push(`🔨 البناء: ${v.built_at}`)
  lines.push(`https://github.com/${repo}/commit/${v.sha}`)
  return lines.join('\n')
}
