import { isProgrammer, ownerName } from './profile.js'
import { claudeConfigProject } from './projects.js'
/**
 * ما يعرفه البوت عن نفسه — يُحقن في برومبت النموذج كل مرة (حالة حيّة لا نص ثابت)،
 * ويُعرض للمالك في "وش تقدر تسوي". الهدف: لا ينكر قدرة عنده، ولا يدّعي قدرة ليست عنده.
 */
export interface SelfState {
  githubConnected: boolean
  githubOwner: string
  projects: { label: string; repo: string }[]
  selfRepo: string
  telegram: 'bound' | 'unbound' | 'off'
  whatsapp: { status: string; banned: boolean; reason?: string | null }
  /** false = تيليجرام فقط (واتساب غير مربوط) */
  whatsappEnabled?: boolean
  sendMode: 'link' | 'direct'
  version: string | null
  recentJobs: { project: string; status: string; url: string | null }[]
  /** أعطال حقيقية مسجّلة (نوع الخطأ + رسالته) — المصدر الوحيد المسموح لشرح "ليش فشل" */
  lastFailures?: { when: string; what: string; error: string }[]
  webSearch?: boolean
  railway?: boolean
  /** خدمات Railway (من ذاكرة مؤقتة) — مشروع/خدمة، نشر تلقائي، الدومين العام */
  railwayServices?: { project: string; service: string; autoDeploy: boolean; repo: string | null; domain: string | null }[]
  /** نص كيف يُضاف التوكن إن لم يوجد */
  railwayMissing?: string
  /** قواعد بيانات المشاريع المربوطة (أسماء فقط، بلا عناوين) ومفتاح الميزة */
  databases?: string[]
  dbAccess?: boolean
  /** نموذج الذكاء الفعلي — من الإعدادات وآخر رد، لا من الذاكرة */
  llm?: { primary: string; fallback: string; lastServed?: string | null }
}

const WA_AR: Record<string, string> = {
  connected: 'متصل', connecting: 'يحاول الاتصال', qr: 'ينتظر مسح QR', logged_out: 'مسجّل خروج',
  disconnected: 'مقطوع', paused: 'موقوف', unreachable: 'الوسيط لا يرد', banned: 'محظور',
}

export function waStatusAr(w: SelfState['whatsapp']): string {
  if (w.banned) return 'محظور من واتساب ⛔'
  return WA_AR[w.status] ?? w.status
}

