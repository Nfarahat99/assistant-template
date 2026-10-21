import pino from 'pino'

/** داخل node --test يكون NODE_TEST_CONTEXT موجوداً — نكتم السجلات لتبقى المخرجات نظيفة */
const testing = !!process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test'

export const logger = pino({
  level: process.env.LOG_LEVEL || (testing ? 'silent' : 'info'),
  transport: process.env.NODE_ENV === 'production' || testing ? undefined : {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
  },
})
