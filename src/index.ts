import { loadConfig, aiKeyWarning } from './config.js'
import { loadProfile, setProfile, ProfileError, profile, assistantName } from './profile.js'
import { logger } from './logger.js'
import { createDb } from './db/index.js'
import { migrate } from './db/migrate.js'
import { Store } from './store.js'
import { Assistant } from './assistant.js'
import { buildServer } from './server.js'
import { buildRoleClients } from './ai/router.js'
import { httpGateway, guardedGateway } from './clients/gateway.js'
import { httpGitHub } from './clients/github.js'
import { ProjectRegistry } from './projects.js'
import { seedContacts } from './contacts-seed.js'
import { Watchdog } from './watchdog.js'
import { httpNtfy } from './clients/ntfy.js'
import { httpTelegram } from './telegram/client.js'
import { TelegramBot, telegramSecrets } from './telegram/bot.js'
import type { Alerter } from './watchdog.js'
import { loadVersion } from './version.js'
import { readFile } from 'node:fs/promises'
import { Settings } from './settings.js'
import { setUsageSink } from './usage.js'
import { setRejectionSink } from './ai/rejections.js'
import { rejectionSink } from './selfreview/rejections.js'
import { httpRailway } from './clients/railway.js'
import { railwayHosting } from './hosting/railway.js'
import { noneHosting } from './hosting/none.js'
import { RailwayMonitor, MONITOR_POLL_MS } from './monitor.js'
import { overlayWaLink } from './whatsapp/link-store.js'
import { CiGateway, parseRepoList, parseScopesEnv } from './ci-gateway.js'