/** يُلحق ببرومبت النظام */
export function capabilitiesForPrompt(s: SelfState): string {
  const claudeCfg = claudeConfigProject()
  const lines = [
    '── حقائق عنك (حالة حيّة — اعتمد عليها ولا تنكرها؛ وإذا تعارضت مع ردودك السابقة في المحادثة فهذه هي الصحيحة وردودك السابقة كانت خطأ) ──',
    s.githubConnected
      ? (!isProgrammer()
        ? `• تقدر تطوّر نفسك فقط (مستودعك ${s.selfRepo}): يطلب ${ownerName()} الميزة بكلامه ← تشرحها له ببساطة ← بعد "نعم N" يشتغل Claude ويفتح طلب ← تشرح له وش تغيّر ← يندمج بعد موافقته. ما تقدر تعدّل مشاريع ثانية.`
        : `• أنت مربوط بـ GitHub (الحساب ${s.githubOwner}). تقدر تشغّل Claude Code على أي مشروع من القائمة عبر GitHub Actions ← يفتح PR ← ${ownerName()} يوافق ← تدمجه. استخدم code_change لهذا.`)
      : '• GitHub غير مربوط الآن (لا GITHUB_TOKEN) — تعديلات الكود غير متاحة حالياً؛ قلها بصراحة.',
    `• مشروعك أنت (البوت نفسه): ${s.selfRepo} — أي شكوى من خلل فيك أو طلب ميزة جديدة لك = اقترح code_change على project_query "البوت".`,
    `• عدد المشاريع المتاحة: ${s.projects.length} (اكتب "مشاريعي" لعرضها).`,
    ...(s.llm ? [`• نموذج الذكاء: الأساسي ${s.llm.primary}، والاحتياطي ${s.llm.fallback} (يُستخدم فقط إذا فشل الأساسي).${s.llm.lastServed ? ` آخر رد فعلي جاء من: ${s.llm.lastServed}.` : ''} إذا سُئلت "على أي نموذج أنت؟" جاوب بهذا بالضبط — لا تخمّن من ذاكرتك.`] : []),
    ...(s.whatsappEnabled === false
      ? [`• القنوات: تيليجرام ${s.telegram === 'bound' ? 'مربوط ✅' : s.telegram === 'unbound' ? 'مفعّل لكن غير مربوط' : 'غير مفعّل'}.`, '• واتساب غير مربوط بعد — يُربط من لوحة التحكم (الحسابات).']
      : [
    `• القنوات: تيليجرام ${s.telegram === 'bound' ? 'مربوط ✅' : s.telegram === 'unbound' ? 'مفعّل لكن غير مربوط' : 'غير مفعّل'}، واتساب البوت: ${waStatusAr(s.whatsapp)}.`,
    s.sendMode === 'link'
      ? `• إرسال الرسائل للناس: وضع link — تعطي ${ownerName()} رابط wa.me يرسله هو من رقمه. رقم البوت لا يراسل أحداً غيره أبداً.`
      : '• إرسال الرسائل للناس: مباشر من رقم البوت (فقط لمن راسل البوت خلال ٢٤ ساعة) وبعد موافقة.',
      ]),
    '• تقرأ: نصوص، صوتيات، رسائل محوّلة، لقطات شاشة محادثات، وروابط يوتيوب (تلخيص).',
    s.webSearch !== false
      ? '• عندك بحث ويب حقيقي (Google Search عبر Gemini) بإجراء web_search — للأخبار والمعلومات الحالية، والروابط تأتي من نتائج البحث فقط.'
      : '• بحث الويب غير متاح الآن (لا مفتاح Gemini).',
    s.railway
      ? '• عندك وصول Railway (قراءة + إعادة نشر بموافقة): railway_status لحالة المشاريع والخدمات وآخر نشر وسجل النشرات وأسماء المتغيرات (بلا قيم)، وبعد كل دمج تتأكد بنفسك إن النشر نجح. الكتابة الوحيدة: railway_redeploy بعد «نعم N». لا تقل أبداً "ما عندي وصول لريلواي".'
      : `• Railway غير مربوط الآن. إن سُئلت قل بالضبط: ${s.railwayMissing ?? 'ناقص RAILWAY_API_TOKEN'}`,
    `• تراقب Railway تلقائياً كل دقيقتين وتنبّه ${ownerName()} فوراً عند سقوط خدمة/قاعدة أو فشل نشر. توزّع المهام على فريق الوكلاء (محمد Next.js، سامي باك إند، همام UI/UX، سامر اختبارات، زين DevOps، إبراهيم مراجعة، عمر QA) بإجراء agent_dispatch، وتجهّز مسودات للمهام التي تحتاج اللابتوب (laptop_draft / laptop_list / laptop_update).`,
    '• تنبيه صدق: agent_dispatch و laptop_draft مجرد نص/مسودة — ما يشغّلان أحداً. لا تقل أبداً "جاري" أو "ننتظر سامي" عنها؛ الشي الوحيد اللي "يشتغل" فعلاً هو طلبات الكود المرسلة لـ GitHub (تظهر في "طلباتي"). إذا سُئلت عن مهمة موزّعة قل إنها توجيه لم يُنفَّذ واعرض تنفيذها عبر code_change.',
    '• عندك متتبّع مشاريع بزنس (لا تقني): بنود كل مشروع (إطلاق، دومين، تسويق، ميزة، مبيعات، محتوى، إداري) بإجراءات project_item_add / project_item_update / project_item_delete / project_items / project_stage / project_checklist / project_suggest، وترسل موجزاً يومياً بأهم الخطوات (والأحد ملخّصاً أسبوعياً). البنود من القاعدة فقط — لا تخترع بنداً ولا حالة.',
    '• ما تقرأ الكود بنفسك ولا تشغّل سكربتات أو أوامر على السيرفرات/قواعد الإنتاج. "تم التأكيد/تأكدت/راجعت" فقط إذا نفّذت فحصاً فعلياً في هذا الدور (db_query، railway_status، code_search…)؛ التحقق من سلوك في الكود = code_change بطلب تقرير أو code_search — لا ادعاء.',
    '• حالة نشر Railway "REMOVED" تعني إن نشراً أقدم استُبدل بنشر أحدث (أو أُلغي) — ليست حذفاً للمشروع ولا للخدمة. لا تقل أبداً إن مشروعاً "انحذف" بسببها؛ الحالة الفعلية = آخر نشر للخدمة.',
    '• تقدر تبحث في كود أي مشروع على GitHub (code_search) وترجع مسارات الملفات — لا تستخدم بحث الويب لكود مشاريعه.',
    `• تقدر تقارن تقنيات (research_tech) وتبحث عن مهارات Claude في skills.sh (find_skills)${claudeCfg ? ` وتثبّتها بطلب كود على ${claudeCfg.repo}` : ''}.`,
  ]
  if (s.railway && s.railwayServices?.length) {
    lines.push('• خدمات Railway (المشروع/الخدمة — نشر تلقائي — الرابط العام):')
    for (const x of s.railwayServices.slice(0, 40)) {
      lines.push(`  - ${x.project}/${x.service} — ${x.autoDeploy ? `نشر تلقائي من ${x.repo}` : 'رفع يدوي'}${x.domain ? ` — https://${x.domain}` : ''}`)
    }
  }
  if (s.databases !== undefined) {
    if (s.dbAccess === false) lines.push('• الوصول لقواعد بيانات المشاريع موقف من لوحة التحكم — قلها بصراحة إذا سُئلت.')
    else if (!s.databases.length) lines.push('• لا توجد قواعد بيانات مشاريع مربوطة الآن (DB_CONNECTIONS ناقص) — لا تدّعي قراءتها.')
    else lines.push(`• عندك وصول لقواعد بيانات مشاريعه (Postgres): قراءة بإجراء db_query (استعلام SELECT فقط، والأعمدة الحساسة محجوبة)، وتعديل بإجراء db_write يعرض معاينة بعدد الصفوف ولا يُنفَّذ إلا بعد «نعم N». لا تخترع أرقاماً من البيانات — اسأل القاعدة. القواعد المتاحة: ${s.databases.join('، ')}`)
  }
  if (s.lastFailures?.length) {
    lines.push('• آخر الأعطال الحقيقية (لا تشرح فشلاً بغيرها):')
    for (const f of s.lastFailures.slice(0, 5)) lines.push(`  - ${f.when} — ${f.what}: ${f.error}`)
  } else {
    lines.push('• آخر الأعطال الحقيقية: لا شيء مسجّل.')
  }
  if (s.recentJobs.length) {
    lines.push('• آخر طلبات الكود:')
    for (const j of s.recentJobs.slice(0, 5)) lines.push(`  - ${j.project}: ${j.status}${j.url ? ` ${j.url}` : ''}`)
  }
  if (s.version) lines.push(`• نسختك: ${s.version}`)
  return lines.join('\n')
}

/** "وش تقدر تسوي" / "مساعدة" */
export function capabilitiesForOwner(s: SelfState): string {
  const prog = isProgrammer()
  const gh = s.githubConnected
    ? !prog
      ? '💻 طوّر نفسك: "طوّر نفسك: أضف تذكيراً بموعد الدواء" ← Claude يعدّل كودي ← أشرح لك وش تغيّر ← أدمجه بموافقتك'
      : `💻 تعديل الكود: "عدّل في <مشروع>: …" ← Claude Code على GitHub ← PR ← أوافق منك ← أدمج (${s.projects.length} مشروع — "مشاريعي")`
    : '💻 تعديل الكود: غير متاح الآن (GitHub غير مربوط)'
  return [
    'أقدر أسوي لك 👇',
    '📝 مهام وتذكيرات: "ذكرني أتصل بالبنك بكرة ١٠" · "مهامي" · "اليوم" · "خلصت 3"',
    '☀️ ملخص صباحي ومراجعة مسائية ("وقف الملخص" / "شغل الملخص")',
    ...(s.whatsappEnabled === false ? [] : [s.sendMode === 'link'
      ? '📨 رسائل للناس: "قل لأحمد إني بتأخر" ← رابط wa.me ترسله من رقمك'
      : '📨 رسائل للناس: "قل لأحمد …" ← معاينة ← نعم']),
    '↪️ ردودهم: حوّلها لي أو أرسل لقطة شاشة أو "رد أحمد: <نصه>" ← ملخص واقتراحات رد',
    '🗂️ "وش قال أحمد؟" · "وريني الرسائل" · "احفظ رقم سامي 05…"',
    gh,
    '📋 "طلباتي" — حالة طلبات الكود وروابطها والنشر',
    ...(prog ? ['🔎 "استعلامات كلود" — وش قرأ Claude (GitHub Actions) من قواعد البيانات أثناء طلبات الكود (قراءة فقط)'] : []),
    '🚂 "حالة ريلوي" · "انتشر؟" · "لوقات <مشروع>" · "أعد النشر <مشروع>" (بموافقتك)',
    '🎬 أرسل رابط يوتيوب ← ملخص وأهم النقاط',
    '🔎 "ابحث عن …" / "آخر أخبار AI" ← بحث ويب بمصادر حقيقية',
    '🗞️ موجز AI يومي (HN · GitHub · Hugging Face · مدونات AI) بروابط وتواريخ من المصادر — "أخبار AI الحين" للتشغيل الآن · "وقف النشرة"',
    '🧪 "وش أفضل أداة لـ…" / "قارن بين…" ← خيارات بمصادر وتوصية',
    ...(prog ? ['🧰 "دور لي مهارة لـ…" ← مهارات Claude من skills.sh ← "ثبّت 1" (طلب كود على إعدادات Claude)'] : []),
    '🚂 "وش حالة ريلواي؟" ← المشاريع والخدمات وآخر نشر (قراءة فقط)',
    ...(prog && s.databases?.length && s.dbAccess !== false
      ? [`🗄️ قواعد بيانات مشاريعك (${s.databases.length}): "كم طالب نشط في نبراس؟" · "ابحث عن طالب هويته …" — والتعديل بمعاينة و«نعم N»`]
      : []),
    '🧠 "ابدأ المقابلة" — ٨ أسئلة قصيرة أتعرف فيها عليك وأحفظها في ذاكرتي ("كمّل المقابلة" · "وقف المقابلة" · "تخطّ")',
    '🏷️ "نسختك" — آخر تحديث لي',
    s.whatsappEnabled === false
      ? `📡 الحالة: تيليجرام ${s.telegram === 'bound' ? '✅' : '—'}
• واتساب غير مربوط بعد — يُربط من لوحة التحكم (الحسابات).`
      : `📡 الحالة: تيليجرام ${s.telegram === 'bound' ? '✅' : '—'} · واتساب البوت: ${waStatusAr(s.whatsapp)}`,
    '🛠️ فيني خلل أو تبي ميزة جديدة؟ قل "طوّر نفسك: …" وأفتح طلب تعديل على كودي (بموافقتك).',
  ].join('\n')
}
