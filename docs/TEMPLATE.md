# دليل إعداد مساعدك من القالب

هذا هو المسار اليدوي لإنشاء مساعد شخصي من `Nfarahat99/assistant-template`. القالب مبني من تجربة مساعد شخصي حقيقي.

> **الطريق الموصى به:** مهارة `/assistant-builder:build-assistant` (انظر [START-HERE.md](START-HERE.md)). داخل ريبو موجود: افتحه في Claude Code وقل: «اقرأ [onboarding/interview.md](../onboarding/interview.md) ونفّذه» — يشغّل المهارة نفسها، وهي مقابلة تقنية تكتب `assistant.config.json` وتمشّيك في الحسابات والأسرار خطوة خطوة. 
>
> **فحص الجاهزية:** `npm run doctor` (المنطق في `src/doctor.ts`، والمدخل `scripts/doctor.mjs` عبر tsx) — يقرأ `assistant.config.json` و`.env`/البيئة ويطبع ✅/⚠️/❌، ويخرج برمز 1 عند أي ❌. `npm run doctor -- --online` يتحقق فوق ذلك من صحة `TELEGRAM_BOT_TOKEN` (Telegram `getMe`) و`GEMINI_API_KEY` (قائمة نماذج Gemini) — مهلة ٨ ثوانٍ، ومشكلة الشبكة ⚠️ لا ❌، ولا يطبع أي قيمة. لفحص متغيرات Railway نفسها: `railway run npm run doctor`.

## 1. إنشاء نسخة

أنشئ مستودعاً فارغاً ثم ادفع إليه نسخة من القالب **بتاريخه الكامل** — لا تستخدم `gh repo create --template` لأنه يُنشئ تاريخاً منفصلاً فتفشل مزامنة التحديثات (`template-sync.yml`) بتعارضات في كل ملف.

سجّل دخول GitHub CLI أولاً بصلاحية `workflow` — الدفع يتضمن `.github/workflows` وهذا يحتاجها:

```bash
gh auth login --web --git-protocol https --scopes workflow   # أو لو مسجّل دخول: gh auth refresh -h github.com -s workflow
gh auth setup-git
```

ثم:

```bash
gh repo create <owner>/<name> --private
git clone https://github.com/Nfarahat99/assistant-template.git <name>
cd <name>
git remote rename origin template
git remote add origin https://github.com/<owner>/<name>.git
git push -u origin main
```

لا تستخدم زر **Use this template** — ينشئ تاريخاً منفصلاً فتفشل المزامنة الأسبوعية.

## 2. تعبئة `assistant.config.json`

الملف يحوي الهوية فقط (لا أسرار). غيابه أو خطؤه يوقف الإقلاع بخروج برمز 1 ورسالة من سطر واحد. المسار الافتراضي `./assistant.config.json` ويُغيَّر بالمتغير `ASSISTANT_CONFIG`.

| الحقل | مطلوب | الوصف | مثال |
|-------|-------|-------|------|
| `owner.name` | نعم | اسمك | `"فهد"` |
| `owner.phone` | لا | رقمك (٨–١٥ رقماً بدون +) | `"9665XXXXXXXX"` |
| `assistant.name` | نعم | اسم المساعد | `"مساعدي"` |
| `language` | لا | `ar` (الافتراضي) أو `en` | `"ar"` |
| `timezone` | لا | `Asia/Riyadh` فقط حالياً | `"Asia/Riyadh"` |
| `workweek` | لا | أيام الدوام، 0=الأحد … 6=السبت | `[0,1,2,3,4]` |
| `signature` | لا | توقيع رسائل الطرف الثالث (حتى ٨٠ حرفاً) | `"فهد"` |
| `user_type` | نعم | `programmer` أو `non_programmer` (يحدد ميزات الكود والمشاريع) | `"non_programmer"` |
| `github.owner` | نعم | حسابك على GitHub | `"example-user"` |
| `github.self_repo` | نعم | مستودع المساعد `owner/name` | `"example-user/my-assistant"` |
| `github.default_branch` | لا | الفرع الافتراضي للمستودع (الافتراضي `main`) | `"main"` |
| `github.template_repo` | لا | القالب لمزامنة التحديثات | `"Nfarahat99/assistant-template"` |
| `github.projects_remote` | لا | `owner/repo/path` لملف projects.json بعيد (للمبرمج) | `"example-user/config/projects.json"` |
| `github.claude_config_repo` | لا | مستودع إعدادات Claude (للمبرمج) | `"example-user/claude-config"` |
| `self_aliases` | لا | أسماء بديلة لمستودع المساعد | `["البوت"]` |
| `interests` | لا | اهتماماتك (للأخبار والبحث) | `"الذكاء الاصطناعي، الاقتصاد"` |
| `hosting.provider` | لا | `railway` (الافتراضي) أو `none` | `"railway"` |
| `hosting.railway_project` | لا | اسم مشروع ريلواي | `"my-assistant"` |
| `direct_send_allowlist` | لا | أرقام يراسلها البوت مباشرة حتى في وضع link | `["9665XXXXXXXX"]` |

