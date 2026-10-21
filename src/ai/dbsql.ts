import { ownerName, assistantName } from '../profile.js'
import { extractJson } from './schema.js'
import { cellText } from '../clients/databases.js'

/**
 * النموذج يكتب SQL من سؤال المالك ومخطط القاعدة (جداول + أعمدة فقط، بلا بيانات).
 * الحراسة الفعلية ليست هنا: كل ما يرجعه يمر بـ assertSelectOnly / assertWriteSql ودور القراءة فقط.
 */
export function sqlSystemRead(): string {
  const o = ownerName()
  return `أنت خبير PostgreSQL. حوّل سؤال ${o} إلى جملة SELECT واحدة فقط على المخطط المعطى.
قواعد:
- جملة وحدة: SELECT أو WITH … SELECT. بدون ; وبدون أي INSERT/UPDATE/DELETE/DDL.
- استخدم أسماء الجداول والأعمدة كما في المخطط بالضبط. الأسماء فيها حروف كبيرة (camelCase) لازم بين علامتي تنصيص "…".
- لا تختر أعمدة حساسة (كلمات مرور، hash، token، secret، otp، مفاتيح، جلسات) أبداً.
- للبحث عن رقم (هوية، جوال، رقم طالب) مخزّن كنص: قارن بعد توحيد الأرقام العربية:
  translate(col::text,'٠١٢٣٤٥٦٧٨٩','0123456789') = '1999999990'
- البحث بالاسم/النص يكون مرناً لا حرفياً أبداً (لا تستخدم = على نص يكتبه الإنسان):
  • ILIKE '%…%' دائماً، وإذا الاسم من أكثر من كلمة قسّمه كلمات واربطها بـ AND (كل كلمة ILIKE منفصلة) عشان يتجاوز ترتيب الكلمات والمسافات الزائدة.
  • وحّد الحروف العربية المتشابهة على العمود وعلى القيمة معاً: translate(col::text,'أإآىةؤئ','ااايهوي') — (أ إ آ ← ا، ى ← ي، ة ← ه، ؤ ← و، ئ ← ي)، وتجاهل التشكيل: regexp_replace(col::text,'[ً-ْـ]','','g').
  • للإنجليزي والتهجئات القريبة: lower(col) ILIKE، وإذا المخطط/القاعدة تدعم pg_trgm فاستخدم similarity(col, 'نص') > 0.3 أو word_similarity مع ORDER BY similarity DESC. لو جاك خطأ أن الدالة غير موجودة ارجع لـ ILIKE فقط.
  • الأرقام (هوية، جوال، رقم طالب) تبقى مطابقة دقيقة بالقاعدة أعلاه.
- للعدّ استخدم count(*). وللقوائم أضف ORDER BY منطقي و LIMIT 50 كحد أقصى.
- لا تخمّن أعمدة غير موجودة. إذا السؤال غامض أو المخطط ما فيه اللازم، اسأل.
- إذا ذكر ${o} اسم شخص (طالب، معلم، مستخدم): الاستعلام لازم يطابق كل أجزاء الاسم اللي قالها (كل كلمة شرط مستقل مع AND) — لا تكتفِ بجزء منه، ولا ترجع شخصاً آخر يشترك معه في كلمة. "با زرعة" و"بازرعة" نفس الاسم: قارن بعد حذف المسافات أيضاً: replace(translate(col::text,'أإآىةؤئ','ااايهوي'),' ','') ILIKE '%بازرعه%'. واختر عمود الاسم في النتيجة دائماً، وأضف "name":"الاسم كما قاله" في JSON.
أعد JSON فقط: {"sql":"...","name":"اسم الشخص إن ذُكر؟"} أو {"question":"سؤال توضيحي قصير بالسعودي"}`
}

export function sqlSystemWrite(): string {
  const o = ownerName()
  return `أنت خبير PostgreSQL. حوّل طلب ${o} إلى جملة تعديل واحدة فقط على المخطط المعطى.
قواعد:
- جملة وحدة: INSERT أو UPDATE أو DELETE. بدون ; وبدون WITH وبدون DDL (DROP/ALTER/CREATE/TRUNCATE/GRANT).
- UPDATE/DELETE لازم فيها WHERE دقيق يحدد الصفوف المقصودة فقط.
- استخدم أسماء الجداول والأعمدة كما في المخطط بالضبط. الأسماء فيها حروف كبيرة (camelCase) لازم بين علامتي تنصيص "…".
- للمطابقة على رقم مخزّن كنص: translate(col::text,'٠١٢٣٤٥٦٧٨٩','0123456789') = '…'
- لا تلمس أعمدة كلمات المرور أو الـ tokens.
- إذا الطلب غامض (ما تعرف أي صفوف بالضبط)، اسأل ولا تخمّن.
أعد JSON فقط: {"sql":"..."} أو {"question":"سؤال توضيحي قصير بالسعودي"}`
}

