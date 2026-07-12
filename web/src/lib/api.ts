import type {
  AuthResponse,
  Channel,
  ChannelsResponse,
  Doc,
  DocMentionsResponse,
  DocRolesResponse,
  DocSearchResponse,
  DocsResponse,
  Message,
  MembersResponse,
  MessagesResponse,
  SearchResponse,
  ThreadResponse,
  User,
  UsersResponse,
} from './types'

const TOKEN_KEY = 'sharp.token'
const SERVER_URL_KEY = 'sharp.serverUrl'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
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
    clearToken()
    onUnauthorized?.()
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
  sendMessage(channelId: string, content: string, parent_id?: string) {
    return request<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: parent_id ? { content, parent_id } : { content },
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

  // --- search ---
  search(q: string, limit = 20) {
    const params = new URLSearchParams({ q, limit: String(limit) })
    return request<SearchResponse>(`/search?${params.toString()}`)
  },

  // --- docs ---
  channelDocs(channelId: string) {
    return request<DocsResponse>(`/channels/${channelId}/docs`)
  },
  channelDocsTrash(channelId: string) {
    return request<DocsResponse>(`/channels/${channelId}/docs/trash`)
  },
  createDoc(channelId: string, input: { title?: string; icon?: string } = {}) {
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
  docSearch(q: string, limit = 20) {
    const params = new URLSearchParams({ q, limit: String(limit) })
    return request<DocSearchResponse>(`/docs/search?${params.toString()}`)
  },
}
