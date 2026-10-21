# إعداد المساعد — تعليمات لـ Claude Code

> المالك قال لك: «اقرأ onboarding/interview.md ونفّذه». المقابلة الكاملة صارت مهارة اسمها **build-assistant** في ريبو `Nfarahat99/assistant-builder`. مهمتك تشغّلها.

1. **لو المهارة متاحة عندك** (الأمر `/assistant-builder:build-assistant` موجود في قائمة المهارات): شغّلها الحين، وقل لها إنك داخل ريبو مساعد موجود.
2. **لو مو متاحة — ثبّتها بنفسك** (أوامر shell، من أي مجلد):
   ```bash
   claude plugin marketplace add Nfarahat99/assistant-builder
   claude plugin install assistant-builder@assistant-builder
   ```
   ثم قل للمالك يكتب هنا: `/reload-plugins` ثم `/assistant-builder:build-assistant`.
3. **لو فشل التثبيت** (ما فيه `claude` في الطرفية، أو منعته الصلاحيات): انسخ ريبو المهارة لمجلد مؤقت **خارج هذا الريبو** واتبعها مباشرة:
   ```bash
   git clone --depth 1 https://github.com/Nfarahat99/assistant-builder.git "<مجلد مؤقت>/assistant-builder"
   ```
   اقرأ `<مجلد مؤقت>/assistant-builder/plugins/assistant-builder/skills/build-assistant/SKILL.md` ونفّذه. كل مسار `references/…` أو `scripts/…` فيه نسبةً لمجلد `SKILL.md`.

لو طلب المالك «جهّز إعدادات ربط واتساب»: قل للمهارة ذلك — عندها قسم مخصص له.

قاعدة ثابتة حتى قبل ما تبدأ المهارة: لا تطلب من المالك يلصق أي سر في المحادثة، ولا تقرأ `.env`.
