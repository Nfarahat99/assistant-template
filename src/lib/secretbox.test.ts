import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { seal, open, isValidKey, SecretboxError } from './secretbox.js'

const k = randomBytes(32).toString('hex')

test('round trip', () => { assert.equal(open(seal('مفتاح-سري', k), k), 'مفتاح-سري') })
test('fresh IV each time', () => { assert.notEqual(seal('x', k), seal('x', k)) })
test('wrong key fails', () => { assert.throws(() => open(seal('x', k), randomBytes(32).toString('hex')), SecretboxError) })
test('tamper fails', () => {
  const s = seal('x', k).split(':'); s[3] = Buffer.from('y').toString('base64')
  assert.throws(() => open(s.join(':'), k), SecretboxError)
})
test('bad format fails', () => { assert.throws(() => open('nope', k), SecretboxError) })
test('key validation', () => { assert.equal(isValidKey(k), true); assert.equal(isValidKey('abc'), false); assert.equal(isValidKey(''), false) })
