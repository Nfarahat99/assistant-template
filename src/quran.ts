/** تتبع موضع القراءة في المصحف (سورة/آية/جزء) وتقدّم الختمة — دوال نقية بلا اعتماد على البوت */

const SURAHS: [string, number][] = [
  ['الفاتحة', 7], ['البقرة', 286], ['آل_عمران', 200], ['النساء', 176], ['المائدة', 120], ['الأنعام', 165], ['الأعراف', 206], ['الأنفال', 75],
  ['التوبة', 129], ['يونس', 109], ['هود', 123], ['يوسف', 111], ['الرعد', 43], ['إبراهيم', 52], ['الحجر', 99], ['النحل', 128],
  ['الإسراء', 111], ['الكهف', 110], ['مريم', 98], ['طه', 135], ['الأنبياء', 112], ['الحج', 78], ['المؤمنون', 118], ['النور', 64],
  ['الفرقان', 77], ['الشعراء', 227], ['النمل', 93], ['القصص', 88], ['العنكبوت', 69], ['الروم', 60], ['لقمان', 34], ['السجدة', 30],
  ['الأحزاب', 73], ['سبأ', 54], ['فاطر', 45], ['يس', 83], ['الصافات', 182], ['ص', 88], ['الزمر', 75], ['غافر', 85],
  ['فصلت', 54], ['الشورى', 53], ['الزخرف', 89], ['الدخان', 59], ['الجاثية', 37], ['الأحقاف', 35], ['محمد', 38], ['الفتح', 29],
  ['الحجرات', 18], ['ق', 45], ['الذاريات', 60], ['الطور', 49], ['النجم', 62], ['القمر', 55], ['الرحمن', 78], ['الواقعة', 96],
  ['الحديد', 29], ['المجادلة', 22], ['الحشر', 24], ['الممتحنة', 13], ['الصف', 14], ['الجمعة', 11], ['المنافقون', 11], ['التغابن', 18],
  ['الطلاق', 12], ['التحريم', 12], ['الملك', 30], ['القلم', 52], ['الحاقة', 52], ['المعارج', 44], ['نوح', 28], ['الجن', 28],
  ['المزمل', 20], ['المدثر', 56], ['القيامة', 40], ['الإنسان', 31], ['المرسلات', 50], ['النبأ', 40], ['النازعات', 46], ['عبس', 42],
  ['التكوير', 29], ['الانفطار', 19], ['المطففين', 36], ['الانشقاق', 25], ['البروج', 22], ['الطارق', 17], ['الأعلى', 19], ['الغاشية', 26],
  ['الفجر', 30], ['البلد', 20], ['الشمس', 15], ['الليل', 21], ['الضحى', 11], ['الشرح', 8], ['التين', 8], ['العلق', 19],
  ['القدر', 5], ['البينة', 8], ['الزلزلة', 8], ['العاديات', 11], ['القارعة', 11], ['التكاثر', 8], ['العصر', 3], ['الهمزة', 9],
  ['الفيل', 5], ['قريش', 4], ['الماعون', 7], ['الكوثر', 3], ['الكافرون', 6], ['النصر', 3], ['المسد', 5], ['الإخلاص', 4],
  ['الفلق', 5], ['الناس', 6],
]

/** بداية كل جزء: [سورة، آية] */
const JUZ_STARTS: [number, number][] = [
  [1, 1], [2, 142], [2, 253], [3, 93], [4, 24], [4, 148], [5, 82], [6, 111], [7, 88], [8, 41],
  [9, 93], [11, 6], [12, 53], [15, 1], [17, 1], [18, 75], [21, 1], [23, 1], [25, 21], [27, 56],
  [29, 46], [33, 31], [36, 28], [39, 32], [41, 47], [46, 1], [51, 31], [58, 1], [67, 1], [78, 1],
]

const OFFSET: number[] = []
let acc = 0
for (const [, n] of SURAHS) { OFFSET.push(acc); acc += n }
export const TOTAL_AYAHS = acc // 6236

/** موضع في المصحف: السورة (١–١١٤) والآية */
export interface Pos { surah: number; ayah: number }

/** تقدّم الختمة: next = أول آية لم تُقرأ بعد، khatmas = عدد الختمات المكتملة */
export interface WirdProgress { next: Pos; khatmas: number; updated: string }

/** رقم الآية المطلق (٠-based) */
const abs = (p: Pos) => OFFSET[p.surah - 1] + p.ayah - 1
const fromAbs = (i: number): Pos => {
  let s = SURAHS.length - 1
  while (OFFSET[s] > i) s--
  return { surah: s + 1, ayah: i - OFFSET[s] + 1 }
}
const JUZ_ABS = JUZ_STARTS.map(([surah, ayah]) => abs({ surah, ayah }))

