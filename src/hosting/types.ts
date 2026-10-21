export interface HostingStatus { state: 'running' | 'deploying' | 'failed' | 'unknown'; commit: string | null; deployedAt: string | null; detail?: string }
export interface Hosting {
  readonly provider: 'railway' | 'none'
  status(): Promise<HostingStatus>
  logs(lines?: number): Promise<string[]>
  /** إعادة نشر — يُستدعى فقط بعد موافقة المالك (pending) */
  redeploy(): Promise<{ ok: boolean; message: string }>
}
