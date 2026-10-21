import type { Store, CodeJob } from './store.js'
import type { RailwayClient, RwService, RwDeployment } from './clients/railway.js'
import { ACTIVE, FAILED, SUPERSEDED, STATUS_AR, errorLines } from './clients/railway.js'
import { formatWhen } from './lib/time.js'
import { logger } from './logger.js'
import { isSelfRepo } from './projects.js'

/**
 * بعد دمج PR: هل انتشر فعلاً؟
 *  - الخدمات = كل خدمات Railway التي source.repo === owner/repo (قد تكون أكثر من خدمة، مثل web + solver)
 *  - كل ٢٠ث حتى ٢٠ دقيقة: نبحث عن نشر meta.commitHash === sha الدمج
 *  - 🚀 بدأ ← ✅ نجح + فحص صحة (الدومين: /health ثم /، المتوقع < 500) أو ❌ فشل + سطور الأخطاء + "أعد المحاولة؟ نعم N"
 *  - لا خدمة مربوطة بـ GitHub = "ما ينشر تلقائياً"؛ لا نشر خلال ٣ دقائق = تنبيه
 * الحالة في code_jobs.deploy_state فتستأنف بعد إعادة التشغيل.
 */
export const DEPLOY_POLL_MS = 20_000
export const DEPLOY_NO_START_MS = 3 * 60_000
export const DEPLOY_TIMEOUT_MS = 20 * 60_000
/** نشر REMOVED بلا نشر أحدث ظاهر: ننتظر هالمدة (قد يظهر الأحدث في الاستطلاع التالي) قبل الحكم */
export const REMOVED_GRACE_MS = 2 * 60_000

type SvcState = {
  name: string; status: string; deploymentId?: string; started?: boolean; noStartWarned?: boolean; done?: boolean; domain?: string | null
  /** النشر الأصلي استُبدل (REMOVED) — نتابع هذا النشر الأحدث بمعرّفه */
  followId?: string; followSha?: string | null; supersededNoted?: boolean; removedSince?: number
}

export interface DeployDeps {
  store: Store
  railway: RailwayClient
  /** pendingIds: طلبات عُرضت معاينتها في هذه الرسالة (لتسجيل وقت الإرسال + أزرار تيليجرام) */
  say: (text: string, pendingIds?: number[]) => Promise<unknown>
  offerRedeploy: (p: { service: RwService; job: string }) => Promise<{ text: string; pendingId: number }>
  now: () => Date
  tz: string
  httpGet?: (url: string) => Promise<number>
  /** المشروع في projects.json مذكور له railway_project (للتمييز بين "غير مربوط" و"غير موجود") */
  railwayProjectFor?: (repo: string) => string | null
}

const defaultGet = async (url: string) => (await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) })).status

export const sameCommit = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && (a.startsWith(b) || b.startsWith(a))

export class DeployWatcher {
  constructor(private d: DeployDeps) {}

  /** خدمات مربوطة بمستودع */
  static servicesFor(all: RwService[], repo: string) {
    return all.filter((s) => s.repo?.toLowerCase() === repo.toLowerCase())
  }

  async poll() {
    const jobs = await this.d.store.watchedDeploys()
    if (!jobs.length) return
    let all: RwService[]
    try { all = await this.d.railway.listServices() } catch (err) {
      logger.warn({ err: String(err) }, 'تعذّر قراءة Railway')
      return
    }
    for (const job of jobs) await this.check(job, all, jobs).catch((err) => logger.error({ err }, 'فشل متابعة نشر'))
  }

  /**
   * رسالة مرة واحدة فقط لكل مفتاح — حتى لو اشتغلت نسختان من البوت معاً أثناء نشره (Railway يبقي القديمة
   * شغالة لين تجهز الجديدة) فما تطلع "🚀 بدأ النشر" مرتين.
   */
  private async once(key: string, text: string, ids?: number[]) {
    const kv = this.d.store as Partial<Pick<Store, 'claimKv'>>
    if (kv.claimKv && !(await kv.claimKv(`deploy_msg:${key}`, '1'))) return
    await this.d.say(text, ids)
  }

