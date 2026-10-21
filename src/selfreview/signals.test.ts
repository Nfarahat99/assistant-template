/**
 * كشف التعثّرات على سطور محادثة مصطنعة بالكامل تغطي أنماط التعثّر الشائعة — حتمي بالكامل (بلا نموذج).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_TRANSCRIPT } from './fixtures.js'
import {
  parseTranscript, detectSignals, groupIncidents, countConversations, isClarify, similarity, isManualCaseCommand, type Turn,
} from './signals.js'

const turns = parseTranscript(SAMPLE_TRANSCRIPT)
const signals = detectSignals(turns)
const at = (hms: string) => signals.filter((s) => s.at.toISOString().slice(11, 19) === hms)
const kindsAt = (hms: string) => at(hms).map((s) => s.kind)
const T = (role: 'user' | 'assistant', text: string, min: number): Turn => ({ role, text, at: new Date(Date.UTC(2026, 9, 5, 12, min)) })

test('الأداة تقرأ سطور سجل المحادثة (وقت UTC، ⏎ = سطر)', () => {
  assert.ok(turns.length >= 60)
  assert.equal(turns[0].role, 'assistant')
  assert.equal(turns[0].at.toISOString(), '2026-10-05T15:04:37.000Z')
  assert.match(turns[0].text, /\n/)
})

test('«تم، كلود صار يمر…» بلا إجراء ← ادعاء تنفيذ', () => {
  assert.deepEqual(kindsAt('15:19:00'), ['claim_no_action'])
  assert.ok(kindsAt('16:01:48').includes('claim_no_action'), '«تم اختيار مشروع النخبة 👌»')
  assert.ok(kindsAt('16:02:57').includes('claim_no_action'), '«تم، اخترنا نجوم بلس 👍»')
})

test('«تم» مع علامة إجراء حقيقي (🧠 تعلّمت) أو إجراء مسجّل قريب ← ليست ادعاء', () => {
  assert.equal(kindsAt('15:18:03').length, 0, 'تمّ حفظ التوجيه + 🧠 تعلّمت')
  const s = detectSignals([T('user', 'تاكد عند كلود انه ماشي عليه', 0), T('assistant', 'تم، كلود صار يمر على كل توجيه', 1)], { actionNear: () => true })
  assert.ok(!s.some((x) => x.kind === 'claim_no_action'))
})

test('حلقة «نفّذ السكريبت»: ٤ أسئلة توضيح متتالية ← clarify_loop واحدة، ومدخلها رسالة المالك الأصلية', () => {
  const loops = signals.filter((s) => s.kind === 'clarify_loop')
  const script = loops.find((s) => s.at.toISOString().slice(11, 19) === '16:12:22')
  assert.ok(script, 'حلقة السكربت مكتشفة')
  assert.match(script!.detail, /4 أسئلة/)
  const inc = groupIncidents(turns, signals).find((i) => i.signals.includes(script!))!
  assert.equal(turns[inc.ownerIndex].text, 'نفّذ السكريبت هذا الحين')
})

test('سؤال توضيح واحد ليس حلقة', () => {
  const s = detectSignals([T('user', 'وش رايك', 0), T('assistant', 'أي واحد تقصد؟\n1. أ\n2. ب\nرد برقم الخيار', 1), T('assistant', 'تمام 👍 📝 أضفت المهمة', 2)])
  assert.ok(!s.some((x) => x.kind === 'clarify_loop'))
  assert.ok(isClarify('وين ودك أدور على زر syncseason؟\n1. مواعيدي\n2. النخبة\nرد برقم الخيار'))
  assert.ok(!isClarify('🗞️ موجز:\n1. خبر\n2. خبر'))
})

test('تصحيح المالك «لا غلط، …» ← correction؛ وصف بيانات «الزي غير صحيح/غلط» ليس تصحيحاً', () => {
  const s = detectSignals([
    T('user', '🎤 لا غلط، المعلم في رافد يختار «حضر بالزي» لما يجي الطالب لابس كامل.', 0),
    T('user', '🎤 افحص لي الطالب بدر الشمري في سلسلة نجوم، ليه كل أيامه مكتوب فيها الزي غير صحيح؟ فتش في القواعد وعلمني.', 40),
    T('user', 'ترتيب الطلاب في التقرير يطلع غلط لما نفلتر حسب الحلقة', 80),
    T('user', 'مو كذا', 120),
  ])
  assert.deepEqual(s.filter((x) => x.kind === 'correction').map((x) => x.quote.slice(0, 6)), ['لا غلط', 'مو كذا'])
})

test('تذمّر: «جاوب على سؤالي» و«ليه مكتوب محذوف؟» نعم — «ليش» داخل بلاغ طويل أو «وخليهم» لا', () => {
  assert.ok(kindsAt('16:03:11').includes('frustration'))
  assert.ok(kindsAt('15:46:25').includes('frustration'))
  const s = detectSignals([
    T('user', '🎤 في رافد طلاب كثير يطلع لهم اختبار وهم معفيين منه في الإعدادات، شيك ليه صاير هالشي', 0),
    T('user', 'وقت الإجازات عادي طلّعهم وخليهم آخر القائمة دايم', 50),
  ])
  assert.ok(!s.some((x) => x.kind === 'frustration'))
})

test('طلب متكرر: «وين ألاقي الزر…» ثم «وين ألاقي الزر اللي يشغّل syncseason» — والكلمة الواحدة («النخبة») لا تُحسب', () => {
  const rep = signals.filter((s) => s.kind === 'repeated_ask').map((s) => s.quote)
  assert.ok(rep.some((q) => q.includes('syncseason')), JSON.stringify(rep))
  assert.ok(!rep.includes('النخبة'))
  assert.ok(similarity('وين ألاقي الزر اللي يشغّل syncseason', 'وين ألاقي زر syncseason في مشروع نجوم بلس') >= 0.6)
  assert.equal(similarity('النخبة', 'في أي مشروع النخبة'), 0)
})

test('فشل/احتياط و«ما لقيت»: صدى الصوتية لا يُحسب، و«إذا ما لقيت» وسط الجملة لا', () => {
  assert.ok(kindsAt('16:04:52').includes('failed'), '📚 من معرفتي العامة')
  assert.ok(kindsAt('15:05:27').includes('not_found'), 'ما لقيت خدمة تطابق')
  assert.ok(!kindsAt('16:03:52').includes('not_found'), '«…ما لقيت شي، استخدم…» نصيحة لا تعثّر')
  const s = detectSignals([T('user', '🎤 وين بدر', 0), T('assistant', '🎤 «ما لقيت بدر؟»\n\nلقيته: بدر الشمري — حاضر', 1)])
  assert.ok(!s.some((x) => x.kind === 'not_found'), 'نص الصدى (كلام المالك) لا يُحسب على البوت')
})

test('الحوادث مرتبة بالخطورة، وعدد المحادثات = جلسات بفاصل ٣٠ دقيقة', () => {
  const inc = groupIncidents(turns, signals)
  assert.ok(inc.length >= 3)
  for (let i = 1; i < inc.length; i++) assert.ok(inc[i - 1].score >= inc[i].score)
  assert.ok(inc[0].excerpt.length >= 2 && inc[0].excerpt.length <= 8)
  assert.equal(countConversations([T('user', 'أ', 0), T('user', 'ب', 10), T('user', 'ج', 80)]), 2)
})

test('«هذا غلط، المفروض …» أمر حفظ حالة — لا يُحسب تصحيحاً عادياً', () => {
  assert.ok(isManualCaseCommand('هذا غلط، المفروض تخلي كلود يفتش الكود'))
  assert.ok(isManualCaseCommand('لا هذا غلط المفروض ترد بدون خيارات'))
  assert.ok(!isManualCaseCommand('غلط'))
  const s = detectSignals([T('user', 'هذا غلط، المفروض ترد على طول', 0)])
  assert.ok(!s.some((x) => x.kind === 'correction'))
})

test('إشعارات الخلفية (BG_MARK) لا تُعد رداً: لا تقطع حلقة التوضيح ولا تُحسب ادعاء «تم»', async () => {
  const { BG_MARK } = await import('../lib/code-context.js')
  const s = detectSignals([
    T('user', 'نفّذ السكريبت هذا الحين', 0),
    T('assistant', `${BG_MARK}✅ تم النشر على nujoom-web`, 0),
    T('assistant', 'أي سكربت؟\n1. أ\n2. ب\nرد برقم الخيار', 1),
    T('assistant', `${BG_MARK}🚀 بدأ النشر على nukhba-web`, 1),
    T('user', '3', 2),
    T('assistant', 'تقصد أي مشروع؟\n1. أ\n2. ب\nرد برقم الخيار', 3),
  ])
  assert.ok(s.some((x) => x.kind === 'clarify_loop'), 'الإشعار بين الرسالة والرد لا يقطع الحلقة')
  assert.ok(!s.some((x) => x.kind === 'claim_no_action'), '«تم النشر» إشعار نظام لا ادعاء')
})
