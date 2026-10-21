/**
 * عميل GitHub REST المصغّر — فقط ما نحتاجه لدورة: تشغيل workflow ← PR ← دمج.
 * التوكن: fine-grained PAT بصلاحيات Actions/Contents/Pull requests (قراءة وكتابة).
 */
export interface WorkflowRun {
  id: number
  name?: string | null
  display_title?: string | null
  status: string                 // queued | in_progress | completed
  conclusion: string | null      // success | failure | cancelled ...
  html_url: string
  created_at: string
  head_branch?: string | null
}

export interface PullRequest {
  number: number
  html_url: string
  title: string
  body: string | null
  state: string
  merged_at?: string | null
  merge_commit_sha?: string | null
  head: { sha: string; ref: string }
  base: { ref: string }
}

export interface PrFile { filename: string; additions: number; deletions: number }

export interface GitHubClient {
  dispatchWorkflow(repo: string, workflow: string, ref: string, inputs: Record<string, string>): Promise<void>
  listRuns(repo: string, workflow: string, createdAfter: Date): Promise<WorkflowRun[]>
  findPrByBranch(repo: string, branch: string): Promise<PullRequest | null>
  getPr(repo: string, n: number): Promise<PullRequest>
  prFiles(repo: string, n: number): Promise<PrFile[]>
  /** sha = الرأس الذي وافق عليه المالك — GitHub يرفض (409) إن تغيّر الفرع بعدها */
  mergePr(repo: string, n: number, sha: string): Promise<{ sha?: string } | void>
  closePr(repo: string, n: number): Promise<void>
  deleteBranch(repo: string, branch: string): Promise<void>
  getFileContent(repo: string, path: string): Promise<string>
  /** اختياري: commit واحد (لنسخة البوت) */
  getCommit?(repo: string, ref: string): Promise<{ sha: string; message: string; date: string }>
  /** اختياري: نص أخطاء تشغيل فاشل (annotations للمهام الفاشلة) — لكشف حد استخدام Claude */
  runFailureText?(repo: string, runId: number | string): Promise<string>
  /** اختياري: سؤال توضيحي فتحه Claude كـ issue عنوانه `[claude-question] <request_id>` */
  findQuestion?(repo: string, requestId: string): Promise<{ number: number; html_url: string; body: string } | null>
  closeIssue?(repo: string, n: number): Promise<void>
  /** اختياري: بحث كود داخل مستودع (GET /search/code) مع مقتطفات السطور */
  searchCode?(repo: string, term: string): Promise<CodeHit[]>
  /** اختياري: issue مفتوح عنوانه يبدأ بـ prefix (تقرير Claude في وضع "تقرير فقط": `[claude-report] <id>`) */
  findIssue?(repo: string, titlePrefix: string): Promise<{ number: number; html_url: string; body: string } | null>
  /**
   * اختياري: وش توصّل له Claude في تشغيل انتهى بلا PR — issue (مفتوح أو مسكّر) فيه رقم الطلب
   * ([claude-report]/[claude-question]) وإلا الرسالة الختامية من سجل التشغيل ("result").
   */
  runConclusion?(repo: string, runId: number | string, requestId: string): Promise<{ text: string; url: string | null; source: 'issue' | 'log' } | null>
}

/** الرسالة الختامية لـ Claude من سجل التشغيل: آخر حقل "result" (JSON) في السجل */
export function conclusionFromLog(log: string): string | null {
  const re = /"result"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let last: string | null = null
  for (const m of log.matchAll(re)) last = m[1]
  if (!last) return null
  try { last = JSON.parse(`"${last}"`) as string } catch { /* نص خام */ }
  const t = last.trim()
  return t ? t.slice(0, 3000) : null
}

export interface CodeHit { path: string; html_url: string; fragments: string[] }

const API = 'https://api.github.com'
export const QUESTION_PREFIX = '[claude-question]'

