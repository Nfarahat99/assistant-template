import { ACTIVE, FAILED, type RailwayClient } from '../clients/railway.js'
import type { Hosting, HostingStatus } from './types.js'

export function railwayHosting(rw: RailwayClient, ids: { serviceId: string; environmentId: string }): Hosting {
  return {
    provider: 'railway',
    async status(): Promise<HostingStatus> {
      const [d] = await rw.deployments(ids.serviceId, ids.environmentId, 1)
      if (!d) return { state: 'unknown', commit: null, deployedAt: null }
      const state = d.status === 'SUCCESS' ? 'running' : FAILED.includes(d.status) ? 'failed' : ACTIVE.includes(d.status) ? 'deploying' : 'unknown'
      return { state, commit: d.commitHash, deployedAt: d.createdAt, detail: d.status }
    },
    async logs(lines = 50) {
      const [d] = await rw.deployments(ids.serviceId, ids.environmentId, 1)
      if (!d) return []
      return (await rw.logs(d.id, 'deploy', lines)).slice(-lines).map((l) => l.message)
    },
    async redeploy() {
      try {
        await rw.redeploy(ids.serviceId, ids.environmentId)
        return { ok: true, message: 'بدأت إعادة النشر' }
      } catch (err: any) {
        return { ok: false, message: `Railway رفض إعادة النشر: ${String(err?.message ?? err).slice(0, 150)}` }
      }
    },
  }
}