  private async check(job: CodeJob, all: RwService[], watched: CodeJob[] = []) {
    const now = this.d.now()
    const sha = job.merge_sha!
    const since = now.getTime() - (job.merged_at?.getTime() ?? now.getTime())
    const services = DeployWatcher.servicesFor(all, job.repo)

    if (!services.length) {
      // غير مربوط بـ GitHub: موجود على Railway باسم المشروع لكن مصدره رفع يدوي (cli) — أو غير موجود أصلاً
      const rp = this.d.railwayProjectFor?.(job.repo)
      const manual = all.filter((s) => !s.repo && rp && s.projectName.toLowerCase() === rp.toLowerCase())
      await this.d.store.updateDeploy(job.request_id, { deploy_status: manual.length ? 'not_connected' : 'none' })
      await this.d.say(manual.length
        ? `⚠️ ${job.project} ما ينشر تلقائياً (الخدمة ${manual.map((s) => s.serviceName).join('، ')} على Railway مرفوعة يدوياً) — الدمج تم في GitHub بس الموقع ما تغير.\nتبي أسجلها مهمة؟ اكتب: أضف مهمة انشر ${job.project} من اللابتوب`
        : `ℹ️ ما لقيت خدمة على Railway مربوطة بـ ${job.repo} — الدمج تم في GitHub، وما عندي طريقة أتأكد من النشر.`)
      return
    }

    const state: Record<string, SvcState> = { ...(job.deploy_state ?? {}) }
    for (const s of services) {
      const st: SvcState = state[s.serviceId] ?? { name: s.serviceName, status: 'pending', domain: s.domains[0] ?? null }
      state[s.serviceId] = st
      if (st.done) continue
      let deps: RwDeployment[] = []
      try { deps = await this.d.railway.deployments(s.serviceId, s.environmentId, 10) } catch (err) {
        logger.warn({ err: String(err) }, 'تعذّر قراءة النشرات')
        continue
      }
      deps = [...deps].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
      const key = `${job.request_id}:${s.serviceId}`
      let dep = st.followId ? deps.find((x) => x.id === st.followId) : undefined
      if (!dep) {
        const mine = deps.filter((x) => sameCommit(x.commitHash, sha))
        dep = mine.find((x) => !SUPERSEDED.includes(x.status)) ?? mine[0]
      }
      if (!dep) {
        if (since > DEPLOY_NO_START_MS && !st.noStartWarned) {
          st.noStartWarned = true
          await this.d.say(`⚠️ مرّت ٣ دقايق وما بدأ نشر لـ ${s.serviceName} (${job.project}) على آخر دمج. تأكد إن النشر التلقائي مفعّل للفرع ${job.default_branch}.`)
        }
        continue
      }
      // REMOVED/SKIPPED ≠ فشل نهائي ولا "حذف": غالباً نشر أحدث حلّ محله — نتابع الأحدث ونبلّغ بنتيجته
      if (SUPERSEDED.includes(dep.status)) {
        const base = dep
        const next = deps.find((x) => x.id !== base.id && String(x.createdAt) > String(base.createdAt) && !SUPERSEDED.includes(x.status))
        if (next) {
          const sameSha = sameCommit(next.commitHash, sha)
          // النشر الأحدث يخص دمجاً آخر نتابعه أصلاً ← هو اللي يبلّغ بالنتيجة (لا رسالتين لنفس النشر)
          const other = !sameSha && watched.some((j) => j.request_id !== job.request_id && sameCommit(j.merge_sha, next.commitHash))
          if (!st.supersededNoted) {
            st.supersededNoted = true
            await this.once(`${key}:superseded`, `↪️ نشر ${s.serviceName} (${job.project}) على commit ${sha.slice(0, 7)} استُبدل بنشر أحدث${!sameSha && next.commitHash ? ` (commit ${next.commitHash.slice(0, 7)})` : ''} — هذا طبيعي في Railway وما انحذف شي. ${other ? 'نتيجته توصلك مع متابعة الدمج الأحدث.' : 'أتابع النشر الأحدث وأعلمك بنتيجته.'}`)
          }
          if (other) { st.done = true; st.status = 'SUPERSEDED'; continue }
          st.followId = next.id
          st.followSha = next.commitHash
          dep = next
        } else {
          st.removedSince ??= now.getTime()
          st.status = dep.status
          if (now.getTime() - st.removedSince < REMOVED_GRACE_MS) continue
          st.done = true
          const live = s.latest && !SUPERSEDED.includes(s.latest.status) ? s.latest : null
          await this.once(`${key}:final`, `ℹ️ نشر ${s.serviceName} (${job.project}) على commit ${sha.slice(0, 7)} ما اكتمل — Railway ${dep.status === 'SKIPPED' ? 'تخطّاه' : 'استبدله أو ألغاه'} (هذا مو حذف للمشروع ولا للخدمة).${live ? ` الشغّال الحين: ${STATUS_AR[live.status] ?? live.status}${live.commitHash ? ` على commit ${live.commitHash.slice(0, 7)}` : ''}.` : ''}`)
          continue
        }
      }
      st.deploymentId = dep.id
      st.status = dep.status
      const via = st.followId && st.followSha && !sameCommit(st.followSha, sha) ? ` (عبر النشر الأحدث commit ${st.followSha.slice(0, 7)})` : ''
      if (ACTIVE.includes(dep.status) && !st.started) {
        st.started = true
        await this.once(`${key}:started`, `🚀 بدأ النشر على ${s.serviceName} (${job.project})…`)
      } else if (dep.status === 'SUCCESS') {
        st.done = true
        const domain = st.domain ?? (dep.url ? dep.url.replace(/^https?:\/\//, '') : null)
        const health = domain ? await this.health(domain) : null
        // البوت نفسه: النسخة الجديدة تعلن عن نفسها بعد الإقلاع (announceVersionIfNew)
        if (!isSelfRepo(job.repo)) await this.once(`${key}:final`, `✅ انتشر بنجاح على ${s.serviceName}${domain ? ` (${domain})` : ''}${via}${health ? ` — الفحص: ${health}` : ''}`)
      } else if (FAILED.includes(dep.status)) {
        st.done = true
        const lines = await this.failureLines(dep.id)
        const offer = await this.d.offerRedeploy({ service: s, job: job.request_id })
        await this.d.say(`❌ فشل النشر على ${s.serviceName} (${job.project})${via} — النسخة القديمة لسا شغالة.${lines.length ? `\n\n${lines.join('\n')}` : ''}\n\nأعد المحاولة؟\n${offer.text}`, [offer.pendingId])
      }
    }

    const states = Object.values(state)
    const allDone = states.length > 0 && states.every((x) => x.done)
    let status = allDone
      ? (states.some((x) => FAILED.includes(x.status as any)) ? 'failed' : 'success')
      : states.some((x) => x.started) ? 'deploying' : 'pending'
    if (!allDone && since > DEPLOY_TIMEOUT_MS) {
      status = 'timeout'
      await this.d.say(`⌛ نشر ${job.project} طوّل أكثر من ٢٠ دقيقة — ${states.filter((x) => !x.done).map((x) => `${x.name}: ${STATUS_AR[x.status] ?? x.status}`).join('، ')}. راجع Railway.`)
    }
    const first = services[0]
    await this.d.store.updateDeploy(job.request_id, {
      deploy_status: status, deploy_state: state,
      deploy_id: state[first.serviceId]?.deploymentId ?? null,
      deploy_url: state[first.serviceId]?.domain ? `https://${state[first.serviceId].domain}` : null,
    })
  }

  /** فحص سريع: /health ثم / — المقبول < 500 */
  private async health(domain: string): Promise<string> {
    const get = this.d.httpGet ?? defaultGet
    for (const path of ['/health', '/']) {
      try {
        const code = await get(`https://${domain}${path}`)
        if (code === 404 && path === '/health') continue
        return code < 500 ? `${path} ${code} ✅` : `${path} ${code} ⚠️`
      } catch (err) {
        return `ما رد (${String((err as any)?.name ?? err)}) ⚠️`
      }
    }
    return 'ما قدرت أفحص'
  }

  private async failureLines(deploymentId: string): Promise<string[]> {
    const logs = [
      ...(await this.d.railway.logs(deploymentId, 'build', 300).catch(() => [])),
      ...(await this.d.railway.logs(deploymentId, 'deploy', 200).catch(() => [])),
    ]
    return errorLines(logs, 15).map((l) => (l.length > 200 ? l.slice(0, 200) + '…' : l))
  }
}

/** "حالة ريلوي" / railway_check: الخدمات بحالة آخر نشر ووقته والـ commit والنشر التلقائي */
export function formatServices(list: RwService[], now: Date, tz: string, title = '🚂 Railway'): string {
  if (!list.length) return 'ما لقيت خدمات على Railway بهذا الاسم 🤔'
  const byProject = new Map<string, RwService[]>()
  for (const s of list) byProject.set(s.projectName, [...(byProject.get(s.projectName) ?? []), s])
  const lines = [title]
  for (const [p, svcs] of byProject) {
    lines.push(`\n📦 ${p}`)
    for (const s of svcs) {
      const l = s.latest
      lines.push(`• ${s.serviceName} — ${l ? STATUS_AR[l.status] ?? l.status : 'بلا نشر'}${l ? ` (${formatWhen(new Date(l.createdAt), now, tz)})` : ''}`)
      if (l?.commitHash) lines.push(`  commit ${l.commitHash.slice(0, 7)}${l.commitMessage ? ` — ${l.commitMessage.split('\n')[0].slice(0, 60)}` : ''}`)
      lines.push(`  نشر تلقائي: ${s.repo ? `نعم (${s.repo})` : 'لا (رفع يدوي)'}${s.domains[0] ? ` · ${s.domains[0]}` : ''}`)
    }
  }
  return lines.join('\n')
}

export function deployStatusAr(j: Pick<CodeJob, 'deploy_status' | 'deploy_url'>): string | null {
  const m: Record<string, string> = {
    pending: '⏳ ينتظر بدء النشر', deploying: '🚀 يُنشر', success: '✅ انتشر', failed: '❌ فشل النشر',
    not_connected: '⚠️ ما ينشر تلقائياً', timeout: '⌛ النشر طوّل', none: 'ℹ️ بلا خدمة Railway',
  }
  return j.deploy_status ? `${m[j.deploy_status] ?? j.deploy_status}${j.deploy_url ? ` ${j.deploy_url}` : ''}` : null
}
