/**
 * رابط ربط تيليجرام المباشر: https://t.me/<bot>?start=<TELEGRAM_LINK_CODE>
 * لما يضغط المالك «Start» يرسل تيليجرام للبوت "/start <الرمز>" — نفس اللي يكتبه بيده، فيُربط بنفس المسار في bot.ts.
 * شرط تيليجرام لقيمة start: حروف A-Z a-z وأرقام و _ و - فقط، حتى 64 خانة
 * (https://core.telegram.org/bots/features#deep-linking). الرمز اللي تولّده المقابلة (24 خانة hex) يطابقه.
 */
export const START_PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/
const BOT_USERNAME = /^[A-Za-z0-9_]{1,64}$/

export const isStartPayload = (code: string) => START_PAYLOAD.test(code)

/** الرابط المباشر؛ يرمي لو اسم البوت أو الرمز ما يصلح للرابط */
export function telegramStartUrl(botUsername: string, code: string): string {
  const bot = botUsername.replace(/^@/, '')
  if (!BOT_USERNAME.test(bot)) throw new Error('bad bot username')
  if (!isStartPayload(code)) throw new Error('bad start payload')
  return `https://t.me/${bot}?start=${code}`
}

/** أمر فتح الرابط في المتصفح الافتراضي — بدون shell (الرابط يمر كوسيط مستقل، فما ينطبع ولا يُفسَّر) */
export function openUrlCommand(platform: NodeJS.Platform, url: string): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  if (platform === 'darwin') return { cmd: 'open', args: [url] }
  return { cmd: 'xdg-open', args: [url] }
}