export function httpGitHub(token: string): GitHubClient {
  async function gh(method: string, path: string, body?: unknown, accept = 'application/vnd.github+json') {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'personal-assistant',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${t.slice(0, 300)}`)
    }
    return res
  }
  const json = async (method: string, path: string, body?: unknown) => {
    const res = await gh(method, path, body)
    return res.status === 204 ? null : res.json()
  }

  return {
    async dispatchWorkflow(repo, workflow, ref, inputs) {
      await gh('POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs })
    },
    async listRuns(repo, workflow, createdAfter) {
      // هامش دقيقتين لفروق الساعة بيننا وبين GitHub
      const since = new Date(createdAfter.getTime() - 120_000).toISOString().replace(/\.\d+Z$/, 'Z')
      const j = (await json('GET',
        `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=20&created=${encodeURIComponent('>=' + since)}`)) as any
      return (j?.workflow_runs ?? []) as WorkflowRun[]
    },
    async findPrByBranch(repo, branch) {
      const owner = repo.split('/')[0]
      const j = (await json('GET', `/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`)) as any[]
      return j?.[0] ?? null
    },
    async getPr(repo, n) {
      return (await json('GET', `/repos/${repo}/pulls/${n}`)) as PullRequest
    },
    async prFiles(repo, n) {
      const j = (await json('GET', `/repos/${repo}/pulls/${n}/files?per_page=100`)) as any[]
      return (j ?? []).map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions }))
    },
    async mergePr(repo, n, sha) {
      const j = (await json('PUT', `/repos/${repo}/pulls/${n}/merge`, { merge_method: 'squash', sha })) as any
      return { sha: j?.sha }
    },
    async closePr(repo, n) {
      await json('PATCH', `/repos/${repo}/pulls/${n}`, { state: 'closed' })
    },
    async deleteBranch(repo, branch) {
      await gh('DELETE', `/repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`)
    },
    async runFailureText(repo, runId) {
      const jobs = (await json('GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=50`)) as any
      const texts: string[] = []
      for (const j of (jobs?.jobs ?? []).filter((x: any) => x.conclusion && x.conclusion !== 'success').slice(0, 5)) {
        const ann = (await json('GET', `/repos/${repo}/check-runs/${j.id}/annotations`).catch(() => [])) as any[]
        for (const a of ann ?? []) texts.push(`${a.title ?? ''} ${a.message ?? ''}`.trim())
      }
      return texts.join('\n').slice(0, 4000)
    },
    async findQuestion(repo, requestId) {
      const j = (await json('GET', `/repos/${repo}/issues?state=open&per_page=30`)) as any[]
      const prefix = `${QUESTION_PREFIX} ${requestId}`
      const hit = (j ?? []).find((i) => !i.pull_request && String(i.title ?? '').startsWith(prefix))
      return hit ? { number: hit.number, html_url: hit.html_url, body: String(hit.body ?? '') } : null
    },
    async findIssue(repo, titlePrefix) {
      const j = (await json('GET', `/repos/${repo}/issues?state=open&per_page=30`)) as any[]
      const hit = (j ?? []).find((i) => !i.pull_request && String(i.title ?? '').startsWith(titlePrefix))
      return hit ? { number: hit.number, html_url: hit.html_url, body: String(hit.body ?? '') } : null
    },
    async runConclusion(repo, runId, requestId) {
      const issues = (await json('GET', `/repos/${repo}/issues?state=all&per_page=30&sort=created&direction=desc`).catch(() => [])) as any[]
      const hit = (issues ?? []).find((i) => !i.pull_request && String(i.title ?? '').includes(requestId) && String(i.body ?? '').trim())
      if (hit) return { text: String(hit.body).trim().slice(0, 3000), url: hit.html_url, source: 'issue' as const }
      const jobs = (await json('GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=20`).catch(() => null)) as any
      for (const j of (jobs?.jobs ?? []).slice(0, 5)) {
        const log = await gh('GET', `/repos/${repo}/actions/jobs/${j.id}/logs`).then((r) => r.text()).catch(() => '')
        const text = conclusionFromLog(log)
        if (text) return { text, url: null, source: 'log' as const }
      }
      return null
    },
    async closeIssue(repo, n) {
      await json('PATCH', `/repos/${repo}/issues/${n}`, { state: 'closed' })
    },
    async searchCode(repo, term) {
      const q = `${term} repo:${repo}`
      const res = await gh('GET', `/search/code?per_page=10&q=${encodeURIComponent(q)}`, undefined, 'application/vnd.github.text-match+json')
      const j = (await res.json()) as any
      return (j?.items ?? []).map((it: any) => ({
        path: String(it.path),
        html_url: String(it.html_url),
        fragments: (it.text_matches ?? []).map((m: any) => String(m.fragment ?? '')).filter(Boolean),
      }))
    },
    async getCommit(repo, ref) {
      const j = (await json('GET', `/repos/${repo}/commits/${encodeURIComponent(ref)}`)) as any
      return { sha: j.sha, message: j.commit?.message ?? '', date: j.commit?.committer?.date ?? j.commit?.author?.date ?? '' }
    },
    async getFileContent(repo, path) {
      const res = await gh('GET', `/repos/${repo}/contents/${path}`, undefined, 'application/vnd.github.raw+json')
      return res.text()
    },
  }
}
