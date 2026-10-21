/** تذكيرات الورد القرآني: أوقات عشوائية متفرقة داخل نافذة اليوم، تُحدَّد مرة لكل يوم وتُحفظ في kv */

const MESSAGES = [
  '📖 وقت الورد القرآني — ولو صفحة وحدة تكفي اليوم.',
  '🌿 تذكير لطيف: خذ لك دقائق مع كتاب الله.',
  '📖 ورد القرآن ينتظرك — بسم الله.',
  '🤲 لا تنسى وردك من القرآن اليوم.',
  '✨ استراحة مع القرآن؟ افتح المصحف وكمّل من حيث وقفت.',
]

/** أدنى فجوة (بالدقائق) نستهدفها بين تذكيرات الورد حين تسمح النافذة */
const MIN_WIRD_GAP_MIN = 61

/** sig: بصمة الإعدادات (تُعاد الخطة عند تغييرها)، base: ما أُرسل اليوم قبل إعادة التوليد */
export interface WirdPlan { day: string; times: number[]; sent: number; sig?: string; base?: number }

/**
 * يوزّع count أوقات (بالدقائق من منتصف الليل) بشكل عشوائي لكن متفرق:
 * النافذة تُقسَّم لقطاعات متساوية ويُختار وقت عشوائي داخل وسط كل قطاع، فلا تتجاور التذكيرات.
 */
export function planWirdTimes(count: number, fromMin: number, toMin: number, rng: () => number = Math.random): number[] {
  const span = toMin - fromMin
  if (count < 1 || span < 1) return []
  const n = Math.min(count, span)
  const seg = span / n
  // أدنى فجوة مضمونة بين تذكيرين متجاورين (دقيقة): 61 حيث تتسع القطاعات، وإلا نصف القطاع.
  // فجوة الأوقات الحقيقية ≥ gap دائماً (لأن pad = gap/2 على جانبي كل قطاع)، فلا يكسرها التقريب إلى أسفل.
  const gap = Math.min(MIN_WIRD_GAP_MIN, seg * 0.5)
  const pad = gap / 2
  return Array.from({ length: n }, (_, i) => Math.floor(fromMin + i * seg + pad + rng() * Math.max(0, seg - gap)))
}

export function pickWirdMessage(rng: () => number = Math.random): string {
  return MESSAGES[Math.floor(rng() * MESSAGES.length)]
}

/** الرسالة المختارة لليوم: day = تاريخ آخر اختيار، idx = فهرسها في MESSAGES */
export interface WirdDaily { day: string; idx: number }

/**
 * إن اختلف اليوم عن تاريخ آخر اختيار يُختار فهرس جديد عشوائياً (يختلف عن فهرس أمس) ويُحدَّث التاريخ؛
 * وإلا تبقى رسالة اليوم نفسها فلا تتغير داخل اليوم.
 */
export function dailyWirdMessage(prev: WirdDaily | null, day: string, rng: () => number = Math.random): { daily: WirdDaily; message: string; changed: boolean } {
  if (prev && prev.day === day && Number.isInteger(prev.idx) && MESSAGES[prev.idx]) {
    return { daily: prev, message: MESSAGES[prev.idx], changed: false }
  }
  const last = prev && Number.isInteger(prev.idx) ? prev.idx : -1
  const pool = MESSAGES.map((_, i) => i).filter((i) => i !== last)
  const idx = pool[Math.floor(rng() * pool.length)]
  return { daily: { day, idx }, message: MESSAGES[idx], changed: true }
}

/**
 * يُستدعى كل دقيقة. يرجع true إن حان تذكير للإرسال الآن.
 * التذكيرات الفائتة بأكثر من ساعة (توقف الخدمة مثلاً) تُهمل بدل إرسالها متأخرة.
 */
export function advanceWird(plan: WirdPlan, mins: number): { plan: WirdPlan; fire: boolean } {
  let sent = plan.sent
  let fire = false
  while (sent < plan.times.length && plan.times[sent] <= mins) {
    if (mins - plan.times[sent] <= 60) fire = true
    sent++
  }
  return { plan: { ...plan, sent }, fire }
}

/** مهمة ورد قرآني (قراءة/تسميع/حفظ/ختمة…) حسب عنوانها */
export function isWirdTask(title: string): boolean {
  return /ورد|قرآن|القران|قران|مصحف|تسميع|سمّع|سمع|ختمة|حفظ|تلاوة|وجه القرآن|سورة|جزء/.test(title)
}

/**
 * بوابة إتمام الورد: لا إتمام إلا بنطاق (من أي آية إلى أي آية، أو الجزء المسموع) وتأكيد إكمال المقدار.
 * ترجع نص الطلب للمستخدم إن نقص شيء، أو null إن اكتمل الشرطان.
 */
export function wirdCompletionGate(title: string, range?: string, confirmed?: boolean): string | null {
  const hasRange = !!range && range.trim().length > 0
  if (!hasRange) {
    return `📖 قبل ما أقفل «${title}»: من أي آية إلى أي آية قرأت (أو أي جزء سمّعت/سمعت)؟ وهل أكملت المقدار المطلوب؟`
  }
  if (confirmed !== true) {
    return `📖 سجّلت النطاق «${range!.trim()}» لـ«${title}» — أكّد لي إنك أكملت المقدار المطلوب داخله وأقفلها.`
  }
  return null
}
