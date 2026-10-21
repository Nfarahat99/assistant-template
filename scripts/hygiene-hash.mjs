// الاستخدام: npx tsx scripts/hygiene-hash.mjs <ملف المصطلحات خارج الريبو>
// يطبع سطر TypeScript لكل مصطلح (hash فقط) للصقه في DENY داخل src/lib/hygiene-deny.ts
import { readFileSync } from 'node:fs'
import { termHash } from '../src/lib/hygiene.ts'

const file = process.argv[2]
if (!file) { console.error('usage: npx tsx scripts/hygiene-hash.mjs <terms-file>'); process.exit(1) }
const terms = readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
for (const h of [...new Set(terms.map(termHash))].sort()) console.log(`  '${h}',`)
