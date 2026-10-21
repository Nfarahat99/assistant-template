// يكتب version.json عند الإقلاع — من متغيرات البناء (Dockerfile ARG/ENV أو متغيرات ريلواي)، وإلا من git المحلي.
// لا يفشل الإقلاع أبداً: أي خطأ = ملف بقيم فارغة، والبوت يسأل GitHub عند الإقلاع.
import { writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const env = process.env
const git = (cmd) => { try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return '' } }

let sha = env.GIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || ''
let message = env.GIT_MESSAGE || env.RAILWAY_GIT_COMMIT_MESSAGE || ''
let date = env.GIT_DATE || ''
let source = sha ? 'build-env' : ''
if (!sha) {
  sha = git('rev-parse HEAD')
  if (sha) { message = git('log -1 --format=%s'); date = git('log -1 --format=%cI'); source = 'git' }
}
const info = { sha: sha || null, message: message || null, date: date || null, built_at: env.BUILD_TIME || null, source: source || 'unknown' }
try { writeFileSync(new URL('../version.json', import.meta.url), JSON.stringify(info, null, 2)) } catch { /* تجاهل */ }
console.log(`version: ${info.sha ? info.sha.slice(0, 7) : 'unknown'} (${info.source})`)
