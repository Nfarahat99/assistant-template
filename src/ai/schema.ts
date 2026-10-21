import { z } from 'zod'
import { ITEM_KINDS, ITEM_STATUSES, STAGES } from '../projects/items.js'

/**
 * عقد مخرجات النموذج. أي مخرج لا يطابقه يُرفض — النموذج لا يستطيع
 * اختراع نوع إجراء جديد ولا تمرير حقول غير متوقعة للتنفيذ.
 */
const str = z.string().trim().min(1)
const optStr = z.string().trim().nullish().transform((v) => (v ? v : undefined))
/** أولوية بند مشروع: 1 عالية، 2 عادية، 3 منخفضة (أو high/normal/low) — القيمة الغريبة تُهمل لا ترفض الرد */
const prio = z.preprocess((v) => (v === 'high' ? 1 : v === 'normal' ? 2 : v === 'low' ? 3 : v), z.coerce.number().int().min(1).max(3))
  .nullish().catch(undefined).transform((v) => (v ? (v as 1 | 2 | 3) : undefined))
const itemId = z.coerce.number().int().positive().nullish().catch(undefined).transform((v) => v ?? undefined)
/**
 * تكرار التذكير: "daily" | "weekly:0,3" | "every_n_days:2" | "weekdays" (+ "@21:00" اختياري)، أو كائن {kind,time,days,n}.
 * يُطبَّع عند التنفيذ (src/lib/recurrence.ts) — القيمة الغريبة تُهمل لا ترفض الرد.
 */
