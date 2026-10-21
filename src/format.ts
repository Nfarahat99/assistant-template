import { assistantName, isProgrammer } from './profile.js'
import type { Task, Pending, DbAudit } from './store.js'
import { formatWhen, startOfLocalDay } from './lib/time.js'
import { displayPhone } from './lib/phone.js'
import { taskRecurrence, nextOccurrence } from './lib/recurrence.js'

/** نصوص الردود — قصيرة وبالسعودي */

export type TaskFilter = 'today' | 'overdue' | 'all' | 'week'

/**
 * الموعد الفعلي للعرض. المتكررة: الموعد القادم دائماً — لا تظهر "متأخرة" من أيام مضت أبداً
 * (لو بقي remind_at في الماضي لأي سبب نحسب القادم بدلاً منه).
 */
export function effectiveAt(t: Task, now: Date, tz: string): Date | null {
  const r = taskRecurrence(t)
  if (r) {
    const e = t.remind_at ?? t.due_at
    return e && e.getTime() >= now.getTime() ? e : nextOccurrence(r, now, tz)
  }
  return t.due_at ?? t.remind_at
}
const isRecurring = (t: Task) => !!taskRecurrence(t)

export function filterTasks(tasks: Task[], filter: TaskFilter, now: Date, tz: string): Task[] {
  const endToday = startOfLocalDay(now, tz, 1)
  const endWeek = startOfLocalDay(now, tz, 7)
  switch (filter) {
    case 'overdue': return tasks.filter((t) => { const e = effectiveAt(t, now, tz); return !!e && e < now && !isRecurring(t) })
    case 'today': return tasks.filter((t) => { const e = effectiveAt(t, now, tz); return !!e && e < endToday })
    case 'week': return tasks.filter((t) => { const e = effectiveAt(t, now, tz); return !!e && e < endWeek })
    default: return tasks
  }
}

export function taskLine(t: Task, now: Date, tz: string): string {
  const e = effectiveAt(t, now, tz)
  const rec = isRecurring(t)
  const when = e ? ` — ${formatWhen(e, now, tz)}${rec ? ' 🔁' : e < now ? ' ⚠️' : ''}` : ''
  const pr = t.priority === 'high' ? ' 🔴' : ''
  return `${t.id}. ${t.title}${when}${pr}`
}

const TITLES: Record<TaskFilter, string> = {
  today: 'مهام اليوم', overdue: 'المتأخرة', week: 'مهام الأسبوع', all: 'مهامك المفتوحة',
}

export function formatTaskList(tasks: Task[], filter: TaskFilter, now: Date, tz: string): string {
  const list = filterTasks(tasks, filter, now, tz)
  if (!list.length) {
    return filter === 'all' ? 'ما عندك مهام مفتوحة 👌' : `ما فيه شي في ${TITLES[filter]} 👌`
  }
  return `📋 ${TITLES[filter]} (${list.length}):\n${list.map((t) => taskLine(t, now, tz)).join('\n')}\n\nللإنجاز: خلصت <رقم>`
}

export function morningBrief(tasks: Task[], now: Date, tz: string, reminders: Task[] = []): string {
  const endToday = startOfLocalDay(now, tz, 1)
  const today = tasks.filter((t) => { const e = effectiveAt(t, now, tz); return !!e && e >= now && e < endToday })
  const overdue = filterTasks(tasks, 'overdue', now, tz)
  const undated = tasks.filter((t) => !effectiveAt(t, now, tz))
  const parts = ['صباح الخير ☀️']
  // التذكيرات المتأخرة لمرة واحدة تبقى ظاهرة؛ المتكررة تظهر بموعدها القادم إن كان اليوم فقط
  const todayReminders = reminders.filter((t) => { const e = effectiveAt(t, now, tz); return !!e && e < endToday })
  if (todayReminders.length) parts.push(`⏰ تذكيرات ومواعيد اليوم:\n${todayReminders.map((t) => taskLine(t, now, tz)).join('\n')}`)
  if (!today.length && !overdue.length && !todayReminders.length) parts.push('ما عندك مواعيد اليوم.')
  if (today.length) parts.push(`اليوم:\n${today.map((t) => taskLine(t, now, tz)).join('\n')}`)
  if (overdue.length) parts.push(`متأخرة:\n${overdue.map((t) => taskLine(t, now, tz)).join('\n')}`)
  if (undated.length) parts.push(`بدون موعد: ${undated.length} مهمة — اكتب "مهامي" تشوفها`)
  return parts.join('\n\n')
}

export function eveningReview(tasks: Task[], now: Date, tz: string): string {
  if (!tasks.length) return 'مساء الخير 🌙 ما عندك مهام مفتوحة، يومك نظيف 👌'
  const shown = tasks.slice(0, 15)
  return `مساء الخير 🌙 هذي مهامك المفتوحة:\n${shown.map((t) => taskLine(t, now, tz)).join('\n')}${tasks.length > shown.length ? `\n… و${tasks.length - shown.length} غيرها` : ''}\n\nوش خلّصت منها؟ رد: خلصت <رقم>`
}

