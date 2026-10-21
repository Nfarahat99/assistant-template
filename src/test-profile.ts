import { ProfileSchema, type Profile } from './profile.js'

export const TEST_PROFILE: Profile = ProfileSchema.parse({
  owner: { name: 'وليد' },
  assistant: { name: 'سراج' },
  signature: '— من وليد',
  user_type: 'programmer',
  github: {
    owner: 'example-user',
    self_repo: 'example-user/my-assistant',
    projects_remote: 'example-user/claude-config/projects.json',
    claude_config_repo: 'example-user/claude-config',
  },
  self_aliases: ['my-assistant', 'سراج اسستنت', 'سراج اسيستنت', 'سراج اسيستانت', 'سراج اسستانت', 'سراج أسيستنت', 'سراج assistant', 'my assistant'],
  interests: 'Claude Code، وكلاء الذكاء الاصطناعي، الأتمتة',
  hosting: { provider: 'railway', railway_project: 'my-assistant' },
  direct_send_allowlist: ['966500000009'],
})

/** خريطة نطاقات بوابة CI للمالك الأصلي (كانت DEFAULT_CI_SCOPES في ci-gateway.ts؛ في الإنتاج: CI_GATEWAY_SCOPES) */
export const TEST_CI_SCOPES: Record<string, string[]> = {
  'example-user/sirajplus': ['falak'],
  'example-user/qandeel-hub': ['qandeel'],
  'example-user/waqti': ['waqti'],
  'example-user/compass': ['compass'],
  'example-user/nuqta': ['nuqta'],
  'example-user/whatsapp-siraj': ['whatsapp'],
  'example-user/hudoor': ['hudoor'],
}

/** المستودعات المرتبطة للمالك الأصلي — تُحقن في LINKED_REPOS للاختبارات (كانت مدمجة في code-context.ts) */
export const TEST_LINKED_REPOS = [
  {
    repos: ['example-user/sirajplus', 'example-user/qandeel-hub'],
    words: ['نبراس', 'فلك نبراس', 'falak', 'سراج بلس', 'sirajplus', 'مثابر', 'muthabir', 'قنديل', 'qandeel'],
    note: 'فلك نبراس (sirajplus) يزامن بيانات الحضور والزي من مثابر (qandeel-hub) عبر /api/falak/v1/daily — أي خلل في الربط قد يكون في المصدّر (قنديل) أو في القارئ (نبراس normalize).',
  },
]
