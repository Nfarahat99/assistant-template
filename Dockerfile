FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json projects.json assistant.config.json ./
COPY scripts ./scripts
COPY knowledge ./knowledge
COPY src ./src
COPY public ./public

# معلومات البناء — "نسختك" تعرضها. تُمرَّر كـ build args، وعلى ريلواي تكفي RAILWAY_GIT_* وقت التشغيل
ARG GIT_SHA=""
ARG GIT_MESSAGE=""
ARG BUILD_TIME=""
ENV GIT_SHA=${GIT_SHA} GIT_MESSAGE=${GIT_MESSAGE} BUILD_TIME=${BUILD_TIME}

ENV NODE_ENV=production
ENV PORT=3000
ENV TZ=Asia/Riyadh
EXPOSE 3000

# version.json يُكتب عند الإقلاع (يلتقط متغيرات ريلواي)، ثم البوت
CMD ["sh", "-c", "node scripts/version.mjs; exec npx tsx src/index.ts"]
