import type { Store } from '../store.js'
import type { Config } from '../config.js'
import { seal, open, isValidKey } from '../lib/secretbox.js'

/**
 * numberId = session_id في الوسيط (ليس سراً) — يلزم لفك الربط من اللوحة.
 * connectedAt = أول مرة اتصل فيها الرقم (مسح الرمز) — الربط لا يُطبَّق عند الإقلاع قبله.
 */
export type WaLink = { assistantPhone: string; ownerPhone: string; apiKey: string; linkedAt: string; numberId?: string; connectedAt?: string }
export type WaLinkLoad = { ok: true; link: WaLink } | { ok: false; reason: 'none' | 'no_key' | 'bad_key' }

const KEY = 'wa_link'
/** linkedAt للربط الذي أُرسل له الترحيب (نسخ قديمة بلا connectedAt) */
export const WELCOMED_KEY = 'wa_link_welcomed'

/** يخزّن الربط في kv؛ apiKey وحده مشفّر (AES-256-GCM) */
export async function saveWaLink(store: Store, link: WaLink, keyHex: string): Promise<void> {
  await store.setKv(KEY, JSON.stringify({ ...link, apiKey: seal(link.apiKey, keyHex) }))
}

export async function loadWaLink(store: Store, keyHex: string): Promise<WaLinkLoad> {
  const raw = await store.getKv(KEY)
  if (!raw) return { ok: false, reason: 'none' }
  if (!keyHex || !isValidKey(keyHex)) return { ok: false, reason: 'no_key' }
  try {
    const j = JSON.parse(raw)
    const apiKey = open(String(j.apiKey), keyHex)
    return { ok: true, link: { assistantPhone: String(j.assistantPhone ?? ''), ownerPhone: String(j.ownerPhone ?? ''), apiKey, linkedAt: String(j.linkedAt ?? ''), ...(j.numberId ? { numberId: String(j.numberId) } : {}), ...(j.connectedAt ? { connectedAt: String(j.connectedAt) } : {}) } }
  } catch {
    return { ok: false, reason: 'bad_key' }
  }
}

/** البيئة تغلب: نملأ فقط الحقول الفارغة، ثم نعيد حساب whatsappEnabled */
export function applyWaLink(cfg: Config, link: WaLink): void {
  if (!cfg.gatewayApiKey) { cfg.gatewayApiKey = link.apiKey; cfg.waLinkFilled.push('gatewayApiKey') }
  if (!cfg.assistantPhone) { cfg.assistantPhone = link.assistantPhone; cfg.waLinkFilled.push('assistantPhone') }
  if (!cfg.ownerPhone) { cfg.ownerPhone = link.ownerPhone; cfg.waLinkFilled.push('ownerPhone') }
  cfg.whatsappEnabled = !!(cfg.gatewayUrl && cfg.gatewayApiKey && cfg.assistantPhone)
}

/**
 * اتصل الرقم فعلاً (مسح الرمز)؟ connectedAt، أو — لربط محفوظ قبل connectedAt — الترحيب أُرسل لنفس linkedAt.
 * ربط حُفظ ثم تُرك قبل المسح = معلّق: لا يُطبَّق عند الإقلاع، واللوحة تعرضه بانتظار المسح.
 */
export async function waLinkConnected(store: Pick<Store, 'getKv'>, link: Pick<WaLink, 'linkedAt' | 'connectedAt'>): Promise<boolean> {
  if (link.connectedAt) return true
  return !!link.linkedAt && (await store.getKv(WELCOMED_KEY)) === link.linkedAt
}

/** الحقول غير السرية فقط، بلا فك تشفير — لفك الربط حتى لو ضاع SECRETS_KEY */
export async function peekWaLink(store: Store): Promise<{ numberId?: string; assistantPhone?: string; ownerPhone?: string } | null> {
  const raw = await store.getKv(KEY)
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    return { numberId: j.numberId ? String(j.numberId) : undefined, assistantPhone: j.assistantPhone ? String(j.assistantPhone) : undefined, ownerPhone: j.ownerPhone ? String(j.ownerPhone) : undefined }
  } catch { return {} }
}

export async function clearWaLink(store: Store): Promise<void> {
  await store.delKv(KEY)
}

/**
 * طبقة الإقلاع: تحمّل الربط المحفوظ وتطبّقه — فقط لو اتصل فعلاً (connectedAt)؛ ربط معلّق قبل المسح لا يُفعّل واتساب.
 * تستدعي warn فقط لو موجود وتعذّر فك تشفيره.
 */
export async function overlayWaLink(store: Store, cfg: Config, warn: (o: { reason: string }, msg: string) => void): Promise<void> {
  const wl = await loadWaLink(store, cfg.secretsKey)
  if (wl.ok) { if (await waLinkConnected(store, wl.link)) applyWaLink(cfg, wl.link) }
  else if (wl.reason !== 'none') warn({ reason: wl.reason }, 'ربط واتساب محفوظ لكن ما قدرت أفك تشفيره (SECRETS_KEY ناقص أو مختلف) — تيليجرام فقط')
}
