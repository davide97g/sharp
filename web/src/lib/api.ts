import type {
  Attachment,
  AuthResponse,
  Channel,
  ChannelsResponse,
  DesktopCodeResponse,
  Doc,
  DocMentionsResponse,
  DocRolesResponse,
  DocSearchResponse,
  DocsResponse,
  GifConfig,
  GifResult,
  GifSettings,
  GifSuggestResponse,
  IceConfigResponse,
  Message,
  MembersResponse,
  MessagesResponse,
  NotificationsResponse,
  Prefs,
  SearchResponse,
  ThreadResponse,
  User,
  UsersResponse,
  VapidResponse,
  VoiceLinkResponse,
  VoiceLinkCreateResponse,
  CallLinkInfoResponse,
  CallLinkJoinResponse,
} from './types'

const TOKEN_KEY = 'sharp.token'
const SERVER_URL_KEY = 'sharp.serverUrl'

// In-memory auth override for guest call sessions. When set, it wins over the
// persisted login token so a guest can authenticate the WS + voice/config
// without touching `sharp.token` (no collision with a real login in the same
// browser). Null = fall back to the stored token.
let sessionToken: string | null = null
export function setSessionToken(token: string | null) {
  sessionToken = token
}
export function hasSessionToken(): boolean {
  return sessionToken !== null
}

export function getToken(): string | null {
  return sessionToken ?? localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY)
}

export function getServerUrl(): string | null {
  return localStorage.getItem(SERVER_URL_KEY)
}
export function setServerUrl(url: string) {
  localStorage.setItem(SERVER_URL_KEY, url)
}

/** Base URL resolution per the contract. */
export function resolveBaseUrl(): string {
  const env = import.meta.env.VITE_API_URL as string | undefined
  const base = env || getServerUrl() || window.location.origin
  return base.replace(/\/+$/, '')
}

export function apiBase(): string {
  return `${resolveBaseUrl()}/api/v1`
}

/** Custom error carrying the server's error code + HTTP status. */
export class ApiRequestError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
  }
}

let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

type ReqOpts = {
  method?: string
  body?: unknown
  auth?: boolean // default true
  signal?: AbortSignal
}

async function request<T>(path: string, opts: ReqOpts = {}): Promise<T> {
  const { method = 'GET', body, auth = true, signal } = opts
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (auth) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  })

  if (res.status === 401 && auth) {
    // Guest sessions authenticate via the in-memory override, not `sharp.token`.
    // A guest-page 401 must NOT wipe a real login or run the app's
    // logout/navigate flow — just surface the error to the guest page.
    if (!hasSessionToken()) {
      clearToken()
      onUnauthorized?.()
    }
    throw new ApiRequestError('Unauthorized', 'unauthorized', 401)
  }

  if (res.status === 204) {
    return undefined as T
  }

  const text = await res.text()
  const data = text ? JSON.parse(text) : undefined

  if (!res.ok) {
    const code = data?.error?.code ?? 'error'
    const message = data?.error?.message ?? `Request failed (${res.status})`
    throw new ApiRequestError(message, code, res.status)
  }

  return data as T
}

