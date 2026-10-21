/**
 * (k) توكنات/أسرار يلصقها المالك في المحادثة: لا تُخزَّن في السجل، لا تُرسل للنموذج، ولا تُعاد في أي رد.
 */
export type SecretKind = 'railway' | 'github' | 'anthropic' | 'openai' | 'google' | 'groq' | 'telegram' | 'generic'

const PATTERNS: [SecretKind, RegExp][] = [
  ['github', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['groq', /\bgsk_[A-Za-z0-9]{20,}\b/g],
  ['openai', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['telegram', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
]
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const TOKEN_WORD = /(railway|ريلوي|ريلواي|token|توكن|tokens|api[ _-]?key|مفتاح)/i
const GENERIC = /\b[A-Za-z0-9_\-]{32,}\b/g

export interface FoundSecret { kind: SecretKind; value: string }

export function detectSecrets(text: string): FoundSecret[] {
  const out: FoundSecret[] = []
  const seen = new Set<string>()
  const add = (kind: SecretKind, value: string) => { if (!seen.has(value)) { seen.add(value); out.push({ kind, value }) } }
  for (const [kind, re] of PATTERNS) for (const m of text.matchAll(re)) add(kind, m[0])
  // UUID وحده شائع (معرّفات) — نعتبره توكن Railway فقط مع ذكر ريلوي/توكن
  if (TOKEN_WORD.test(text)) {
    for (const m of text.matchAll(UUID)) add(/railway|ريلوي|ريلواي/i.test(text) ? 'railway' : 'generic', m[0])
    for (const m of text.matchAll(GENERIC)) if (![...seen].some((s) => s.includes(m[0]) || m[0].includes(s))) add('generic', m[0])
  }
  return out
}

export function redactSecrets(text: string, found = detectSecrets(text)): string {
  let s = text
  for (const f of found) s = s.split(f.value).join(`[${f.kind}-token محجوب]`)
  return s
}

export const SECRET_AR: Record<SecretKind, string> = {
  railway: 'Railway', github: 'GitHub', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google/Gemini', groq: 'Groq', telegram: 'تيليجرام', generic: 'سري',
}

// ───────────── حجب الأسرار في النصوص الصادرة والمحفوظة ─────────────
/**
 * مفاتيح بصيغ معروفة (zk-… مفتاح وسيط البصمة، sk-…، ghp_…، nvapi-…، gsk_…، AIza…، xoxb-…، توكن تيليجرام)،
 * وأي قيمة طويلة (base64/hex ≥ ٢٠ حرفاً) بجانب كلمة مفتاح/key/token/secret/password.
 * يُطبَّق على قراءة الصور، وكل رد للمالك، وكل دور يُحفظ في السجل — المفتاح لا يُعاد عرضه ولا يُخزَّن.
 */
const KNOWN_KEY_RE = new RegExp([
  String.raw`\b(?:zk|sk|nvapi|xox[abprs]|glpat)[-_][A-Za-z0-9_\-]{10,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}`,
  String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bgsk_[A-Za-z0-9]{16,}`,
  String.raw`\bAIza[0-9A-Za-z_\-]{30,}`,
  String.raw`\b\d{8,10}:[A-Za-z0-9_\-]{35}\b`,
].join('|'), 'g')
const KEY_WORDS = String.raw`(?<![\p{L}\p{N}])(?:مفتاح|المفتاح|ومفتاح|مفاتيح|كلمة\s*(?:ال)?(?:مرور|سر)|الرقم\s*السري|الرمز\s*السري|رمز\s*سري|توكن|التوكن|key|api[\s_-]?key|token|secret|password|passwd|pwd|passphrase)(?![\p{L}])`
// كلمة مفتاح ثم (حتى ٤٠ حرفاً بلا سطر جديد) قيمة طويلة: base64/hex/معرّف ≥ ٢٠ حرفاً
const NEAR_WORD_RE = new RegExp(String.raw`(${KEY_WORDS}[^\n]{0,40}?[:=：\s«"'${'`'}])([A-Za-z0-9+/_.=-]{20,})`, 'giu')

const maskValue = (v: string) => {
  const m = /^([A-Za-z]{2,6}[-_])/.exec(v)
  return `${m ? m[1] : ''}•••• (محجوب)`
}

export function maskSecrets(text: string): string {
  if (!text) return text
  let s = text.replace(KNOWN_KEY_RE, (v) => maskValue(v))
  s = s.replace(NEAR_WORD_RE, (all, head: string, val: string) => {
    if (val.includes('••••')) return all
    // قيمة كلها حروف (كلمة إنجليزية طويلة) أو رابط/مسار — ليست سراً
    if (!/\d/.test(val) || /^https?:/i.test(val) || /^[\w.-]+\/[\w./-]+$/.test(val) && !/[+=]/.test(val)) return all
    return head + maskValue(val)
  })
  return s
}

export const hasSecretLike = (text: string) => maskSecrets(text) !== text
