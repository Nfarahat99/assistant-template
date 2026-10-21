import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { localDiskStore, FileTooLargeError } from './local-disk.js'

const dir = () => mkdtempSync(join(tmpdir(), 'fs-'))

test('put/get/delete round-trip with sha256', async () => {
  const s = localDiskStore(dir())
  const data = Buffer.from('عقد المشغلين')
  const f = await s.put(data, { filename: 'عقد.pdf' })
  assert.equal(f.sha256, createHash('sha256').update(data).digest('hex'))
  assert.equal(f.size, data.length)
  assert.ok(f.key.endsWith('.pdf'))
  assert.deepEqual(await s.get(f.key), data)
  await s.delete(f.key)
  await assert.rejects(s.get(f.key))
})

test('keys cannot escape the directory', async () => {
  const s = localDiskStore(dir())
  await assert.rejects(s.get('../../etc/passwd'), /مفتاح غير صالح/)
  await assert.rejects(s.get('/etc/passwd'), /مفتاح غير صالح/)
})

test('filename is never used as a path', async () => {
  const s = localDiskStore(dir())
  const f = await s.put(Buffer.from('x'), { filename: '../../evil.sh' })
  assert.match(f.key, /^[0-9a-f]{2}\/[0-9a-f-]{36}\.sh$/)
})

test('size limit', async () => {
  const s = localDiskStore(dir(), { maxBytes: 4 })
  await assert.rejects(s.put(Buffer.from('12345'), { filename: 'a.txt' }), FileTooLargeError)
})
