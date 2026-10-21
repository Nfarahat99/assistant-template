import type { Store } from './store.js'
import type { RailwayClient, RwService } from './clients/railway.js'
import { FAILED, STATUS_AR } from './clients/railway.js'
import { logger } from './logger.js'

/**
 * مراقبة دورية لخدمات وقواعد بيانات Railway (قراءة فقط).
 *  - نشر فشل/سقط (FAILED | CRASHED) ← تنبيه فوري مرة واحدة لكل نشر، وإشعار عند التعافي.
 *  - خدمة SUCCESS لها دومين عام: فحص صحة (شبكة أو ≥٥٠٠) — بعد فحصين متتاليين فاشلين ← تنبيه "لا تستجيب".
 *  - قواعد البيانات (postgres/redis/…) خدمات عادية في Railway فتغطيها حالة النشر نفسها.
 * الحالة في kv (railway_monitor) فلا تتكرر التنبيهات بعد إعادة التشغيل. الإصلاح/إعادة النشر يبقى بموافقة المالك.
 */
export const MONITOR_POLL_MS = 2 * 60_000
export const HEALTH_STRIKES = 2
const KV_KEY = 'railway_monitor'

type SvcMem = { alertedDeployment?: string; healthStrikes?: number; healthAlerted?: boolean; wasBad?: boolean }
type Mem = Record<string, SvcMem>

export interface MonitorDeps {
  store: Store
  railway: RailwayClient
  /** تنبيه المالك (فوري) */
  notify: (text: string) => Promise<unknown>
  httpGet?: (url: string) => Promise<number>
  /** قاعدة المالك الدائمة: كل مشروع له مسار قراءة لقاعدته — فحص أسبوعي للمشاريع غير المغطّاة */
  dbCoverage?: DbCoverageDeps
  now?: () => number
}

export interface DbCoverageDeps {
  /** مشاريع Railway المغطّاة (حقل project في DB_CONNECTIONS) */
  coveredProjects: () => string[]
  /** مشاريع لا تخص المالك أو مستثناة (بالاسم) */
  ignoreProjects?: string[]
  /** مشروع البوت نفسه (قاعدته ليست مشروعاً) */
  ownProjectId?: string
}

export const DB_COVERAGE_EVERY_MS = 7 * 24 * 3600_000
const COVERAGE_KV = 'db_coverage_check'
/** صور قواعد بيانات تُقرأ (redis كاش وليس قاعدة بيانات مشروع) */
export const DB_IMAGE_RE = /postgres|postgis|timescale|mysql|mariadb|mongo/i
/** متغيرات تدل على SQLite في خدمة تطبيق */
export const SQLITE_VAR_RE = /^(DATABASE_PATH|SQLITE\w*|\w*_DB_PATH|DB_FILE)$/i

/**
 * المشاريع التي فيها قاعدة بيانات بلا مسار قراءة: خدمة بصورة قاعدة (Postgres/MySQL/Mongo)،
 * أو خدمة تطبيق متغيراتها تدل على SQLite (أسماء المتغيرات فقط عبر details).
 */
export async function uncoveredDbProjects(services: RwService[], railway: Pick<RailwayClient, 'details'>, d: DbCoverageDeps): Promise<{ project: string; kind: 'postgres' | 'mysql' | 'mongo' | 'sqlite' }[]> {
  const covered = new Set(d.coveredProjects().map((p) => p.trim().toLowerCase()).filter(Boolean))
  const ignore = new Set((d.ignoreProjects ?? []).map((p) => p.trim().toLowerCase()))
  const byProject = new Map<string, RwService[]>()
  for (const s of services) {
    if (s.projectId === d.ownProjectId) continue
    const p = s.projectName.trim().toLowerCase()
    if (covered.has(p) || ignore.has(p)) continue
    byProject.set(s.projectName, [...(byProject.get(s.projectName) ?? []), s])
  }
  const out: { project: string; kind: 'postgres' | 'mysql' | 'mongo' | 'sqlite' }[] = []
  for (const [project, svcs] of byProject) {
    const img = svcs.map((s) => s.image ?? '').find((i) => DB_IMAGE_RE.test(i))
    if (img) { out.push({ project, kind: /mysql|mariadb/i.test(img) ? 'mysql' : /mongo/i.test(img) ? 'mongo' : 'postgres' }); continue }
    if (!svcs.some((s) => s.repo)) continue
    try {
      const det = await railway.details(project)
      if (det.some((x) => x.project === project && x.variables.some((v) => SQLITE_VAR_RE.test(v)))) out.push({ project, kind: 'sqlite' })
    } catch { /* فحص أسبوعي — نتجاوز المشروع هذه المرة */ }
  }
  return out
}

const defaultGet = async (url: string) => (await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) })).status