export const surahName = (n: number) => SURAHS[n - 1][0].replace('_', ' ')
export const juzOf = (p: Pos): number => JUZ_ABS.filter((s) => s <= abs(p)).length

const norm = (s: string) => s.replace(/[ً-ْـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/^ال/, '')
const BY_NAME = new Map(SURAHS.map(([n], i) => [norm(n), i + 1]))
const digits = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))

/**
 * يفهم نطاقاً حراً: «الحج والمؤمنون والنور والفرقان» (سور كاملة)، «البقرة 1-20»، «من البقرة 5 إلى آل عمران 10»، «الجزء 5».
 * يرجع أول آية وآخر آية مقروءة، أو null إن لم يُفهم.
 */
export function parseWirdRange(text: string): { from: Pos; to: Pos } | null {
  const t = digits(text).replace(/(آل|ال)\s+عمران/, 'آل_عمران')
  const juz = /(?:الجزء|جزء)\s*(\d{1,2})/.exec(t)
  if (juz) {
    const j = Number(juz[1])
    if (j < 1 || j > 30) return null
    return { from: fromAbs(JUZ_ABS[j - 1]), to: fromAbs((JUZ_ABS[j] ?? TOTAL_AYAHS) - 1) }
  }
  // رموز: اسم سورة ثم أرقام اختيارية
  const toks = t.split(/[\s,،؛:\-–—]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/).map((x) => x.replace(/^(?:و|من|الي|إلى|الى|سورة|سوره)(?=.)/, (m) => (/^(?:و|من)$/.test(m) ? '' : m))).filter(Boolean)
  const items: { surah: number; nums: number[] }[] = []
  for (let raw of toks) {
    if (/^(?:من|الى|إلى|الي|سورة|سوره|آية|اية|ايه|الآية|الاية|آيه)$/.test(raw)) continue
    if (/^\d+$/.test(raw)) { items.at(-1)?.nums.push(Number(raw)); continue }
    let id = BY_NAME.get(norm(raw))
    // «والمؤمنون» = و + المؤمنون
    if (!id && raw.startsWith('و')) id = BY_NAME.get(norm(raw.slice(1)))
    if (id) items.push({ surah: id, nums: [] })
  }
  if (!items.length) return null
  const first = items[0], last = items.at(-1)!
  const max = (s: number) => SURAHS[s - 1][1]
  let from: Pos, to: Pos
  if (items.length === 1 && first.nums.length) {
    from = { surah: first.surah, ayah: first.nums[0] }
    to = { surah: first.surah, ayah: first.nums[1] ?? first.nums[0] }
  } else {
    from = { surah: first.surah, ayah: first.nums[0] ?? 1 }
    to = { surah: last.surah, ayah: last === first ? max(last.surah) : last.nums[0] ?? max(last.surah) }
  }
  if (from.ayah < 1 || to.ayah > max(to.surah) || from.ayah > max(from.surah) || abs(to) < abs(from)) return null
  return { from, to }
}

/** يسجّل نطاقاً مقروءاً: الموضع التالي بعد آخره، وتلتفّ الختمة عند نهاية المصحف */
export function recordWirdRead(prev: WirdProgress | null, range: { from: Pos; to: Pos }, day: string): { progress: WirdProgress; ayahs: number } {
  const ayahs = abs(range.to) - abs(range.from) + 1
  const end = abs(range.to) + 1
  const done = end >= TOTAL_AYAHS
  return {
    ayahs,
    progress: { next: fromAbs(done ? 0 : end), khatmas: (prev?.khatmas ?? 0) + (done ? 1 : 0), updated: day },
  }
}

/** المقدار المقترح لإتمام الجزء الحالي: من الموضع إلى نهاية الجزء */
export function suggestWird(p: WirdProgress): { juz: number; from: Pos; to: Pos; ayahs: number } {
  const i = abs(p.next), j = juzOf(p.next)
  const endAbs = (JUZ_ABS[j] ?? TOTAL_AYAHS) - 1
  return { juz: j, from: p.next, to: fromAbs(endAbs), ayahs: endAbs - i + 1 }
}

const fmt = (p: Pos) => `${surahName(p.surah)} ${p.ayah}`

/** سطر الحالة والاقتراح لرسالة التذكير/التأكيد */
export function wirdProgressLine(p: WirdProgress): string {
  const s = suggestWird(p)
  const pct = Math.floor((abs(p.next) / TOTAL_AYAHS) * 100)
  return `📍 موضعك: ${fmt(p.next)} (الجزء ${s.juz}) — ختمتك ${pct}%${p.khatmas ? ` · ختمات مكتملة: ${p.khatmas}` : ''}\n🎯 لإتمام الجزء ${s.juz}: من ${fmt(s.from)} إلى ${fmt(s.to)} (${s.ayahs} آية)`
}
