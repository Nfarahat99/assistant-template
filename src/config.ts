import 'dotenv/config'

/** يحوّل "07:30" إلى دقائق من منتصف الليل — القيمة الخاطئة تسقط للافتراضي */
export function parseHhMm(v: string | undefined, fallback: string): { h: number; m: number } {
  const src = (v && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim() : fallback)
  const [h, m] = src.split(':').map(Number)
  return { h: Math.min(23, h), m: Math.min(59, m) }
}

const digits = (v: string | undefined) => (v || '').replace(/[^0-9]/g, '')

export type UnderstandProvider = 'gemini' | 'nvidia'
/** LLM_UNDERSTAND_PROVIDER=gemini|nvidia — فارغ/غير ذلك = null (السلوك الحالي بلا تغيير) */
export function understandProviderFromEnv(env: NodeJS.ProcessEnv = process.env): UnderstandProvider | null {
  const p = (env.LLM_UNDERSTAND_PROVIDER || '').trim().toLowerCase()
  return p === 'gemini' || p === 'nvidia' ? p : null
}

/**
 * كل الإعدادات تُقرأ من البيئة مرة واحدة.
 * loadConfig تقبل env بديلاً ليتمكن الاختبار من بناء إعدادات معزولة.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = {
    port: Number(env.PORT || 3000),
    databaseUrl: env.DATABASE_URL || '',
    /** مجلد PGlite محلياً — "memory://" للاختبارات */
    pgliteDir: env.PGLITE_DIR || './.data/pg',
    /** مجلد ملفات المستندات (FileStore) — على ريلواي اربطه بـ Volume */
    filesDir: env.FILES_DIR || './.data/files',
    tz: env.TZ || 'Asia/Riyadh',

    /** توقيع HMAC للويبهوك القادم من الوسيط */
    webhookSecret: env.WEBHOOK_SECRET || '',
    /** مفتاح AES-256-GCM (64 hex) لتشفير الأسرار المخزّنة (مثل مفاتيح واتساب في kv) */
    secretsKey: env.SECRETS_KEY || '',

    /** وسيط واتساب سراج */
    gatewayUrl: (env.GATEWAY_URL || '').replace(/\/+$/, ''),
    gatewayApiKey: env.GATEWAY_API_KEY || '',
    /** مفتاح التسجيل (provision) من الوسيط — يسمح بربط واتساب من اللوحة ← الحسابات */
    gatewayProvisionKey: env.GATEWAY_PROVISION_KEY || '',
    /** حقول ملأها ربط اللوحة المحفوظ عند الإقلاع (applyWaLink) — غيرها من البيئة */
    waLinkFilled: [] as Array<'gatewayApiKey' | 'assistantPhone' | 'ownerPhone'>,
    assistantPhone: digits(env.ASSISTANT_PHONE),
    ownerPhone: digits(env.OWNER_PHONE),
    /** فارغ = توقيع الملف الشخصي (يُطبَّق في index.ts) */
    ownerSignature: env.OWNER_SIGNATURE || '',
    /** link (افتراضي): رقم البوت للمالك فقط، والرسائل للناس روابط wa.me تُرسل من رقم المالك.
     *  direct: البوت يرسل بنفسه — فقط لمن راسله خلال ٢٤ ساعة (خطر حظر) */
    thirdPartySendMode: (env.THIRD_PARTY_SEND_MODE === 'direct' ? 'direct' : 'link') as 'link' | 'direct',
    /** أرقام مستثناة من وضع link: يُرسل لها البوت مباشرة (فارغ = direct_send_allowlist من الملف الشخصي) */
    directSendAllowlist: (env.DIRECT_SEND_ALLOWLIST ?? '').split(',').map((x) => digits(x)).filter(Boolean),
    /** رابط لوحة الوسيط في تنبيهات الانقطاع — افتراضياً GATEWAY_URL */
    gatewayDashboardUrl: (env.GATEWAY_DASHBOARD_URL || '').replace(/\/+$/, ''),

    /** تيليجرام: قناة ثانية كاملة + احتياط تلقائي (Bot API الرسمي) */
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramOwnerChatId: (env.TELEGRAM_OWNER_CHAT_ID || '').trim(),
    /** سر عشوائي: أول محادثة ترسل "/start <الرمز>" تصبح المالك */
    telegramLinkCode: env.TELEGRAM_LINK_CODE || '',
    /** اختياريان — يُشتقان من التوكن إن تُركا فارغين */
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    telegramWebhookPath: env.TELEGRAM_WEBHOOK_PATH || '',
    /** الرابط العام للبوت (لويبهوك تيليجرام) — على ريلواي يُؤخذ من RAILWAY_PUBLIC_DOMAIN تلقائياً */
    publicUrl: (env.PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, ''),

    /** Railway: مساحة عمل محددة (اختياري) */
    railwayWorkspaceId: env.RAILWAY_WORKSPACE_ID || '',

    /** تنبيهات خارج واتساب (ntfy): موضوع سري عشوائي، وخادم اختياري للاستضافة الذاتية */
    ntfyTopic: env.NTFY_TOPIC || '',
    ntfyUrl: (env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),

    /** الذكاء: تفريغ الصوت + الفهم */
    groqApiKey: env.GROQ_API_KEY || '',
    geminiApiKey: env.GEMINI_API_KEY || '',
    sttModel: env.STT_MODEL || 'whisper-large-v3-turbo',
    sttFallbackModel: env.STT_FALLBACK_MODEL || 'gemini-3.8-flash',
    // Nvidia هو الأساسي افتراضياً متى وُجد مفتاحه (ما لم يُحدَّد LLM_PROVIDER صراحة)
    llmProvider: (env.LLM_PROVIDER === 'groq' ? 'groq' : env.LLM_PROVIDER === 'gemini' ? 'gemini' : env.LLM_PROVIDER === 'nvidia' || env.NVIDIA_API_KEY ? 'nvidia' : 'gemini') as 'gemini' | 'groq' | 'nvidia',
    llmModel: env.LLM_MODEL || '',
    /** نماذج افتراضية لكل مزوّد — LLM_MODEL يعلو على نموذج المزوّد الأساسي */
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    /** يُستخدم عند 429/5xx من النموذج الأساسي — حصة مجانية مستقلة */
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL ?? 'gemini-3.5-flash-lite',
    groqModel: env.GROQ_MODEL || 'openai/gpt-oss-120b',
    /** Nvidia API (build.nvidia.com) — اختياري؛ عند فشله يُكمل Gemini */
    nvidiaApiKey: env.NVIDIA_API_KEY || '',
    nvidiaModel: env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b',
    nvidiaBaseUrl: (env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/+$/, ''),
    /** Anthropic (Claude) — اختياري؛ يُختار لكل دور من اللوحة */
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    /** أي مزوّد متوافق مع OpenAI (OpenRouter، Together، …) — اختياري */
    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    /** خطوة الفهم النصي وحدها على مزوّد آخر (قديم — يُترجم لدور understand في defaultModels) */
    understandProvider: understandProviderFromEnv(env),

    /** GitHub — تعديلات الكود */
    githubToken: env.GITHUB_TOKEN || '',
    /** موجز AI — Tier 2 اختياري (Tavily) عند شح مصادر Tier 1 */
    tavilyApiKey: env.TAVILY_API_KEY || '',
    githubWorkflow: env.GITHUB_WORKFLOW || 'claude.yml',
    projectsFile: env.PROJECTS_FILE || './projects.json',
    /** owner/repo/path — فارغ = github.projects_remote من الملف الشخصي، وإلا لا تحميل بعيد */
    projectsRemote: env.PROJECTS_REMOTE || '',

    /** Railway — قراءة فقط (Account token) */
    railwayToken: env.RAILWAY_API_TOKEN || '',

    /** المجدول */
    morningBriefAt: parseHhMm(env.MORNING_BRIEF_AT, '07:30'),
    eveningReviewAt: parseHhMm(env.EVENING_REVIEW_AT, '21:30'),

    contactsCsv: env.CONTACTS_CSV || '',
    defaultCountryCode: digits(env.DEFAULT_COUNTRY_CODE) || '966',
  }
  /** واتساب اختياري: يُفعَّل فقط إذا وُجد الوسيط ومفتاحه ورقم المساعد */
  return { ...c, whatsappEnabled: !!(c.gatewayUrl && c.gatewayApiKey && c.assistantPhone) }
}

export type Config = ReturnType<typeof loadConfig>

/** تحذير الإقلاع عن مفاتيح الذكاء: الصوت يحتاج Gemini أو Groq؛ الفهم يكفيه أي مزوّد نصي بمفتاح */
export function aiKeyWarning(cfg: Config): string | null {
  if (cfg.geminiApiKey || cfg.groqApiKey) return null
  const text = cfg.nvidiaApiKey || cfg.anthropicApiKey || cfg.openaiApiKey
  return text
    ? 'لا GEMINI_API_KEY ولا GROQ_API_KEY — الصوت معطّل (الفهم يعمل بالمزوّد المختار لكل دور)'
    : 'لا مفتاح لأي مزوّد ذكاء (GEMINI/GROQ/NVIDIA/ANTHROPIC/OPENAI) — الفهم والصوت معطلان'
}