const keyOf = (s: RwService) => `${s.projectId}:${s.serviceId}:${s.environmentId}`
const label = (s: RwService) => `${s.projectName} / ${s.serviceName}${s.environmentName && s.environmentName !== 'production' ? ` (${s.environmentName})` : ''}`

export class RailwayMonitor {
  constructor(private d: MonitorDeps) {}

  private async load(): Promise<Mem> {
    try { return JSON.parse((await this.d.store.getKv(KV_KEY)) || '{}') } catch { return {} }
  }

  /** يرجع نصوص التنبيهات التي أُرسلت (للاختبار والسجل) */
  async poll(): Promise<string[]> {
    const services = await this.d.railway.listServices()
    const mem = await this.load()
    const sent: string[] = []
    const alert = async (text: string) => { sent.push(text); await this.d.notify(text) }
    const get = this.d.httpGet ?? defaultGet

    for (const s of services) {
      const k = keyOf(s)
      const m = (mem[k] ??= {})
      const dep = s.latest
      if (!dep) continue

      // ── نشر فاشل/ساقط ──
      if ((FAILED as string[]).includes(dep.status)) {
        m.wasBad = true
        if (m.alertedDeployment !== dep.id) {
          m.alertedDeployment = dep.id
          await alert(`🚨 ${label(s)}: ${dep.status === 'CRASHED' ? 'الخدمة سقطت' : 'فشل النشر'} (${STATUS_AR[dep.status] ?? dep.status})${dep.commitMessage ? `\n📝 ${dep.commitMessage.split('\n')[0].slice(0, 100)}` : ''}\nقل «حالة ${s.serviceName} في ريلواي» أو «أعد نشر ${s.serviceName} في ${s.projectName}» وأجهّز لك الطلب.`)
        }
        continue
      }

      if (dep.status !== 'SUCCESS') continue   // قيد البناء/النشر/نائمة: لا حكم بعد

      // ── تعافي ──
      if (m.wasBad) {
        m.wasBad = false
        await alert(`✅ ${label(s)}: رجعت تشتغل (آخر نشر ${STATUS_AR.SUCCESS}).`)
      }

      // ── فحص الصحة للخدمات العامة ──
      const domain = s.domains[0]
      if (!domain) continue
      let ok = true
      let why = ''
      try {
        const code = await get(`https://${domain}`)
        if (code >= 500) { ok = false; why = `HTTP ${code}` }
      } catch (err) { ok = false; why = String((err as any)?.message ?? err).slice(0, 80) }
      if (ok) {
        if (m.healthAlerted) await alert(`✅ ${label(s)}: رجع يستجيب (${domain}).`)
        m.healthStrikes = 0
        m.healthAlerted = false
      } else {
        m.healthStrikes = (m.healthStrikes ?? 0) + 1
        if (m.healthStrikes >= HEALTH_STRIKES && !m.healthAlerted) {
          m.healthAlerted = true
          await alert(`🚨 ${label(s)}: النشر ناجح لكن الموقع ما يستجيب (${why}) — ${domain}`)
        }
      }
    }

    // نحذف ذاكرة خدمات اختفت
    const live = new Set(services.map(keyOf))
    for (const k of Object.keys(mem)) if (!live.has(k)) delete mem[k]
    await this.d.store.setKv(KV_KEY, JSON.stringify(mem))
    // فحص أسبوعي منفصل — فشله لا يُسقط المراقبة
    try { const t = await this.dbCoverage(services); if (t) sent.push(t) } catch (err) {
      logger.warn({ err: String((err as any)?.message ?? err).slice(0, 200) }, 'فحص تغطية قواعد البيانات فشل')
    }
    if (sent.length) logger.warn({ count: sent.length }, 'تنبيهات مراقبة Railway')
    return sent
  }

  /** مرة في الأسبوع: مشاريع فيها قاعدة بيانات بلا وصول قراءة ← تنبيه معلوماتي واحد (الإعداد يشغّله القائد: db-onboard) */
  async dbCoverage(services: RwService[]): Promise<string | null> {
    const cov = this.d.dbCoverage
    if (!cov) return null
    const now = this.d.now?.() ?? Date.now()
    const last = Number(await this.d.store.getKv(COVERAGE_KV)) || 0
    if (now - last < DB_COVERAGE_EVERY_MS) return null
    await this.d.store.setKv(COVERAGE_KV, String(now))
    const missing = await uncoveredDbProjects(services, this.d.railway, cov)
    if (!missing.length) return null
    const text = missing.map((m) => `🗄️ ${m.project} بدون وصول قراءة — شغّل الإعداد؟${m.kind === 'sqlite' ? ' (SQLite: يحتاج مسار القراءة في التطبيق)' : ''}`).join('\n')
    await this.d.notify(text)
    return text
  }
}