```bash
cp assistant.config.example.json assistant.config.json
# عدّل القيم ثم:
git add assistant.config.json && git commit -m "chore: my assistant profile" && git push
```

## 3. الأسرار في Railway (Variables)

| المتغير | مطلوب | ملاحظة |
|---------|-------|--------|
| `GEMINI_API_KEY` | نعم (أو مزوّد آخر) | من https://aistudio.google.com/apikey |
| `TELEGRAM_BOT_TOKEN` | نعم | من @BotFather |
| `TELEGRAM_LINK_CODE` | نعم | سر عشوائي: `openssl rand -hex 12` (رابط الربط المباشر يقبل `A-Z a-z 0-9 _ -` فقط، حتى 64 خانة) |
| `DASHBOARD_PASSWORD` | نعم | كلمة مرور لوحة التحكم |
| `GITHUB_TOKEN` | للتعديلات | إذا أنشأه **صاحب المستودع**: Fine-grained PAT — Actions + Contents + Pull requests (قراءة وكتابة) على مستودع المساعد **فقط**. إذا أنشأه مشارك على مستودع باسم غيره: Classic PAT بنطاقي `repo` و `workflow` (انظر القسم ٤) |
| `RAILWAY_API_TOKEN` | للاستضافة | من https://railway.com/account/tokens |
| `ANTHROPIC_API_KEY` | اختياري | لتفعيل Claude لكل دور |
| `OPENAI_API_KEY`، `OPENAI_BASE_URL` | اختياري | أي مزوّد متوافق مع OpenAI (OPENAI_BASE_URL فارغ = OpenAI) |
| `GATEWAY_URL`، `GATEWAY_API_KEY`، `WEBHOOK_SECRET`، `ASSISTANT_PHONE`، `OWNER_PHONE` | اختياري | واتساب — انظر القسم ٨ |
| `GATEWAY_PROVISION_KEY` | اختياري | ربط واتساب من اللوحة ← الحسابات (مع `SECRETS_KEY`) — القسم ٨ |
| `FILES_DIR` | للمستندات | مسار الملفات؛ اربطه بـ Volume (مثلاً `/data/files`) |

القائمة الكاملة لكل المتغيرات في `.env.example`.

## 4. أسرار GitHub للمستودع

**من يملك المستودع؟** تحقق أولاً: `gh repo view <owner>/<name> --json owner,viewerPermission`.

- `viewerPermission` = `ADMIN`: أنت تضيف الأسرار وتربط Railway وتنشئ Fine-grained PAT بنفسك.
- غير ذلك (مشارك على مستودع حساب شخصي لغيرك): صاحب المستودع يربط تطبيق Railway على GitHub بالمستودع، وقد يلزمه إضافة السرّين أدناه (جرّب صفحة الأسرار أولاً)، وتوكناتك تكون **Classic PAT** (`repo`، `workflow`) لأن الـ Fine-grained لا يصل إلا لموارد مالكه. **الأسهل:** نقل المستودع لحساب المستخدم (Settings ← General ← Danger Zone ← Transfer ownership) — يبقى التاريخ ومزامنة القالب كما هي، وتصير دقائق GitHub Actions على حسابه.
- مهارة build-assistant — خطوة الحسابات والأسرار (ملكية المستودع) — تفحص هذا وتجهّز رسالة جاهزة لصاحب المستودع بدون أي أسرار.


```bash
# تفويض Claude للتعديلات (من جهازك بعد تسجيل الدخول في claude):
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<name>

# مزامنة تحديثات القالب (انظر الشروط أدناه):
gh secret set TEMPLATE_SYNC_TOKEN --repo <owner>/<name>
```

**`TEMPLATE_SYNC_TOKEN`**: القالب عام، فيكفي توكن **Fine-grained** على مستودعك وحده: Contents + Pull requests + Workflows → Read and write. الـ Classic (`repo`، `workflow`) فقط لما يكون المستودع باسم شخص ثاني. الـ workflow `template-sync.yml` يعمل كل أحد ويفتح PR بتحديثات القالب.