const recurrence = z.union([z.string().trim(), z.object({}).passthrough()]).nullish().catch(undefined)
  .transform((v) => (v == null || v === '' ? undefined : typeof v === 'string' ? v : JSON.stringify(v)))

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add_task'),
    title: str,
    due_at: optStr,
    /** موعد التنبيه — إلزامي لأي مهمة فيها وقت أو صيغة تذكير (= due_at إن ذُكر وقت واحد) */
    remind_at: optStr,
    recurrence,
    priority: z.enum(['low', 'normal', 'high']).nullish().transform((v) => v ?? undefined),
    notes: optStr,
    source: optStr,
  }),
  z.object({
    type: z.literal('complete_task'),
    task_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? undefined),
    query: optStr,
    /** مهام الورد القرآني فقط: نطاق ما قرأه/سمّعه، وتأكيده إكمال المقدار */
    wird_range: optStr,
    wird_confirmed: z.boolean().nullish().transform((v) => v ?? undefined),
  }).refine((a) => a.task_id !== undefined || a.query !== undefined, 'task_id أو query مطلوب'),
  z.object({
    type: z.literal('list_tasks'),
    filter: z.enum(['today', 'overdue', 'all', 'week']).catch('all'),
  }),
  z.object({ type: z.literal('set_reminder'), text: str, at: str, recurrence }),
  /** "وقف تذكير 27" / "احذف 27" — إيقاف مهمة/تذكير (متكرر غالباً) أو حذفه */
  z.object({
    type: z.literal('stop_reminder'),
    task_id: z.coerce.number().int().positive().nullish().catch(undefined).transform((v) => v ?? undefined),
    query: optStr,
    delete: z.boolean().nullish().catch(undefined).transform((v) => v ?? undefined),
  }).refine((a) => a.task_id !== undefined || a.query !== undefined, 'task_id أو query مطلوب'),
  z.object({ type: z.literal('send_whatsapp'), contact_query: str, text: str, direct: z.boolean().nullish().transform((v) => v ?? undefined) }),
  z.object({ type: z.literal('code_change'), project_query: str, request: str }),
  z.object({
    type: z.literal('save_contact'),
    name: str,
    phone: str,
    aliases: z.array(z.string()).nullish().transform((v) => (v ?? []).map((s) => s.trim()).filter(Boolean)),
  }),
  z.object({ type: z.literal('contact_history'), contact_query: str }),
  z.object({ type: z.literal('send_telegram'), contact_query: optStr, text: str }),
  z.object({ type: z.literal('web_search'), query: str, purpose: optStr }),
  /** بحث في كود مشروع (GitHub) — "وين ألقى زر X في مشروع Y" — لا بحث ويب أبداً */
  z.object({ type: z.literal('code_search'), project_query: str, query: str }),
  z.object({ type: z.literal('research_tech'), task: str, constraints: optStr }),
  z.object({ type: z.literal('find_skills'), query: str }),
  z.object({ type: z.literal('railway_status'), project_query: optStr, detail: optStr }),
  z.object({ type: z.literal('railway_redeploy'), project_query: str, service_query: optStr }),
  z.object({ type: z.literal('db_query'), db_query: optStr, question: str }),
  z.object({ type: z.literal('db_write'), db_query: optStr, request: str }),
  z.object({ type: z.literal('agent_dispatch'), task: str, project_query: optStr, agent: optStr }),
  z.object({ type: z.literal('laptop_draft'), title: str, details: optStr, project_query: optStr, agent: optStr }),
  z.object({
    type: z.literal('laptop_list'),
    draft_id: z.coerce.number().int().positive().nullish().transform((v) => v ?? undefined),
  }),
  z.object({
    type: z.literal('laptop_update'),
    draft_id: z.coerce.number().int().positive(),
    status: z.enum(['done', 'cancelled', 'ready']),
  }),
  z.object({ type: z.literal('learn_guideline'), rule: str }),
  z.object({ type: z.literal('list_guidelines') }),
  z.object({ type: z.literal('forget_guideline'), guideline_id: z.coerce.number().int().positive() }),
  z.object({ type: z.literal('group_reply'), text: str }),
  // ── متتبّع مشاريع البزنس ──
  z.object({
    type: z.literal('project_item_add'), project_query: str, title: str,
    kind: z.enum(ITEM_KINDS).nullish().catch(undefined).transform((v) => v ?? undefined),
    priority: prio, due_date: optStr, notes: optStr,
  }),
  z.object({
    type: z.literal('project_item_update'), project_query: optStr, item_id: itemId, query: optStr,
    status: z.enum(ITEM_STATUSES).nullish().catch(undefined).transform((v) => v ?? undefined),
    priority: prio, due_date: optStr, title: optStr,
  }).refine((a) => a.item_id !== undefined || a.query !== undefined, 'item_id أو query مطلوب'),
  z.object({ type: z.literal('project_item_delete'), project_query: optStr, item_id: itemId, query: optStr })
    .refine((a) => a.item_id !== undefined || a.query !== undefined, 'item_id أو query مطلوب'),
  z.object({ type: z.literal('project_items'), project_query: optStr, mode: z.enum(['list', 'prioritize', 'brief', 'weekly']).catch('list') }),
  z.object({
    type: z.literal('project_stage'), project_query: str,
    stage: z.enum(STAGES).nullish().catch(undefined).transform((v) => v ?? undefined), audience: optStr, revenue_model: optStr,
  }),
  z.object({ type: z.literal('project_checklist'), project_query: str }),
  z.object({ type: z.literal('project_suggest'), project_query: optStr }),
  z.object({ type: z.literal('answer'), text: str }),
  z.object({
    type: z.literal('clarify'),
    question: str,
    options: z.array(z.string()).nullish().transform((v) => v ?? undefined),
  }),
])

export const LlmOutputSchema = z.object({
  actions: z.array(ActionSchema).max(10).default([]),
  reply: z.string().default(''),
  /** في وضع الصوت المباشر فقط: التفريغ الحرفي للصوتية */
  transcript: z.string().optional(),
})

export type Action = z.infer<typeof ActionSchema>
export type LlmOutput = z.infer<typeof LlmOutputSchema>

/** يستخرج JSON حتى لو لفّه النموذج بـ ```json ... ``` */
export function extractJson(text: string): unknown {
  const t = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  const body = fenced ? fenced[1] : t
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('لا يوجد JSON في الرد')
  return JSON.parse(body.slice(start, end + 1))
}

export type ParseResult = { ok: true; value: LlmOutput } | { ok: false; error: string }

export function parseLlmOutput(text: string, opts: { requireTranscript?: boolean } = {}): ParseResult {
  let json: unknown
  try { json = extractJson(text) } catch (e: any) { return { ok: false, error: `JSON غير صالح: ${e.message}` } }
  const r = LlmOutputSchema.safeParse(json)
  if (!r.success) {
    return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  }
  if (opts.requireTranscript && !r.data.transcript?.trim()) return { ok: false, error: 'transcript مطلوب (تفريغ الصوتية)' }
  if (!opts.requireTranscript && r.data.actions.length === 0 && !r.data.reply.trim()) return { ok: false, error: 'لا إجراءات ولا رد' }
  return { ok: true, value: r.data }
}