/** "لأحمد" ، "للمدير" بدل "لالمدير" */
export function toName(name: string): string {
  return name.startsWith('ال') ? `ل${name.slice(1)}` : `ل${name}`
}

export function pendingPreview(p: Pending, openCount: number, cc: string): string {
  const tag = openCount > 1 ? `[${p.short_no}] ` : ''
  const n = openCount > 1 ? ` ${p.short_no}` : ''
  const pl = p.payload
  switch (p.kind) {
    case 'send_whatsapp':
      return `${tag}بأرسل ${toName(pl.name)} (${displayPhone(pl.phone, cc)}):\n«${pl.signed}»\nأرسل؟ رد: نعم${n} / لا${n} / عدّل${n}: <النص الجديد>`
    case 'code_change':
      // لم يُنفَّذ شيء بعد — التشغيل فقط بعد "نعم N"
      return `[${p.short_no}] 📝 جهزت الطلب (ما نفّذته بعد) — بأطلب من Claude تعديل على ${pl.folder} (${pl.repo}):\n«${pl.request}»${pl.report_only ? '\n📋 تقرير فقط — Claude يفحص ويكتب نتائجه بدون تعديل كود ولا PR.' : ''}${pl.linked ? `\n🔗 مرتبط بـ ${pl.linked} — أرسل لـ Claude عقد الربط وطلبات المستودعين.` : ''}${pl.evidence_summary ? `\n\n${pl.evidence_summary}\n` : ''}${pl.corrections ? `\n📌 أرسل معه كلامك حرفياً + ${pl.corrections} تصحيح منك كقيود ملزمة.` : ''}\nأنفّذه؟ رد: نعم ${p.short_no} / لا ${p.short_no} / عدّل ${p.short_no}: <الطلب الجديد>`
    case 'merge_pr':
      // الدمج دائماً برقم صريح — "نعم" وحدها لا تكفي
      return `[${p.short_no}] ✅ جاهز التعديل في ${pl.project}:\n${verificationBlock(pl.verification)}${mergeWarnings(pl)}${pl.summary}\n${pl.files} ملفات (+${pl.additions}/-${pl.deletions})${ciQueriesLine(pl.ci_queries) ? `\n${ciQueriesLine(pl.ci_queries)}` : ''}\n${pl.pr_url}\nأدمجه؟ رد: نعم ${p.short_no} / لا ${p.short_no} (أو رد على هذي الرسالة بـ نعم)`
    case 'railway_redeploy':
      // لم يُنفَّذ شيء بعد — إعادة النشر فقط بعد "نعم N"
      return `[${p.short_no}] 🚂 جهزت إعادة نشر (ما نفّذتها بعد): ${pl.project} / ${pl.service} (${pl.environment})\nأنفّذها؟ رد: نعم ${p.short_no} / لا ${p.short_no}`
    case 'db_write':
      // تجربة داخل معاملة رُجعت (ROLLBACK) — لم يتغير شيء بعد؛ التنفيذ فقط بعد "نعم N"
      return `[${p.short_no}] 📝 جهزت التعديل (ما نفّذته بعد) على قاعدة ${pl.db_name}:
«${pl.request}»
${pl.sql}
يأثر على ${pl.expected} صف${pl.no_where ? ' ⚠️ بدون شرط WHERE' : ''}.${pl.preview ? `
عيّنة:
${pl.preview}` : ''}
أنفّذه؟ رد: نعم ${p.short_no} / لا ${p.short_no}`
    case 'group_reply':
      // لم يُرسل شيء للقروب بعد — الإرسال فقط بعد "نعم N"
      return `[${p.short_no}] 👥 جهزت رد على قروب «${pl.group_name}» (ما أرسلته بعد):\n«${pl.text}»\nأرسله للقروب؟ رد: نعم ${p.short_no} / لا ${p.short_no}`
    case 'project_items':
      // بيانات المالك نفسه — لا شيء يُحفظ/يُحذف قبل الموافقة
      return `[${p.short_no}] ${pl.preview}
${pl.ask} رد: نعم ${p.short_no} / لا ${p.short_no}`
    case 'save_contact':
      return `${tag}الرقم ${displayPhone(pl.phone, cc)} محفوظ باسم «${pl.old_name}». أغيّره إلى «${pl.name}»؟\nرد: نعم${n} / لا${n}`
  }
}

