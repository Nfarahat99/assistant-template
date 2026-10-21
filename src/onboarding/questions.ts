import { ownerName, assistantName } from '../profile.js'

/** أسئلة المقابلة الشخصية (onboarding) — `ask` دالة لأن الاسمين من الملف الشخصي وقت التشغيل */
export const QUESTIONS = [
  { id: 'who', section: 'who', ask: () => `هلا ${ownerName()} 👋 أنا ${assistantName()}. خلني أعرفك أكثر عشان أخدمك صح — ٨ أسئلة قصيرة، جاوب بصوت أو كتابة، وتقدر تقول «تخطّ» أو «وقف المقابلة» أي وقت.\nإجاباتك تنحفظ عند مساعدك بس، وتقدر تعدّلها من اللوحة.\n\n١) عرّفني على نفسك: وش شغلك ومسؤولياتك؟` },
  { id: 'tracks', section: 'tracks', ask: () => '٢) وش الأشياء اللي تبيني أتابعها معك؟ مثل: شغلك، العائلة، مشروع معيّن، الذكاء الاصطناعي… اذكر لكل واحد هدفه باختصار.' },
  { id: 'people', section: 'people', ask: () => '٣) مين أهم الناس اللي تتعامل معهم، وكل واحد في أي مسار؟' },
  { id: 'routine', section: 'routine', ask: () => '٤) متى يبدأ يومك وينتهي؟ ومتى تبي الملخص الصباحي والمسائي؟' },
  { id: 'priorities', section: 'who', ask: () => '٥) وش أهم ٣ أشياء شاغلتك هالفترة؟' },
  { id: 'style', section: 'style', ask: () => '٦) كيف تبيني أكتب بالنيابة عنك؟ (رسمي، ودّي، مختصر…) وانسخ نص رسالة أو رسالتين كتبتها أنت والصقها هنا (لا تحوّلها).' },
  { id: 'language', section: 'style', ask: () => '٧) تفضّل ردودي عربي، إنجليزي، أو حسب لغة رسالتك؟' },
  { id: 'limits', section: 'limits', ask: () => '٨) وش الأشياء اللي ما تبيني أسويها أبداً؟ (مع إن أي إرسال لأي أحد يحتاج موافقتك دائماً)' },
] as const

export type QuestionId = typeof QUESTIONS[number]['id']
export type Section = 'who' | 'tracks' | 'people' | 'routine' | 'style' | 'limits'
