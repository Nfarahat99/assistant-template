import { test } from 'node:test'
import assert from 'node:assert/strict'
import { railwayHosting } from './railway.js'
import { noneHosting } from './none.js'

const deployment = (status: string) => ({ id: 'd1', status, createdAt: '2026-10-14T10:00:00Z', commitHash: 'abc1234', commitMessage: 'm', url: null })
const ids = { serviceId: 's', environmentId: 'e' }

test('railway adapter maps SUCCESS to running with commit', async () => {
  const calls: any[] = []
  const rw: any = {
    deployments: async () => [deployment('SUCCESS')],
    logs: async (id: string, kind: string) => { calls.push([id, kind]); return [{ message: 'ok', severity: 'info', timestamp: null }] },
    redeploy: async () => {},
  }
  const h = railwayHosting(rw, ids)
  const s = await h.status()
  assert.equal(s.state, 'running')
  assert.equal(s.commit, 'abc1234')
  assert.deepEqual(await h.logs(5), ['ok'])
  assert.deepEqual(calls[0], ['d1', 'deploy'])
  assert.equal((await h.redeploy()).ok, true)
})

test('railway adapter maps CRASHED to failed and BUILDING to deploying', async () => {
  for (const [st, want] of [['CRASHED', 'failed'], ['BUILDING', 'deploying']] as const) {
    const rw: any = { deployments: async () => [deployment(st)] }
    assert.equal((await railwayHosting(rw, ids).status()).state, want)
  }
})

test('railway adapter reports a rejected redeploy as not ok', async () => {
  const rw: any = { redeploy: async () => { throw new Error('nope') } }
  assert.equal((await railwayHosting(rw, ids).redeploy()).ok, false)
})

test('none adapter is honest', async () => {
  const h = noneHosting()
  assert.equal((await h.status()).state, 'unknown')
  assert.deepEqual(await h.logs(), [])
  assert.equal((await h.redeploy()).ok, false)
})
