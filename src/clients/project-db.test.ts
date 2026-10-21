import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectDbClient, ProjectDbError, assertReadOnlySql, listProjectDbs } from './project-db.js'

test('يقبل الاستعلامات القرائية ويرفض الكتابة', () => {
  for (const ok of ['select 1', 'SELECT * FROM t WHERE a = \'delete\';', 'with x as (select 1) select * from x', 'explain select 1', "select 'a;b'", '-- c\nselect 1'])
    assert.doesNotThrow(() => assertReadOnlySql(ok), ok)
  for (const bad of ['delete from t', 'select 1; drop table t', 'insert into t values (1)', 'with d as (delete from t returning *) select * from d',
    'select * into x from t', 'select pg_sleep(10)', 'explain analyze select 1', 'set role admin', '', 'select 1 /* x', "select set_config('a','b',false)"])
    assert.throws(() => assertReadOnlySql(bad), ProjectDbError, bad)
})

test('list يقرأ أسماء القواعد من البيئة بلا القيم', () => {
  assert.deepEqual(listProjectDbs({ PROJECT_DB_B_URL: 'x', PROJECT_DB_A_URL: 'y', PROJECT_DB_C_URL: '', OTHER: 'z' }), ['a', 'b'])
})

function fake(rows: any[], calls: string[], fail?: Error) {
  return () => ({
    async connect() {
      return {
        async query(sql: string) { calls.push(sql); if (fail && !/^(BEGIN|SET|ROLLBACK)/.test(sql)) throw fail; return { rows, fields: rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [] } },
        release() { calls.push('release') },
      }
    },
    async end() {},
  })
}

test('معاملة READ ONLY، حجب الأعمدة الحساسة، واقتطاع الصفوف', async () => {
  const calls: string[] = []
  const c = new ProjectDbClient({ PROJECT_DB_APP_URL: 'postgres://u:p@h/db' }, fake([{ id: 1, password_hash: 'x' }, { id: 2, password_hash: 'y' }], calls))
  const r = await c.query('APP', 'select * from users', { limit: 1 })
  assert.equal(r.rows.length, 1)
  assert.equal(r.truncated, true)
  assert.notEqual(r.rows[0].password_hash, 'x')
  assert.deepEqual(r.masked, ['password_hash'])
  assert.equal(calls[0], 'BEGIN READ ONLY')
  assert.ok(calls.includes('ROLLBACK') && calls.includes('release'))
})

test('قاعدة غير مُعدّة، وخطأ لا يسرّب عنوان الاتصال', async () => {
  const c = new ProjectDbClient({ PROJECT_DB_APP_URL: 'postgres://u:secret@h/db' }, fake([], [], new Error('connect failed postgres://u:secret@h/db\nx')))
  await assert.rejects(c.query('nope', 'select 1'), /غير مُعدّة/)
  await assert.rejects(c.query('app', 'select 1'), (e: Error) => !/secret/.test(e.message) && /فشل/.test(e.message))
})
