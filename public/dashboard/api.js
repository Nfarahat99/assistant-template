// Thin fetch wrapper for /api/dash. `?mock=1` routes every call to mock.js instead.
const BASE = '/api/dash'
export const isMock = new URLSearchParams(location.search).get('mock') === '1'
let mock

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export async function api(path, { method = 'GET', body } = {}) {
  if (isMock) {
    mock ??= await import('./mock.js')
    try { return await mock.handle(method, path, body) } catch (e) {
      if (e.status === 401) window.dispatchEvent(new Event('auth:required'))
      throw e
    }
  }
  let res
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'same-origin',
      // X-Requested-With: حماية CSRF — الخادم يرفض أي طلب تعديل بدونها
      headers: body !== undefined ? { 'content-type': 'application/json', 'x-requested-with': 'dash' } : { 'x-requested-with': 'dash' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'تعذّر الوصول إلى الخادم. تحقّق من الاتصال ثم أعد المحاولة.')
  }
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
  if (res.status === 401 && path !== '/login') {
    window.dispatchEvent(new Event('auth:required'))
    throw new ApiError(401, 'انتهت الجلسة، سجّل الدخول من جديد.')
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || data?.message || `خطأ من الخادم (${res.status})`)
  return data
}
