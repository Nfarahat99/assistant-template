import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { extname, join, resolve, sep } from 'node:path'
import type { FileStore, StoredFile } from './types.js'

export class FileTooLargeError extends Error {}
const KEY = /^[0-9a-f]{2}\/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?$/

/** تخزين على قرص السيرفر (Railway volume). المفتاح عشوائي؛ اسم الملف الأصلي لا يدخل المسار أبداً */
export function localDiskStore(dir: string, opts: { maxBytes?: number } = {}): FileStore {
  const root = resolve(dir)
  const max = opts.maxBytes ?? 25 * 1024 * 1024
  const pathOf = (key: string) => {
    if (!KEY.test(key)) throw new Error(`مفتاح غير صالح: ${key}`)
    const p = resolve(root, key)
    if (!p.startsWith(root + sep)) throw new Error(`مفتاح غير صالح: ${key}`)
    return p
  }
  return {
    async put(data, hint): Promise<StoredFile> {
      if (data.length > max) throw new FileTooLargeError(`الملف أكبر من ${Math.round(max / 1024 / 1024)}MB`)
      const ext = extname(hint.filename).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 9)
      const id = randomUUID()
      const key = `${id.slice(0, 2)}/${id}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`
      await mkdir(join(root, id.slice(0, 2)), { recursive: true })
      await writeFile(pathOf(key), data, { flag: 'wx' })
      return { key, sha256: createHash('sha256').update(data).digest('hex'), size: data.length }
    },
    async get(key) {
      try { return await readFile(pathOf(key)) } catch (e) {
        if (e instanceof Error && /مفتاح غير صالح/.test(e.message)) throw e
        throw new Error(`الملف غير موجود: ${key}`)
      }
    },
    async delete(key) { await rm(pathOf(key), { force: true }) },
  }
}