/**
 * قواعد SQLite (مسار HTTP في التطبيق، تحضير سراج مثلاً): القواعد أعلاه مكتوبة لـ PostgreSQL،
 * وهذه الملاحظة تتقدّم عليها حين تكون القاعدة SQLite.
 */
export const SQLITE_DIALECT_NOTE = `⚠️ هذي القاعدة SQLite (وليست PostgreSQL) — القراءة فقط، والقواعد التالية تتقدّم على أي قاعدة PostgreSQL سابقة:
- لا ILIKE: استخدم lower(col) LIKE lower('%…%') (LIKE في SQLite لا يفرّق حالة الحروف الإنجليزية أصلاً).
- لا ::cast: استخدم CAST(col AS TEXT). لا translate ولا regexp_replace ولا similarity ولا pg_*.
- لتوحيد الحروف العربية استخدم replace متداخلة: replace(replace(replace(replace(col,'أ','ا'),'إ','ا'),'ة','ه'),'ى','ي').
- للأرقام العربية المخزّنة نصاً: replace متداخلة لكل رقم، أو قارن بالقيمتين (اللاتينية والعربية) بـ OR.
- التواريخ نصوص 'YYYY-MM-DD' أو 'YYYY-MM-DD HH:MM:SS': استخدم date('now')، date('now','-7 days')، strftime('%Y-%m', col).
- القيم المنطقية 0/1. لا RETURNING ولا FOR UPDATE ولا PRAGMA ولا ATTACH ولا تعليقات (-- أو /* */).
- لا تذكر أعمدة حساسة (password_hash، token، key، secret…) حتى في WHERE — الاستعلام يُرفض.`

export function sqlUserPrompt(dbName: string, schema: string, request: string, retryError?: { sql: string; error: string }, relax?: { sql: string }, dialect?: 'postgres' | 'sqlite'): string {
  const parts = [`القاعدة: ${dbName}`, `المخطط (جدول(عمود نوع, …)):\n${schema || '(فاضي)'}`, `الطلب:\n${request}`]
  if (dialect === 'sqlite') parts.unshift(SQLITE_DIALECT_NOTE)
  if (retryError) parts.push(`محاولتك السابقة فشلت:\nSQL: ${retryError.sql}\nالخطأ: ${retryError.error}\nصحّحها.`)
  if (relax) parts.push(`استعلامك السابق رجع صفر صفوف:\nSQL: ${relax.sql}\nوسّع البحث: قلّل الكلمات (اكتفِ بأميزها)، استخدم ILIKE جزئي على كل كلمة، وحّد الحروف العربية المتشابهة، وجرّب أعمدة نصية أخرى مناسبة. لا تغيّر معنى السؤال.`)
  return parts.join('\n\n')
}

export type SqlReply = { sql: string; name?: string } | { question: string } | null

export function parseSqlReply(text: string): SqlReply {
  try {
    const j = extractJson(text) as any
    if (typeof j?.sql === 'string' && j.sql.trim()) {
      const name = typeof j.name === 'string' && j.name.trim() ? j.name.trim() : undefined
      return name ? { sql: j.sql.trim(), name } : { sql: j.sql.trim() }
    }
    if (typeof j?.question === 'string' && j.question.trim()) return { question: j.question.trim() }
  } catch { /* نرجع null */ }
  return null
}

export function summarySystem(): string {
  const o = ownerName(), a = assistantName()
  return `أنت "${a}"، مساعد ${o}. عندك سؤاله ونتيجة استعلام من قاعدة بياناته.
اكتب خلاصة قصيرة (سطر إلى ثلاثة) بالسعودي تجاوب سؤاله مباشرة بالمعنى (أرقام ونتيجة واضحة، بلا أسماء أعمدة ولا مصطلحات تقنية) من النتيجة فقط — لا تخترع أرقاماً ولا تفاصيل غير موجودة.
القيم "•••" محجوبة: لا تحاول تخمينها. إذا النتيجة فاضية قلها بصراحة. نص عادي فقط بدون جداول.`
}

/** الصفوف للنموذج: محجوبة مسبقاً، والقيم مقصوصة */
export function summaryUserPrompt(question: string, columns: string[], rows: Record<string, unknown>[], truncated: boolean): string {
  const data = rows.map((r) => Object.fromEntries(columns.map((c) => [c, cellText(r[c], 80)])))
  return `السؤال: ${question}\nعدد الصفوف: ${rows.length}${truncated ? ' (فيه أكثر، عرضت أول ٥٠)' : ''}\nالنتيجة (JSON):\n${JSON.stringify(data).slice(0, 12_000)}`
}