async function main() {
  try { setProfile(loadProfile()) } catch (e) {
    if (e instanceof ProfileError) { logger.fatal(e.message); process.exit(1) }
    throw e
  }
  const cfg = loadConfig()
  // ما لم تحدده البيئة يأتي من الملف الشخصي
  const p = profile()
  if (!cfg.ownerSignature) cfg.ownerSignature = p.signature
  if (!cfg.directSendAllowlist.length) cfg.directSendAllowlist = p.direct_send_allowlist
  cfg.projectsRemote = cfg.projectsRemote || p.github.projects_remote || ''
  const db = await createDb(cfg)
  await migrate(db)
  const store = new Store(db)
  // ربط واتساب المحفوظ (مشفّر في kv) يملأ ما تركته البيئة فارغاً — قبل فحص القنوات والوسيط
  await overlayWaLink(store, cfg, (o, m) => logger.warn(o, m))
  const gwVars = ['gatewayUrl', 'gatewayApiKey', 'assistantPhone'] as const
  const gwSet = gwVars.filter((k) => !!cfg[k])
  if (!cfg.whatsappEnabled && gwSet.length === 0) logger.info('واتساب غير مفعّل — تيليجرام فقط')
  else if (!cfg.whatsappEnabled) logger.warn({ missing: gwVars.filter((k) => !cfg[k]) }, 'إعداد واتساب ناقص — واتساب معطّل')
  const missing = (cfg.whatsappEnabled ? (['webhookSecret', 'ownerPhone'] as const) : []).filter((k) => !cfg[k])
  if (missing.length) logger.warn({ missing }, 'متغيرات ناقصة — البوت يقلع لكن لن يستقبل/يرسل بشكل صحيح')
  if (!cfg.whatsappEnabled && !cfg.telegramBotToken) {
    logger.fatal('لا واتساب ولا تيليجرام — ما فيه قناة للتواصل')
    process.exit(1)
  }
  const keyWarn = aiKeyWarning(cfg)
  if (keyWarn) logger.warn(keyWarn)
  else if (!cfg.groqApiKey) logger.info(`بدون Groq: Gemini (${cfg.geminiModel}، احتياط ${cfg.geminiFallbackModel || 'لا يوجد'}) يفرّغ ويفهم الصوت في استدعاء واحد`)
  await seedContacts(store, cfg.contactsCsv, cfg.defaultCountryCode)

  const github = cfg.githubToken ? httpGitHub(cfg.githubToken) : null
  const projects = new ProjectRegistry()
  await projects.loadFile(cfg.projectsFile)
  if (github && cfg.projectsRemote) await projects.loadRemote(github, cfg.projectsRemote)

  // الحارس الصارم: في وضع link رقم البوت لا يراسل إلا المالك — مهما حصل في الطبقات فوقه
  const gateway = guardedGateway(httpGateway(cfg.gatewayUrl, cfg.gatewayApiKey), {
    ownerPhone: cfg.ownerPhone,
    allowlist: cfg.directSendAllowlist,
    mode: () => settings.get().send_mode,
    messagedUsWithin24h: (p) => store.messagedUsSince(p, new Date(Date.now() - 86_400_000)),
  })
  logger.info(`إرسال الرسائل للناس: ${cfg.thirdPartySendMode === 'link' ? 'روابط wa.me من رقم المالك' : 'مباشر (لمن راسل البوت خلال ٢٤س فقط)'}`)
  // إعدادات وقت التشغيل (لوحة التحكم) تعلو على البيئة
  const settings = new Settings(cfg, store)
  await settings.load()
  // النموذج يقرأ الإعدادات والحصة في كل استدعاء (الاحتياطي مباشرة إن خلصت حصة الأساسي)
  // كل دور (فهم، معرفة عامة، صوت، رؤية، فيديو، بحث) على المزوّد/النموذج المختار في اللوحة (settings.models)
  let assistantRef: Assistant | null = null
  // حصة Gemini تُطبَّق لكل دور على حدة: فقط الدور الذي أساسيه نموذج Gemini خلصت حصته اليوم يذهب لاحتياطه
  const roles = buildRoleClients(cfg, () => settings.get().models, {
    isExhausted: (p, m) => p === 'gemini' && (assistantRef?.quota.isExhausted(m) ?? false),
  })
  // Railway: قراءة حالة النشر + التحقق بعد كل دمج (إعادة النشر فقط بموافقة)
  const railway = cfg.railwayToken ? httpRailway(cfg.railwayToken, undefined, cfg.railwayWorkspaceId || undefined) : null
  if (!railway) logger.warn('RAILWAY_API_TOKEN غير مضبوط — البوت ما يقدر يتأكد من النشر بعد الدمج')
  // RAILWAY_SERVICE_ID / RAILWAY_ENVIRONMENT_ID are injected by Railway at runtime
  const hosting = profile().hosting.provider === 'railway' && railway && process.env.RAILWAY_SERVICE_ID && process.env.RAILWAY_ENVIRONMENT_ID
    ? railwayHosting(railway, { serviceId: process.env.RAILWAY_SERVICE_ID, environmentId: process.env.RAILWAY_ENVIRONMENT_ID })
    : noneHosting()
  const assistant = new Assistant({ cfg, store, github, projects, gateway, llm: roles.llm, understandLlm: roles.understandLlm, understandProvider: settings.get().models.understand.provider, stt: roles.stt, settings, railway, hosting, newsFetch: (u, i) => fetch(u, i), onboardingAutoStart: true })
  assistantRef = assistant
  await assistant.quota.load()
  setUsageSink(assistant.usageSink())
  // مخرجات النموذج المرفوضة (JSON/schema) ← llm_rejections لقياس نسبة الرفض لكل نموذج
  setRejectionSink(rejectionSink(db))

  // ذاكرة المالك: knowledge/owner.md تُزرع في kv (knowledge_md) إن كانت فارغة — اللوحة تعدّل kv، والبوت يقرأها في كل استدعاء
  const knowledgeFile = process.env.KNOWLEDGE_FILE || './knowledge/owner.md'
  const md = await readFile(knowledgeFile, 'utf8').catch(() => '')
  if (!md) logger.warn(`لم أجد ${knowledgeFile} — البوت بلا ذاكرة عن المالك`)
  await assistant.seedKnowledge(md)

  // نسخة البوت ("نسختك")
  const version = await loadVersion(github)
  assistant.attachVersion(version)
  logger.info(`النسخة: ${version.sha?.slice(0, 7) ?? 'غير معروفة'} (${version.source})`)

  // تيليجرام: قناة ثانية كاملة + احتياط عند انقطاع واتساب
  let telegram: TelegramBot | null = null
  if (cfg.telegramBotToken) {
    telegram = new TelegramBot(cfg, httpTelegram(cfg.telegramBotToken), store, assistant)
    await telegram.init()
    assistant.attachTelegram(telegram.channel())
    if (!telegram.bound && !cfg.telegramLinkCode) logger.warn('تيليجرام بلا TELEGRAM_OWNER_CHAT_ID ولا TELEGRAM_LINK_CODE — لا يمكن ربط المالك')
  }

  // التنبيهات خارج واتساب: تيليجرام مفضّل (فوري)، وntfy فقط إن ضُبط NTFY_TOPIC ولم يُربط تيليجرام
  const ntfy = cfg.ntfyTopic ? httpNtfy(cfg.ntfyUrl, cfg.ntfyTopic) : null
  const tgAlert = telegram?.alerter() ?? null
  if (!tgAlert && !ntfy) logger.warn('لا تيليجرام ولا NTFY_TOPIC — لن تصلك تنبيهات إذا انقطع واتساب البوت')
  const alerter: Alerter | null = tgAlert || ntfy ? {
    get immediate() { return !!telegram?.bound },
    send: (m) => (telegram?.bound ? tgAlert!.send(m) : ntfy ? ntfy.send(m) : Promise.resolve()),
    sendImage: (png, m) => (telegram?.bound ? tgAlert!.sendImage(png, m) : ntfy ? ntfy.sendImage(png, m) : Promise.resolve()),
  } : null
  const watchdog = new Watchdog(cfg, gateway, alerter, { onRecovered: (s) => assistant.onRecovered(s) })
  assistant.attachWatchdog(watchdog)
  assistant.attachFallbackNotifier(ntfy)

  // بوابة قواعد البيانات لـ Claude في GitHub Actions (قراءة فقط، توكن HMAC لكل مستودع)
  const ciGateway = process.env.CI_GATEWAY_SECRET ? new CiGateway({
    secret: process.env.CI_GATEWAY_SECRET, dbs: assistant.databases, store, projects: () => projects.all(),
    disabledRepos: parseRepoList(process.env.CI_GATEWAY_DISABLED_REPOS), explicitScopes: parseScopesEnv(process.env.CI_GATEWAY_SCOPES),
    enabled: () => settings.features.db_access,
  }) : null
  if (ciGateway) logger.info({ scopes: Object.fromEntries(ciGateway.scopes()) }, 'بوابة قواعد البيانات لـ CI مفعّلة')

  // ربط/فك واتساب من اللوحة يعيد التشغيل بإيقاف نظيف (stop) ثم exit(75) — تُربط بعد تعريف stop أدناه
  let restartGracefully: () => void | Promise<void> = () => process.exit(75)
  const app = buildServer({
    ciGateway,
    assistant,
    webhookSecret: cfg.webhookSecret,
    health: async () => ({
      db: db.kind, projects: projects.all().length, wa: watchdog.snapshot(),
      telegram: telegram ? { bound: telegram.bound } : null, send_mode: settings.get().send_mode,
    }),
    telegram: telegram ? {
      ...(() => { const s = telegramSecrets(cfg); return { path: s.path, secretToken: s.token } })(),
      handle: (u) => telegram!.handleUpdate(u),
    } : undefined,
    heartbeat: process.env.HEARTBEAT_TOKEN ? { token: process.env.HEARTBEAT_TOKEN, record: (i) => assistant.recordHeartbeat(i) } : null,
    dashboard: process.env.DASHBOARD_PASSWORD ? {
      password: process.env.DASHBOARD_PASSWORD, db, store, cfg, settings, projects, github, gateway, watchdog, telegram, version,
      keyStatus: roles.keyStatus,
      waLink: { restart: () => restartGracefully() },
    } : null,
  })
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  logger.info(`مساعد ${assistantName()} يستمع على ${cfg.port}`)
  if (telegram) await telegram.start().catch((err) => logger.error({ err: String(err) }, 'فشل تشغيل تيليجرام'))

  // المجدول: مؤقتات بسيطة بدل cron — كل الحالة في القاعدة فإعادة التشغيل تستأنف
  const guard = (name: string, fn: () => Promise<void>) => {
    let busy = false
    return async () => {
      if (busy) return
      busy = true
      try { await fn() } catch (err) { logger.error({ err }, `فشل ${name}`) } finally { busy = false }
    }
  }
  const tick = guard('المجدول', () => assistant.tick())
  const jobs = guard('متابعة طلبات الكود', () => assistant.pollJobs())
  const outbound = guard('متابعة الرسائل', () => assistant.pollOutbound())
  const wa = guard('حارس الاتصال', () => watchdog.check())
  const deploys = guard('متابعة النشر', () => assistant.pollDeploys())
  const monitor = railway ? new RailwayMonitor({
    store, railway, notify: (t) => assistant.say(t),
    // قاعدة المالك: كل مشروع له مسار قراءة لقاعدته — تنبيه أسبوعي بالمشاريع غير المغطّاة في DB_CONNECTIONS
    dbCoverage: {
      coveredProjects: () => assistant.databases.list().map((d) => d.project),
      ignoreProjects: (process.env.DB_MONITOR_IGNORE ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      ownProjectId: process.env.RAILWAY_PROJECT_ID,
    },
  }) : null
  const rwMonitor = guard('مراقبة Railway', async () => { await monitor?.poll() })
  const timers = [
    ...(monitor ? [setInterval(rwMonitor, MONITOR_POLL_MS)] : []),
    setInterval(tick, 60_000),
    setInterval(jobs, 30_000),
    setInterval(outbound, 20_000),
    setInterval(wa, 60_000),
    setInterval(deploys, 20_000),
  ]
  setTimeout(() => { wa(); tick(); jobs(); outbound() }, 3_000)
  if (monitor) setTimeout(() => { rwMonitor() }, 30_000)
  // (a) تحدّث البوت؟ نعلن النسخة الجديدة مرة واحدة (بعد ربط القنوات)
  setTimeout(() => { assistant.announceVersionIfNew().catch((err) => logger.error({ err }, 'فشل إعلان النسخة')) }, 8_000)

  const stop = async (code = 0) => {
    logger.info('إيقاف الخدمة...')
    timers.forEach(clearInterval)
    telegram?.stop()
    await app.close().catch(() => {})
    await assistant.idle().catch(() => {})
    await db.close().catch(() => {})
    process.exit(code)
  }
  // 75 = إعادة تشغيل مقصودة (Railway ON_FAILURE يعيد التشغيل)
  restartGracefully = () => stop(75)
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
}

main().catch((err) => {
  logger.error({ err }, 'فشل الإقلاع')
  process.exit(1)
})
