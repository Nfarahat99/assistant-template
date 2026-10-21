/**
 * تطبيع بحث الأسماء العربية في SQL (الطرفان معاً) + قراءة «نعم N بدون فحص».
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { arabicSearchSql, normalizeArabicLiteral, nameParts } from './lib/sql-arabic.js'
import { parseConfirmation, yesStrength } from './lib/confirm.js'

test('تطبيع النص: ة/ه، ى/ي، الهمزات، التشكيل والتطويل، والمسافات', () => {
  assert.equal(normalizeArabicLiteral('بازرعة'), 'بازرعه')
  assert.equal(normalizeArabicLiteral('با زرعة'), 'بازرعه')
  assert.equal(normalizeArabicLiteral('أحمد إبراهيم آل مُوسى'), 'احمدابراهيمالموسي')
  assert.equal(normalizeArabicLiteral('عـلـي'), 'علي')
  assert.deepEqual(nameParts('ماجد با زرعة'), ['ماجد', 'بازرعه'])
  assert.deepEqual(nameParts('ماجد بازرعة'), ['ماجد', 'بازرعه'])
})

test('إعادة الكتابة: العمود والنص يُطبَّعان معاً، وعدة كلمات ← AND؛ وغير العربي لا يُلمس', () => {
  const out = arabicSearchSql("select id from students where name ilike '%ماجد بازرعة%' and city = 'x'")
  assert.match(out, /\(replace\(translate\(regexp_replace\(\(name\)::text/)
  assert.match(out, /ILIKE '%ماجد%' AND replace/)
  assert.match(out, /ILIKE '%بازرعه%'\)/)
  assert.match(out, /city = 'x'/)
  const plain = "select id from t where name ilike '%john%'"
  assert.equal(arabicSearchSql(plain), plain)
  // تعبير مطبّع جزئياً من النموذج (translate على العمود فقط) + cast + معرّف مقتبس
  const t = arabicSearchSql(`select 1 from r where translate(r."fullName"::text,'أإآىةؤئ','ااايهوي') ilike '%بازرعة%' and r.note::text not like '%ملاحظة%'`)
  assert.match(t, /\(translate\(r\."fullName"::text,'أإآىةؤئ','ااايهوي'\)\)::text/)
  assert.match(t, /ILIKE '%بازرعه%'/)
  assert.match(t, /\(r\.note::text\)::text.*NOT LIKE '%ملاحظه%'/)
  // النص داخل '' لا يُعامل ككلمة مفتاحية
  const q = "select 'like' as x from t where a ilike '%علي%'"
  assert.match(arabicSearchSql(q), /^select 'like' as x/)
})

test('PGlite حقيقي: "بازرعة" و"با زرعة" و"بازرعه" كلها تجد "ماجد احمد ماجد بازرعة"', async () => {
  const pg = await PGlite.create('memory://')
  try {
    await pg.exec(`CREATE TABLE r (id INT, full_name TEXT); INSERT INTO r VALUES (249, 'ماجد احمد ماجد بازرعة'), (12, 'عمر ماجد الزهراني');`)
    // الخطأ الأصلي: العمود مطبّع والنص لا
    const bad = "select id from r where translate(full_name,'أإآىةؤئ','ااايهوي') ilike '%بازرعة%'"
    assert.equal((await pg.query(bad)).rows.length, 0, 'يثبت الخلل الأصلي')
    assert.deepEqual((await pg.query<any>(arabicSearchSql(bad))).rows.map((x) => x.id), [249])
    for (const lit of ['%ماجد بازرعة%', '%ماجد با زرعة%', '%بازرعه%', '%مُاجد%بازرعة%']) {
      const rows = (await pg.query<any>(arabicSearchSql(`select id from r where full_name ilike '${lit}'`))).rows
      assert.deepEqual(rows.map((x) => x.id), [249], lit)
    }
  } finally { await pg.close() }
})

test('«نعم N بدون فحص» تجاوز صريح — و«نعم N» العادية بلا تجاوز', () => {
  assert.deepEqual(parseConfirmation('نعم 7 بدون فحص'), { kind: 'yes', index: 7, unchecked: true })
  assert.deepEqual(parseConfirmation('نعم ٧ بدون تحقق'), { kind: 'yes', index: 7, unchecked: true })
  assert.deepEqual(parseConfirmation('نعم 7'), { kind: 'yes', index: 7 })
  assert.equal(parseConfirmation('بدون فحص'), null)
  assert.deepEqual(yesStrength('نعم 7 بدون فحص'), { strong: true, merge: true })
})