/** التحقق أولاً وبوضوح — undefined = حمولة قديمة قبل الميزة (لا شيء يُعرض) */
export function verificationBlock(v: string | null | undefined): string {
  if (v === undefined) return ''
  if (!v) return '⚠️ بدون تحقق — وصف الـ PR ما فيه قسم «## التحقق» (ما ذكر Claude كيف تأكد إن التعديل صحيح). راجع قبل الدمج.\n\n'
  return `🧪 التحقق:\n${v}\n\n`
}

/** تحذيرات الدمج: اختبارات ما اشتغلت، سكربت بيانات بلا dry-run (كلاهما يحتاج «نعم N بدون فحص»)، وتجاوز النطاق */
export function mergeWarnings(pl: { tests_not_run?: string | null; no_dry_run?: string[] | null; scope_note?: string | null }): string {
  const w: string[] = []
  if (pl.tests_not_run) w.push(`⛔ الاختبارات ما اشتغلت حسب وصف الـ PR: «${pl.tests_not_run}» — الدمج يحتاج «نعم N بدون فحص».`)
  if (pl.no_dry_run?.length) w.push(`⛔ سكربت بيانات/ترحيل بدون نتيجة dry-run: ${pl.no_dry_run.join('، ')} — لا تشغيل فعلي قبل تجربة؛ الدمج يحتاج «نعم N بدون فحص».`)
  if (pl.scope_note) w.push(`🚧 خارج المطلوب: ${pl.scope_note}`)
  return w.length ? w.join('\n') + '\n\n' : ''
}

/** "🔎 Claude استعلم N مرة من قواعد البيانات (falak، qandeel)" — فاضي إن لم يستعلم */
export function ciQueriesLine(s: { count: number; dbs: string[] } | null | undefined): string {
  if (!s?.count) return ''
  return `🔎 Claude استعلم ${s.count} مرة من قواعد البيانات (${s.dbs.join('، ')})`
}

/** "استعلامات كلود": آخر استدعاءات بوابة CI (قراءة فقط) — الاستعلام والعدد فقط، بلا نتائج */
export function formatCiAudit(rows: DbAudit[], now: Date, tz: string): string {
  if (!rows.length) return 'ما استعلم Claude (GitHub Actions) من قواعد البيانات للحين.'
  const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
  return `🔎 آخر استعلامات Claude من قواعد البيانات (قراءة فقط):\n${rows.map((r) => {
    const repo = (r.repo ?? '?').split('/').pop()
    const res = r.ok ? `${r.row_count ?? 0} صف` : `❌ ${clip(r.error ?? '', 60)}`
    return `• ${formatWhen(r.ts, now, tz)} — ${repo} ← ${r.db_key}${r.request_id ? ` (طلب ${r.request_id})` : ''}: ${res}${r.purpose ? `\n  الغرض: ${clip(r.purpose, 80)}` : ''}\n  ${clip(r.sql, 120)}`
  }).join('\n')}`
}

export function pendingSummary(p: Pending, cc: string): string {
  const pl = p.payload
  switch (p.kind) {
    case 'send_whatsapp': return `إرسال رسالة ${toName(pl.name)} (${displayPhone(pl.phone, cc)}): «${pl.text}»`
    case 'code_change': return `تعديل كود على ${pl.folder}: «${pl.request}»`
    case 'merge_pr': return `دمج PR في ${pl.project}: ${pl.pr_url}`
    case 'railway_redeploy': return `إعادة نشر ${pl.project} / ${pl.service} (${pl.environment}) على Railway`
    case 'db_write': return `تعديل قاعدة ${pl.db_name}: «${pl.request}» (${pl.expected} صف)`
    case 'group_reply': return `رد على قروب «${pl.group_name}»: «${pl.text}»`
    case 'project_items': return String(pl.summary ?? 'بنود مشروع')
    case 'save_contact': return `تغيير اسم ${displayPhone(pl.phone, cc)} من «${pl.old_name}» إلى «${pl.name}»`
  }
}

export function help(): string {
  return `أنا ${assistantName()}، مساعدك 🤝 أرسل لي صوتية أو نص:
• "ذكرني أتصل بالبنك بكرة ١٠ الصبح"
• "أضف مهمة: أراجع العقد"
• "ذكرني أقرأ وردي كل يوم الساعة ٩ الليل" (تذكير متكرر 🔁) — "وقف تذكير 5" يوقفه
• "مهامي" / "اليوم" / "خلصت 3"
• "قل لأحمد إني بتأخر" (أعرض عليك قبل الإرسال)
• "احفظ رقم سامي 0555..."
${isProgrammer() ? '• "عدّل في مشروع واتساب سراج: ..." (أطلب موافقتك قبل التنفيذ والدمج)' : '• "طوّر نفسك: أضف تذكيراً بموعد الدواء" (أطلب موافقتك قبل التنفيذ والدمج)'}
• "وقف الملخص" / "شغل الملخص"
• "ابدأ المقابلة" (أسئلة قصيرة أتعرف فيها عليك)`
}
