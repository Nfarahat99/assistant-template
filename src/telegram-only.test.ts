import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.js'
import { Watchdog } from './watchdog.js'
import { capabilitiesForPrompt, capabilitiesForOwner, type SelfState } from './capabilities.js'

test('no gateway config → whatsappEnabled=false', () => {
  assert.equal(loadConfig({} as any).whatsappEnabled, false)
  assert.equal(loadConfig({ GATEWAY_URL: 'https://g', GATEWAY_API_KEY: 'k', ASSISTANT_PHONE: '966500000000' } as any).whatsappEnabled, true)
})

test('disabled watchdog never polls and never alerts', async () => {
  let polled = 0, alerted = 0
  const gw: any = { getStatus: async () => { polled++; return { status: 'unreachable' } } }
  const alerter: any = { immediate: true, send: async () => { alerted++ }, sendImage: async () => { alerted++ } }
  const w = new Watchdog(loadConfig({} as any), gw, alerter, { onRecovered: async () => {} })
  for (let i = 0; i < 5; i++) await w.check()
  assert.equal(polled, 0)
  assert.equal(alerted, 0)
  assert.equal(w.snapshot().status, 'disabled')
})

test('capabilities say WhatsApp not linked when disabled', () => {
  const s: SelfState = {
    githubConnected: false, githubOwner: '', projects: [], selfRepo: 'x/y', telegram: 'bound',
    whatsapp: { status: 'connected', banned: false }, whatsappEnabled: false, sendMode: 'link', version: null, recentJobs: [],
  }
  assert.match(capabilitiesForPrompt(s), /واتساب غير مربوط بعد/)
  assert.doesNotMatch(capabilitiesForPrompt(s), /وضع link/)
  assert.match(capabilitiesForOwner(s), /واتساب غير مربوط بعد/)
})
