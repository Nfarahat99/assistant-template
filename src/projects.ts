import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { bestMatches, normalizeArabic } from './lib/arabic.js'
import { logger } from './logger.js'
import { isProgrammer, profile } from './profile.js'
import type { GitHubClient } from './clients/github.js'

/** صيغة projects.json — يولّدها وكيل آخر في مستودع claude-config */
export const ProjectSchema = z.object({
  folder: z.string().min(1),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo بصيغة owner/name'),
  default_branch: z.string().min(1).default('main'),
  aliases: z.array(z.string()).default([]),
  railway_project: z.string().nullish(),
  /** ملاحظة حرة من claude-config ("archive"…) — المؤرشف لا يُذكر في متتبّع المشاريع */
  note: z.string().nullish(),
})
export type Project = z.infer<typeof ProjectSchema>

export function parseProjects(json: string): Project[] {
  const arr = JSON.parse(json)
  if (!Array.isArray(arr)) throw new Error('projects.json لازم يكون مصفوفة')
  const out: Project[] = []
  for (const item of arr) {
    const r = ProjectSchema.safeParse(item)
    if (r.success) out.push(r.data)
    else logger.warn({ item, issues: r.error.issues.length }, 'مشروع غير صالح في projects.json — تم تجاهله')
  }
  return out
}

/**
 * البوت نفسه — مدمج دائماً في القائمة، ليقدر المالك يقول "طوّر نفسك" أو "فيك مشكلة"
 * فيقترح البوت code_change على مستودعه بدل أن يدّعي أنه أصلح شيئاً.
 */
const SELF_BASE_ALIASES = ['البوت', 'نفسك', 'المساعد', 'مساعدي']

/** مستودع المساعد نفسه — من الملف الشخصي */
export function selfProject(): Project {
  const p = profile()
  const name = p.github.self_repo.split('/')[1]
  return {
    folder: name,
    repo: p.github.self_repo,
    default_branch: p.github.default_branch,
    aliases: [...new Set([...SELF_BASE_ALIASES, name, ...p.self_aliases])],
    railway_project: p.hosting.railway_project ?? null,
  }
}

/** مستودع إعدادات Claude — للمبرمج فقط وإن حُدد في الملف الشخصي */
export function claudeConfigProject(): Project | null {
  const repo = profile().github.claude_config_repo
  if (!repo) return null
  return { folder: repo.split('/')[1], repo, default_branch: 'main', aliases: ['إعدادات كلود', 'المهارات', repo.split('/')[1]], railway_project: null }
}

/** هل المستودع هو مستودع المساعد نفسه؟ (بلا حساسية لحالة الأحرف) */
export const isSelfRepo = (repo: string): boolean => repo.toLowerCase() === selfProject().repo.toLowerCase()

const builtIns = (): Project[] => [selfProject(), claudeConfigProject()].filter((x): x is Project => !!x)

/** اسم العرض للمالك: أول اسم بديل (عربي غالباً)، وإلا اسم المستودع — لا مسارات محلية أبداً */
export function projectLabel(p: Pick<Project, 'aliases' | 'repo'>): string {
  return p.aliases.find((a) => a.trim()) ?? p.repo.split('/')[1]
}

/** آخر جزء من المسار: "C:/planners" ← "planners" (للمطابقة فقط، لا للعرض) */
const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p

export class ProjectRegistry {
  private list: Project[] = []

  constructor(initial: Project[] = []) { this.set(initial) }

  /** غير المبرمج: مشروع البوت نفسه فقط — لا مشاريع أخرى ولا ملفات */
  all(): Project[] { return isProgrammer() ? this.list : [selfProject()] }
  /** يدمج مدخل البوت نفسه إن لم يكن موجوداً (بنفس المستودع) */
  set(list: Project[]) {
    const built = builtIns()
    const missing = built.filter((b) => !list.some((p) => p.repo.toLowerCase() === b.repo.toLowerCase()))
    // نفس المستودع موجود في projects.json (من claude-config): نكمّل أسماءه البديلة و railway_project من المدمج
    // — وإلا "سراج اسستنت" ما يطابق البوت لأن الملف البعيد ما فيه هالتهجئة
    const merged = list.map((p) => {
      const b = built.find((x) => x.repo.toLowerCase() === p.repo.toLowerCase())
      if (!b) return p
      return { ...p, aliases: [...p.aliases, ...b.aliases.filter((a) => !p.aliases.includes(a))], railway_project: p.railway_project ?? b.railway_project }
    })
    this.list = [...merged, ...missing]
  }

  /** كل الأسماء التي يُعرف بها المشروع: اسم المجلد، اسم المستودع، والأسماء البديلة */
  static names(p: Project): string[] {
    const repoName = p.repo.split('/')[1]
    const variants = [basename(p.folder), repoName, ...p.aliases]
    // "whatsapp-siraj" ← "whatsapp siraj" ليطابق الكلام المنطوق
    return [...new Set(variants.flatMap((v) => [v, v.replace(/[-_.]+/g, ' ')]))]
  }

  /** يرجع كل المرشحين بأعلى درجة — أكثر من واحد يعني غموض */
  resolve(query: string): Project[] {
    const q = normalizeArabic(query)
    if (!q) return []
    return bestMatches(query, this.all().map((p) => ({ p, names: ProjectRegistry.names(p) }))).map((x) => x.p)
  }

  async loadFile(path: string) {
    try {
      this.set(parseProjects(await readFile(path, 'utf8')))
      logger.info(`المشاريع: ${this.list.length} من ${path}`)
    } catch (err) {
      logger.warn({ err: String(err) }, `تعذّر قراءة ${path}`)
    }
  }

  /** "owner/repo/path/to/projects.json" من GitHub — يعلو على الملف المحلي عند نجاحه */
  async loadRemote(gh: GitHubClient, spec: string): Promise<boolean> {
    const [owner, repo, ...rest] = spec.split('/')
    try {
      const list = parseProjects(await gh.getFileContent(`${owner}/${repo}`, rest.join('/')))
      if (list.length) { this.set(list); logger.info(`المشاريع: ${list.length} من GitHub (${spec})`); return true }
    } catch (err) {
      logger.warn({ err: String(err) }, 'تعذّر تحميل projects.json من GitHub — نبقى على المحلي')
    }
    return false
  }
}
