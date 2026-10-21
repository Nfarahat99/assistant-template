import type { Hosting } from './types.js'
export const noneHosting = (): Hosting => ({
  provider: 'none',
  status: async () => ({ state: 'unknown', commit: null, deployedAt: null, detail: 'السيرفر غير مربوط' }),
  logs: async () => [],
  redeploy: async () => ({ ok: false, message: 'إعادة النشر غير متاحة — السيرفر غير مربوط' }),
})
