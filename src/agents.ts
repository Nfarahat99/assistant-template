/**
 * فريق وكلاء Claude Code: توزيع المهمة على المتخصص المناسب وصياغة توجيه (brief) جاهز للصق في Claude Code.
 * قواعد الكلمات المفتاحية حتمية (بلا نموذج) فتكون النتيجة قابلة للاختبار والتوقّع.
 */
export interface TeamAgent {
  key: string
  name: string        // الاسم بالعربي
  skill: string       // مهارة Claude Code
  domain: string
  keywords: RegExp
}

export const TEAM: TeamAgent[] = [
  { key: 'mohammed', name: 'محمد', skill: 'next-best-practices', domain: 'Next.js',
    keywords: /next\.?js|نكست|app router|server component|react|ريأكت|صفحة|route|ssr|ssg/i },
  { key: 'sami', name: 'سامي', skill: 'nodejs-backend-patterns', domain: 'Node.js backend',
    keywords: /node|api|endpoint|باك ?اند|backend|سيرفر|خادم|express|fastify|قاعدة بيانات|database|sql|postgres|webhook|ويب ?هوك|مصادقة|auth/i },
  { key: 'hammam', name: 'همام', skill: 'ui-ux-pro-max', domain: 'UI/UX',
    keywords: /تصميم|واجهة|ui|ux|css|ستايل|لون|ألوان|خط |responsive|جوال|لوحة التحكم|dashboard|زر|شكل|رتل/i },
  { key: 'samer', name: 'سامر', skill: 'webapp-testing', domain: 'الاختبارات',
    keywords: /اختبار|اختبر|test|تست|playwright|e2e|تغطية|coverage|regression/i },
  { key: 'zain', name: 'زين', skill: 'senior-devops', domain: 'DevOps',
    keywords: /railway|ريلواي|نشر|deploy|docker|ci\/?cd|github actions|pipeline|بنية|infra|مراقبة|monitor|env|متغيرات|دومين|domain/i },
  { key: 'ibrahim', name: 'إبراهيم', skill: 'superpowers:code-reviewer', domain: 'مراجعة الكود',
    keywords: /مراجعة|راجع|review|جودة الكود|refactor|أمان|security|ثغرة/i },
  { key: 'omar', name: 'عمر', skill: 'agent-evaluation', domain: 'ضمان الجودة (QA)',
    keywords: /تقييم|qa|قيّم|جودة|evaluate|benchmark/i },
]

export interface Routing { agent: TeamAgent; score: number }

/** يرتّب الوكلاء حسب عدد الكلمات المفتاحية المطابقة؛ بلا مطابقة ← سامي (الباك إند) كافتراض للمهام البرمجية العامة */
export function routeTask(text: string, forced?: string): Routing[] {
  if (forced) {
    const f = forced.trim().toLowerCase()
    const hit = TEAM.find((a) => a.key === f || a.name === forced.trim() || a.skill === f)
    if (hit) return [{ agent: hit, score: 99 }]
  }
  const scored = TEAM.map((agent) => {
    const g = new RegExp(agent.keywords.source, 'gi')
    return { agent, score: (text.match(g) ?? []).length }
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score)
  if (!scored.length) return [{ agent: TEAM.find((a) => a.key === 'sami')!, score: 0 }]
  // الرئيسي + أي وكيل آخر بنفس الوزن تقريباً (حد أقصى ٣)
  const top = scored[0].score
  return scored.filter((r) => r.score >= Math.max(1, top - 1)).slice(0, 3)
}

/** توجيه جاهز للصقه في جلسة Claude Code (اللابتوب) */
export function buildBrief(a: { task: string; project?: string | null; agent: TeamAgent; others?: TeamAgent[] }): string {
  const lines = [
    `الوكيل: ${a.agent.name} (${a.agent.domain}) — المهارة: ${a.agent.skill}`,
    a.project ? `المشروع: ${a.project}` : null,
    `المهمة: ${a.task.trim()}`,
    'التوجيه:',
    `1) استخدم مهارة ${a.agent.skill} أولاً قبل أي عمل منفرد.`,
    '2) اقرأ الكود المعني وحدّد أصغر تعديل يحقق المطلوب، بلا توسّع خارج النطاق.',
    '3) اشغّل lint/typecheck/tests الموجودة في المشروع وأصلح ما كسرته.',
    '4) اعمل على فرع جديد وافتح PR بملخص عربي/إنجليزي، ولا تدفع على main ولا تلتزم بأسرار.',
    a.others?.length ? `تنسيق: تتقاطع المهمة مع ${a.others.map((o) => `${o.name} (${o.domain})`).join('، ')} — اترك لهم الجزء الخاص بهم.` : null,
  ]
  return lines.filter(Boolean).join('\n')
}

/** خطة كاملة: مهمة ← وكلاء ← توجيه لكل وكيل */
export function planDispatch(task: string, opts: { project?: string | null; agent?: string } = {}): { routing: Routing[]; briefs: { agent: TeamAgent; brief: string }[] } {
  const routing = routeTask(task, opts.agent)
  const briefs = routing.map((r) => ({
    agent: r.agent,
    brief: buildBrief({ task, project: opts.project, agent: r.agent, others: routing.filter((o) => o !== r).map((o) => o.agent) }),
  }))
  return { routing, briefs }
}

export function formatDispatch(task: string, plan: ReturnType<typeof planDispatch>): string {
  const head = `🧭 وزّعت المهمة «${task.slice(0, 80)}» على: ${plan.briefs.map((b) => b.agent.name).join('، ')}`
  return `${head}\n\n${plan.briefs.map((b) => `━━ ${b.agent.name} ━━\n${b.brief}`).join('\n\n')}\n\n⚠️ هذا توجيه مكتوب فقط — ما أحد شغال عليه الحين. للتنفيذ الفوري قل «نفّذها على <المشروع>» (Claude في GitHub)، أو «احفظها للابتوب».`
}
