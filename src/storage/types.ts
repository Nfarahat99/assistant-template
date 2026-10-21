export interface StoredFile { key: string; sha256: string; size: number }
export interface FileStore {
  put(data: Buffer, hint: { filename: string }): Promise<StoredFile>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
}