**ملفات تملكها نسختك:** `assistant.config.json` و `knowledge/owner.md` و `projects.json` و `README.md` لا تُستبدل أبداً بتحديثات القالب — عند أي تعارض تبقى نسختك.

**تنبيه مهم:** القالب عام، فيكفي توكن Fine-grained على مستودعك أنت (Contents + Pull requests + Workflows: Read and write). الـ Classic PAT (نطاقات `repo` و `workflow`) أو GitHub App فقط لما يكون المستودع باسم شخص ثاني وأنت مشارك فيه.

**حماية الفرع:** فعّل حماية الفرع `main` في مستودعك (Settings ← Branches ← Add rule، أو `gh api`): منع الدفع المباشر واشتراط PR، حتى لا تصل تحديثات القالب أو تعديلات Claude إلا عبر طلب دمج تراجعه.

**قيد معروف:** الـ PRs التي يفتحها `claude.yml` تُنشأ بـ `GITHUB_TOKEN`، وقاعدة GitHub تمنع تشغيل `ci.yml` تلقائياً عليها. شغّل الفحوصات يدوياً (`gh workflow run ci.yml --ref <branch>`) أو أعد تشغيلها قبل الدمج، إلى أن تضيف المرحلة ٣ بوابة CI.

## 5. النشر على Railway

```bash
railway login
railway init            # مشروع جديد (أو من اللوحة: Deploy from GitHub repo ← مستودعك)
railway add --database postgres   # يضيف خدمة Postgres؛ اربطها من اللوحة: Variables ← DATABASE_URL=${{Postgres.DATABASE_URL}}
railway volume add --mount-path /data   # ثم FILES_DIR=/data/files
railway variables set GEMINI_API_KEY=... TELEGRAM_BOT_TOKEN=... TELEGRAM_LINK_CODE=... DASHBOARD_PASSWORD=... SECRETS_KEY=... WEBHOOK_SECRET=... FILES_DIR=/data/files
railway up
railway domain          # Generate Domain — ينتج الرابط العام (PUBLIC_URL يؤخذ تلقائياً من RAILWAY_PUBLIC_DOMAIN)
```

تحقق: `curl -s https://<domain>/health`.

## 6. ربط تيليجرام

1. أنشئ بوتاً من @BotFather وضع توكنه في `TELEGRAM_BOT_TOKEN`.
2. أرسل للبوت: `/start <TELEGRAM_LINK_CODE>` — يُربط حسابك مالكاً ويُحفظ، وأي محادثة أخرى تُتجاهل.
   - أسهل: `npm run telegram-link` يقرأ `.env` ويجلب اسم البوت (`getMe`) ويفتح `https://t.me/<bot>?start=<TELEGRAM_LINK_CODE>` في المتصفح دون طباعة الرمز. الضغط على **Start** يرسل للبوت `/start <الرمز>` نفسه.

## 7. اختبار

أرسل للبوت: `مساعدة` — يرد بقدراتك وحالتك الحية (بدون ذكاء اصطناعي). ثم جرّب `ذكرني بعد دقيقتين أختبر`.

## 8. البدء بتيليجرام فقط

واتساب اختياري. بدون أي متغير `GATEWAY_*` يعمل المساعد على تيليجرام فقط، ويعرض `/health` الحالة `"wa":{"status":"disabled"}`. لإضافة واتساب لاحقاً اضبط `GATEWAY_URL` و `GATEWAY_API_KEY` و `WEBHOOK_SECRET` و `ASSISTANT_PHONE` و `OWNER_PHONE`.

### ربط واتساب من اللوحة (الحسابات)

بديل أسهل من ضبط `GATEWAY_API_KEY` يدوياً: اضبط `GATEWAY_URL` و `GATEWAY_PROVISION_KEY` (مفتاح التسجيل من الوسيط) و `SECRETS_KEY` و `WEBHOOK_SECRET` (16 حرفاً على الأقل) ورابطاً عاماً (`PUBLIC_URL`، أو `RAILWAY_PUBLIC_DOMAIN` تلقائياً)، واترك `GATEWAY_API_KEY` و `ASSISTANT_PHONE` فارغين. ثم من اللوحة ← **الحسابات**:

1. يُدخل المالك رقم المساعد ورقمه ويوافق على تحذير الحظر.
2. المساعد يسجّل الرقم في الوسيط (`POST /api/v1/numbers`)، ويضبط الويبهوك على `<PUBLIC_URL>/webhook/wa` بمفتاح الرقم، ويحفظ المفتاح **مشفّراً** في kv (لو فشل ضبط الويبهوك يُحذف الرقم من الوسيط ولا يُحفظ شيء).
3. يُعرض رمز QR (يتجدد كل ~20 ثانية) ويُمسح من جوال المساعد.
4. عند الاتصال يرسل المساعد ترحيباً للمالك ثم يعيد تشغيل نفسه بـ `process.exit(75)` ليطبّق الربط عند الإقلاع.

**إعادة التشغيل:** الربط وفكّه ينهيان العملية بالرمز 75 ليُعاد الإقلاع. على Railway يكفي `restartPolicyType: ON_FAILURE` الموجود في `railway.json`. على أي استضافة ثانية فعّل إعادة التشغيل التلقائية، وإلا يتوقف المساعد بعد الربط أو فكّه (و`npm run doctor` ينبّه لذلك خارج Railway متى كان `GATEWAY_PROVISION_KEY` مضبوطاً):

- **Docker Compose:**

  ```yaml
  services:
    assistant:
      restart: unless-stopped
  ```

  (أو `docker run --restart unless-stopped …`)
- **systemd** (في قسم `[Service]`):

  ```ini
  Restart=always
  RestartSec=5
  ```

(`on-failure` يكفي أيضاً لأن الرمز 75 خروج بخطأ، لكن `unless-stopped` / `always` أضمن.)

«فك الربط» يحذف الرقم من الوسيط (`DELETE /api/v1/numbers/:id`) ويمسح الربط ثم يعيد التشغيل. لو ما قدر الوسيط يفك الجهاز من الجوال، تظهر رسالة تطلب حذفه يدوياً من واتساب ← الأجهزة المرتبطة. متغيرات البيئة تغلب دائماً: لو `GATEWAY_API_KEY` مضبوط فالربط من اللوحة مقفل.

## 9. النماذج لكل دور

Gemini هو الافتراضي لكل الأدوار (الفهم، العام، الصوت، الرؤية، الفيديو، البحث). لاستخدام Claude (`ANTHROPIC_API_KEY`) أو أي مزوّد متوافق مع OpenAI (`OPENAI_API_KEY` + `OPENAI_BASE_URL`) اختره **لكل دور** من لوحة التحكم: الإعدادات ← النماذج. الصوت والفيديو والبحث تحتاج Gemini (أو Groq للصوت فقط)؛ Claude وOpenAI للنص (وClaude للرؤية أيضاً).

## 10. نقل مساعد موجود (بُني قبل القالب) للقالب

- [ ] اضبط `LINKED_REPOS` (JSON) للحفاظ على سلوك المستودعات المرتبطة: `[{"repos":["owner/a","owner/b"],"words":["…"],"note":"…"}]`.
- [ ] اضبط `CI_GATEWAY_SCOPES` (JSON: `{"owner/repo":["اسم-قاعدة"]}`) — الخريطة الافتراضية في القالب فارغة.
- [ ] تأكد أن الإعدادات المحفوظة في اللوحة (`kv.settings`) تتضمن الميزات التي أصبحت **معطّلة افتراضياً** في القالب: `ai_news_digest` و `db_access` و `project_status_daily` و `weekly_insights` و `self_review` — أو أعد تفعيلها مرة واحدة من اللوحة.
- [ ] `LLM_PROVIDER` و `LLM_UNDERSTAND_PROVIDER` في البيئة يحدّدان القيم الأولية فقط حتى أول حفظ من اللوحة؛ بعدها تُحفظ الأدوار وتعلو عليهما.
- [ ] `DIRECT_SEND_ALLOWLIST` الفارغ في البيئة لم يعد يعطّل قائمة `direct_send_allowlist` من الملف الشخصي (تُستخدم القائمة من الملف).
- [ ] معرفة نطاقك التي كانت مكتوبة في البرومبتات (مثلاً وصف خدمة من خدماتك أو مكان تشغيلها، أو مشاريع تهمك في الموجز اليومي) لم تعد في الكود: أضفها إلى `knowledge/owner.md` واهتماماتك إلى `interests`.
- [ ] انسخ `assistant.config.json` بهويتك، وملف `knowledge/owner.md`، واضبط `DB_MONITOR_IGNORE` إن كنت تستثني مشاريع من مراقبة القواعد (الافتراضي فارغ).
