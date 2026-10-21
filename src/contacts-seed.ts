import { existsSync, readFileSync } from 'node:fs'
import type { Store } from './store.js'
import { logger } from './logger.js'

/**
 * يقرأ CSV بسيط: name,phone,aliases  (aliases مفصولة بـ | )
 * CONTACTS_CSV إما مسار ملف أو نص CSV مباشرة في المتغير.
 */
export function parseContactsCsv(text: string): { name: string; phone: string; aliases: string[] }[] {
  const out: { name: string; phone: string; aliases: string[] }[] = []
  for (const line of text.replace(/^﻿/, '').split(/\r?\n|;;/)) {
    const cols = line.split(',').map((s) => s.trim())
    if (cols.length < 2 || !cols[0] || !cols[1]) continue
    if (/^name$/i.test(cols[0]) || cols[0] === 'الاسم') continue   // سطر العناوين
    out.push({ name: cols[0], phone: cols[1], aliases: (cols[2] || '').split('|').map((s) => s.trim()).filter(Boolean) })
  }
  return out
}

export async function seedContacts(store: Store, src: string, cc: string) {
  if (!src) return
  const text = existsSync(src) ? readFileSync(src, 'utf8') : src
  const rows = parseContactsCsv(text)
  let ok = 0
  for (const r of rows) if (await store.upsertContact(r.name, r.phone, r.aliases, cc)) ok++
  logger.info(`جهات الاتصال: ${ok}/${rows.length} من CONTACTS_CSV`)
}
