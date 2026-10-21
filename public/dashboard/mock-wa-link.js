// بيانات تجريبية لصفحة الحسابات (?mock=1). سيناريوهات: &wa=unavailable | envassistant | envowner | linked | env | locked | mismatch | timeout | activetimeout
import { ApiError } from './api.js'

const scenario = new URLSearchParams(location.search).get('wa') || ''
const DEMO = { assistantPhone: '966500000011', ownerPhone: '966500000012' }
let link = scenario === 'linked' ? { ...DEMO, linkedAt: new Date(Date.now() - 5 * 864e5).toISOString(), connected: true }
  : scenario === 'mismatch' || scenario === 'timeout' || scenario === 'activetimeout' ? { ...DEMO, linkedAt: new Date().toISOString(), connected: false } : null
let polls = 0, qrN = 0, problem = scenario === 'mismatch' ? 'phone_mismatch' : scenario === 'timeout' || scenario === 'activetimeout' ? 'qr_timeout' : null

const MSG = {
  phone_mismatch: 'مسحت الرمز بجوال غير رقم المساعد المسجّل — جرّب مرة ثانية بجوال رقم المساعد.',
  qr_timeout: 'انتهت مهلة الرمز — اضغط «رمز جديد» وامسحه خلال دقائق.',
}

export function handleWaLink(method, path, body, fakeQr) {
  const R = `${method} ${path}`
  if (R === 'GET /wa/link') {
    if (scenario === 'unavailable') return { available: false, reason: 'no_provision_key', missing: ['no_provision_key', 'no_webhook_secret'], linked: false }
    if (scenario === 'env') return { available: true, linked: true, source: 'env', ...DEMO }
    if (scenario === 'locked') return { available: true, linked: true, source: 'dashboard', locked: true, ...DEMO, message: 'الربط محفوظ لكن ما قدرت أفك تشفيره — SECRETS_KEY ناقص أو تغيّر.' }
    if (scenario === 'envassistant') return { available: false, reason: 'env_assistant_phone', missing: ['env_assistant_phone'], linked: false }
    if (!link) return { available: true, linked: false, defaults: { ownerPhone: DEMO.ownerPhone }, ...(scenario === 'envowner' ? { ownerFromEnv: true } : {}) }
    if (problem) return { available: true, linked: true, source: 'dashboard', assistantPhone: link.assistantPhone, ownerPhone: link.ownerPhone, linkedAt: link.linkedAt, status: problem === 'phone_mismatch' ? 'logged_out' : 'disconnected', disconnectReason: problem, message: MSG[problem], active: scenario === 'activetimeout' }
    return { available: true, linked: true, source: 'dashboard', assistantPhone: link.assistantPhone, ownerPhone: link.ownerPhone, linkedAt: link.linkedAt, status: link.connected ? 'connected' : 'qr', disconnectReason: null, message: null, active: link.connected }
  }
  if (R === 'POST /wa/link') {
    if (link) throw new ApiError(409, 'فيه ربط قائم — فكّه أول.')
    link = { assistantPhone: body.assistantPhone, ownerPhone: body.ownerPhone, linkedAt: new Date().toISOString(), connected: false }
    polls = 0
    return { ok: true, numberId: 'demo-session' }
  }
  if (!link) throw new ApiError(404, 'ما فيه ربط واتساب.')
  if (R === 'GET /wa/link/qr') { qrN++; return { qr_png_base64: fakeQr() } }
  if (R === 'POST /wa/link/relink') { problem = null; polls = 0; return { ok: true } }
  if (R === 'GET /wa/link/status') {
    if (problem) return { status: problem === 'phone_mismatch' ? 'logged_out' : 'disconnected', reason: problem, message: MSG[problem] }
    if (link.connected) return { status: 'connected', restarting: false, message: null }
    // يتصل بعد ~٦ استطلاعات (≈ ١٨ ثانية) ليتسنى رؤية العدّاد
    if (++polls >= 6) { link.connected = true; return { status: 'connected', restarting: true, message: null } }
    return { status: polls < 2 ? 'connecting' : 'qr', reason: null, message: null }
  }
  if (R === 'DELETE /wa/link') { link = null; problem = null; return { ok: true, logged_out: true, restarting: false } }
  throw new ApiError(404, `مسار غير معروف في البيانات التجريبية: ${R}`)
}