export const api = {
  voice: {
    config: () => request<IceConfigResponse>('/voice/config'),
  },

  // --- public guest call links ---
  voiceLink: {
    // Fetch the channel's current public call link (member only).
    get: (channelId: string) =>
      request<VoiceLinkResponse>(`/channels/${channelId}/voice-link`),
    // Mint a fresh link, revoking any previous one (member only).
    create: (channelId: string) =>
      request<VoiceLinkCreateResponse>(`/channels/${channelId}/voice-link`, {
        method: 'POST',
      }),
  },
  callLink: {
    // Public: resolve a call link token to its channel name (404 if invalid).
    info: (token: string) =>
      request<CallLinkInfoResponse>(`/call-links/${token}`, { auth: false }),
    // Public: join the call as a guest, receiving a short-lived guest JWT.
    join: (token: string, name: string) =>
      request<CallLinkJoinResponse>(`/call-links/${token}/join`, {
        method: 'POST',
        body: { name },
        auth: false,
      }),
  },

  // --- auth ---
  register(email: string, password: string, display_name: string) {
    return request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: { email, password, display_name },
      auth: false,
    })
  },
  login(email: string, password: string) {
    return request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    })
  },
  me() {
    return request<User>('/me')
  },
  // Desktop browser-login: mint a one-time code for the signed-in web session,
  // then exchange it for a JWT from the native app.
  desktopCode() {
    return request<DesktopCodeResponse>('/auth/desktop/code', { method: 'POST' })
  },
  desktopExchange(code: string) {
    return request<AuthResponse>('/auth/desktop/exchange', {
      method: 'POST',
      body: { code },
      auth: false,
    })
  },
  updateProfile(input: { display_name?: string }) {
    return request<User>('/me', { method: 'PATCH', body: input })
  },
  deleteAvatar() {
    return request<User>('/me/avatar', { method: 'DELETE' })
  },
  uploadAvatar(file: Blob, onProgress?: (fraction: number) => void): Promise<User> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file, 'avatar.png')
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${apiBase()}/me/avatar`)
      const token = getToken()
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total)
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as User)
          } catch {
            reject(new ApiRequestError('bad upload response', 'error', xhr.status))
          }
        } else {
          if (xhr.status === 401) {
            clearToken()
            onUnauthorized?.()
          }
          let message = `Upload failed (${xhr.status})`
          try {
            message = JSON.parse(xhr.responseText)?.error?.message ?? message
          } catch {
            /* ignore */
          }
          reject(new ApiRequestError(message, 'error', xhr.status))
        }
      }
      xhr.onerror = () => reject(new ApiRequestError('network error', 'error', 0))
      xhr.send(form)
    })
  },

  // --- users ---
  users() {
    return request<UsersResponse>('/users')
  },

  // --- channels ---
  channels() {
    return request<ChannelsResponse>('/channels')
  },
  createChannel(input: {
    name: string
    kind: 'public' | 'private'
    topic?: string
    member_ids?: string[]
  }) {
    return request<Channel>('/channels', { method: 'POST', body: input })
  },
  createDm(user_id: string) {
    return request<Channel>('/channels/dm', {
      method: 'POST',
      body: { user_id },
    })
  },
  updateChannel(
    id: string,
    input: { name?: string; topic?: string; kind?: 'public' | 'private' },
  ) {
    return request<Channel>(`/channels/${id}`, { method: 'PATCH', body: input })
  },
  deleteChannel(id: string) {
    return request<void>(`/channels/${id}`, { method: 'DELETE' })
  },
  addMembers(id: string, user_ids: string[]) {
    return request<void>(`/channels/${id}/members`, {
      method: 'POST',
      body: { user_ids },
    })
  },
  removeMember(id: string, userId: string) {
    return request<void>(`/channels/${id}/members/${userId}`, { method: 'DELETE' })
  },
  joinChannel(id: string) {
    return request<void>(`/channels/${id}/join`, { method: 'POST' })
  },
  leaveChannel(id: string) {
    return request<void>(`/channels/${id}/leave`, { method: 'POST' })
  },
  members(id: string) {
    return request<MembersResponse>(`/channels/${id}/members`)
  },
  markRead(id: string, message_id: string) {
    return request<void>(`/channels/${id}/read`, {
      method: 'POST',
      body: { message_id },
    })
  },

  // --- messages ---
  messages(channelId: string, before?: string, limit = 50) {
    const params = new URLSearchParams()
    if (before) params.set('before', before)
    params.set('limit', String(limit))
    return request<MessagesResponse>(
      `/channels/${channelId}/messages?${params.toString()}`,
    )
  },
  sendMessage(
    channelId: string,
    content: string,
    parent_id?: string,
    attachment_ids?: string[],
    reply_to_id?: string,
  ) {
    const body: Record<string, unknown> = { content }
    if (parent_id) body.parent_id = parent_id
    if (attachment_ids && attachment_ids.length) body.attachment_ids = attachment_ids
    if (reply_to_id) body.reply_to_id = reply_to_id
    return request<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body,
    })
  },
  thread(messageId: string) {
    return request<ThreadResponse>(`/messages/${messageId}/thread`)
  },
  editMessage(messageId: string, content: string) {
    return request<Message>(`/messages/${messageId}`, {
      method: 'PATCH',
      body: { content },
    })
  },
  deleteMessage(messageId: string) {
    return request<void>(`/messages/${messageId}`, { method: 'DELETE' })
  },
  addReaction(messageId: string, emoji: string) {
    return request<void>(
      `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'PUT' },
    )
  },
  removeReaction(messageId: string, emoji: string) {
    return request<void>(
      `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' },
    )
  },

  // --- files ---
  uploadFile(
    channelId: string,
    file: File,
    onProgress?: (fraction: number) => void,
  ): Promise<Attachment> {
    return new Promise((resolve, reject) => {
      const form = new FormData()
      form.append('file', file, file.name)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${apiBase()}/channels/${channelId}/uploads`)
      const token = getToken()
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total)
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as Attachment)
          } catch {
            reject(new ApiRequestError('bad upload response', 'error', xhr.status))
          }
        } else {
          if (xhr.status === 401) {
            clearToken()
            onUnauthorized?.()
          }
          let message = `Upload failed (${xhr.status})`
          try {
            message = JSON.parse(xhr.responseText)?.error?.message ?? message
          } catch {
            /* ignore */
          }
          reject(new ApiRequestError(message, 'error', xhr.status))
        }
      }
      xhr.onerror = () => reject(new ApiRequestError('network error', 'error', 0))
      xhr.send(form)
    })
  },

  // --- notifications ---
  notifications(before?: string, limit = 30) {
    const params = new URLSearchParams()
    if (before) params.set('before', before)
    params.set('limit', String(limit))
    return request<NotificationsResponse>(`/notifications?${params.toString()}`)
  },
  markNotificationsRead(opts: { ids?: string[]; all?: boolean }) {
    return request<void>('/notifications/read', { method: 'POST', body: opts })
  },

  // --- preferences ---
  prefs() {
    return request<Prefs>('/prefs')
  },
  setDnd(dnd: boolean) {
    return request<void>('/prefs/dnd', { method: 'PUT', body: { dnd } })
  },
  setChatLayout(chat_layout: 'bubble' | 'classic') {
    return request<void>('/prefs/chat-layout', { method: 'PUT', body: { chat_layout } })
  },
  setChannelMute(channelId: string, muted: boolean) {
    return request<void>(`/channels/${channelId}/prefs`, {
      method: 'PUT',
      body: { muted },
    })
  },

  // --- web push ---
  vapidPublicKey() {
    return request<VapidResponse>('/push/vapid')
  },
  subscribePush(sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return request<void>('/push/subscribe', { method: 'POST', body: sub })
  },
  unsubscribePush(endpoint: string) {
    return request<void>('/push/unsubscribe', { method: 'POST', body: { endpoint } })
  },

  // --- search ---
  search(q: string, limit = 20, channelId?: string) {
    const params = new URLSearchParams({ q, limit: String(limit) })
    if (channelId) params.set('channel_id', channelId)
    return request<SearchResponse>(`/search?${params.toString()}`)
  },

  // --- GIFs ---
  gifConfig() {
    return request<GifConfig>('/gifs/config')
  },
  searchGifs(q: string, limit = 24) {
    const params = new URLSearchParams({ q, limit: String(limit) })
    return request<{ results: GifResult[] }>(`/gifs/search?${params.toString()}`)
  },
  getGifSettings() {
    return request<GifSettings>('/gifs/settings')
  },
  putGifSettings(body: {
    provider?: string
    api_key?: string
    duck_enabled?: boolean
    duck_cooldown_secs?: number
    duck_context?: string
  }) {
    return request<GifSettings>('/gifs/settings', { method: 'PUT', body })
  },
  gifSuggest(channelId: string) {
    return request<GifSuggestResponse>(`/channels/${channelId}/gif-suggest`, {
      method: 'POST',
    })
  },
  gifSuggestVoice(channelId: string) {
    return request<GifSuggestResponse>(`/channels/${channelId}/gifs/suggest-voice`)
  },

  // --- docs ---
  channelDocs(channelId: string) {
    return request<DocsResponse>(`/channels/${channelId}/docs`)
  },
  channelDocsTrash(channelId: string) {
    return request<DocsResponse>(`/channels/${channelId}/docs/trash`)
  },
  createDoc(
    channelId: string,
    input: { title?: string; icon?: string; kind?: 'doc' | 'canvas' } = {},
  ) {
    return request<Doc>(`/channels/${channelId}/docs`, {
      method: 'POST',
      body: input,
    })
  },
  getDoc(id: string) {
    return request<Doc>(`/docs/${id}`)
  },
  patchDoc(
    id: string,
    input: { title?: string; icon?: string; everyone_role?: 'editor' | 'viewer' | 'none' },
  ) {
    return request<Doc>(`/docs/${id}`, { method: 'PATCH', body: input })
  },
  deleteDoc(id: string) {
    return request<void>(`/docs/${id}`, { method: 'DELETE' })
  },
  restoreDoc(id: string) {
    return request<Doc>(`/docs/${id}/restore`, { method: 'POST' })
  },
  permanentDeleteDoc(id: string) {
    return request<void>(`/docs/${id}/permanent`, { method: 'DELETE' })
  },
  docRoles(id: string) {
    return request<DocRolesResponse>(`/docs/${id}/roles`)
  },
  putDocRole(id: string, userId: string, role: 'editor' | 'viewer' | 'none') {
    return request<void>(`/docs/${id}/roles/${userId}`, {
      method: 'PUT',
      body: { role },
    })
  },
  deleteDocRole(id: string, userId: string) {
    return request<void>(`/docs/${id}/roles/${userId}`, { method: 'DELETE' })
  },
  backlinks(id: string) {
    return request<DocsResponse>(`/docs/${id}/backlinks`)
  },
  addDocMention(id: string, userId: string) {
    return request<void>(`/docs/${id}/mentions`, {
      method: 'POST',
      body: { user_id: userId },
    })
  },
  mentions() {
    return request<DocMentionsResponse>('/mentions')
  },
  markMentionsRead(ids: string[]) {
    return request<void>('/mentions/read', { method: 'POST', body: { ids } })
  },
  docSearch(q: string, limit = 20, docId?: string) {
    const params = new URLSearchParams({ q, limit: String(limit) })
    if (docId) params.set('doc_id', docId)
    return request<DocSearchResponse>(`/docs/search?${params.toString()}`)
  },
}

/** Absolute URL for a proxied attachment path (handles custom server origins). */
export function attachmentAbsoluteUrl(url: string): string {
  return url.startsWith('http') ? url : `${resolveBaseUrl()}${url}`
}

/** Fetch an attachment as a Blob with the auth header (for <img> / downloads). */
export async function fetchAttachmentBlob(url: string): Promise<Blob> {
  const token = getToken()
  const res = await fetch(attachmentAbsoluteUrl(url), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    throw new ApiRequestError(`download failed (${res.status})`, 'error', res.status)
  }
  return res.blob()
}
