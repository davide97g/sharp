import type {
  Attachment,
  AuthResponse,
  Channel,
  ChannelRole,
  ChannelsResponse,
  DesktopCodeResponse,
  Doc,
  DocMentionsResponse,
  DocRolesResponse,
  DocSearchResponse,
  DocsResponse,
  E2eeBackup,
  E2eeBackupInput,
  E2eeDevice,
  E2eeDevicesResponse,
  GifConfig,
  GifResult,
  GifSettings,
  GifSuggestResponse,
  VoiceConfigResponse,
  TranscriptionResponse,
  Message,
  MembersResponse,
  MessagesResponse,
  NotificationsResponse,
  Prefs,
  PrefsUpdate,
  ChannelNotifyMode,
  PasskeyChallenge,
  PasskeyConfig,
  PasskeyList,
  PasskeyManageStart,
  PasskeyRecord,
  SearchResponse,
  ThreadResponse,
  User,
  UsersResponse,
  VapidResponse,
  VoiceLinkResponse,
  VoiceLinkCreateResponse,
  VoiceTrigger,
  VoiceTriggersResponse,
  CallLinkInfoResponse,
  CallLinkJoinResponse,
  MeetingDetail,
  MeetingsResponse,
  MeetingAction,
  StandaloneCallCreateResponse,
  CalendarConnectionsResponse,
  CalendarConnectUrlResponse,
  CalendarEventsResponse,
  ScheduledMeeting,
  Poll,
  Project,
  Task,
  TaskComment,
  TaskCreateInput,
  TaskDetail,
  TaskLabel,
  TaskUpdateInput,
  SharpyConversation,
  SharpyConversationDetail,
  SharpyMessage,
  SharpySource,
  SharpyStatusResponse,
  SharpyStreamEvent,
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

function uploadAttachment(
  path: string,
  file: File,
  onProgress?: (fraction: number) => void,
  encrypted = false,
): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file, file.name)
    if (encrypted) form.append('encrypted', 'true')
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${apiBase()}${path}`)
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as Attachment)
        } catch {
          reject(new ApiRequestError('bad upload response', 'error', xhr.status))
        }
        return
      }
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
    xhr.onerror = () => reject(new ApiRequestError('network error', 'error', 0))
    xhr.send(form)
  })
}

async function transcribeAudio(
  audio: Blob,
  signal?: AbortSignal,
): Promise<TranscriptionResponse> {
  const headers: Record<string, string> = {
    'Content-Type': audio.type || 'audio/webm;codecs=opus',
  }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${apiBase()}/voice/transcriptions`, {
    method: 'POST',
    headers,
    body: audio,
    signal,
  })

  if (res.status === 401) {
    if (!hasSessionToken()) {
      clearToken()
      onUnauthorized?.()
    }
    throw new ApiRequestError('Unauthorized', 'unauthorized', 401)
  }

  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!res.ok) {
    const error = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiRequestError(
      error?.error?.message ?? `Request failed (${res.status})`,
      error?.error?.code ?? 'error',
      res.status,
    )
  }
  return data as TranscriptionResponse
}

export const api = {
  tasks: {
    projects: () => request<{ projects: Project[] }>('/projects'),
    createProject: (input: { key: string; name: string; icon?: string; channel_id?: string }) =>
      request<Project>('/projects', { method: 'POST', body: input }),
    updateProject: (
      id: string,
      input: { name?: string; icon?: string; channel_id?: string | null; archived?: boolean },
    ) => request<Project>(`/projects/${id}`, { method: 'PATCH', body: input }),
    list: (
      projectId: string,
      filters: {
        state_type?: string
        assignee?: string
        label?: string
        priority?: number
        q?: string
      } = {},
    ) => {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== '') params.set(k, String(v))
      }
      const query = params.toString()
      return request<{ tasks: Task[] }>(
        `/projects/${projectId}/tasks${query ? `?${query}` : ''}`,
      )
    },
    create: (projectId: string, input: TaskCreateInput) =>
      request<Task>(`/projects/${projectId}/tasks`, { method: 'POST', body: input }),
    get: (id: string) => request<TaskDetail>(`/tasks/${id}`),
    byKey: (identifier: string) =>
      request<Task>(`/tasks/by-key/${encodeURIComponent(identifier)}`),
    update: (id: string, patch: TaskUpdateInput) =>
      request<Task>(`/tasks/${id}`, { method: 'PATCH', body: patch }),
    delete: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
    mine: () => request<{ tasks: Task[] }>('/me/tasks'),
    search: (q: string, limit = 10) =>
      request<{ tasks: Task[] }>(`/tasks/search?q=${encodeURIComponent(q)}&limit=${limit}`),
    comment: (taskId: string, body: string) =>
      request<TaskComment>(`/tasks/${taskId}/comments`, { method: 'POST', body: { body } }),
    updateComment: (id: string, body: string) =>
      request<TaskComment>(`/task-comments/${id}`, { method: 'PATCH', body: { body } }),
    deleteComment: (id: string) =>
      request<void>(`/task-comments/${id}`, { method: 'DELETE' }),
    labels: () => request<{ labels: TaskLabel[] }>('/task-labels'),
    createLabel: (input: { name: string; color: string }) =>
      request<TaskLabel>('/task-labels', { method: 'POST', body: input }),
    updateLabel: (id: string, input: { name: string; color: string }) =>
      request<TaskLabel>(`/task-labels/${id}`, { method: 'PATCH', body: input }),
    deleteLabel: (id: string) => request<void>(`/task-labels/${id}`, { method: 'DELETE' }),
  },
  polls: {
    create: (
      channelId: string,
      input: {
        question: string
        options: string[]
        multi: boolean
        pinned: boolean
        expires_at?: string
      },
    ) =>
      request<Poll>(`/channels/${channelId}/polls`, {
        method: 'POST',
        body: input,
      }),
    get: (id: string) => request<Poll>(`/polls/${id}`),
    vote: (id: string, optionIds: string[]) =>
      request<Poll>(`/polls/${id}/vote`, {
        method: 'POST',
        body: { option_ids: optionIds },
      }),
    retract: (id: string) =>
      request<Poll>(`/polls/${id}/vote`, { method: 'DELETE' }),
    close: (id: string) =>
      request<Poll>(`/polls/${id}/close`, { method: 'POST' }),
    pin: (id: string, pinned: boolean) =>
      request<Poll>(`/polls/${id}/pin`, {
        method: 'POST',
        body: { pinned },
      }),
    delete: (id: string) =>
      request<void>(`/polls/${id}`, { method: 'DELETE' }),
    listActive: (channelId: string) =>
      request<{ polls: Poll[] }>(`/channels/${channelId}/polls?active=1`),
  },
  calls: {
    create: (title: string) =>
      request<StandaloneCallCreateResponse>('/calls', { method: 'POST', body: { title } }),
  },
  meetings: {
    list: (input: { channelId?: string; q?: string; before?: string; limit?: number } = {}) => {
      const params = new URLSearchParams()
      if (input.channelId) params.set('channel_id', input.channelId)
      if (input.q) params.set('q', input.q)
      if (input.before) params.set('before', input.before)
      if (input.limit) params.set('limit', String(input.limit))
      const query = params.toString()
      return request<MeetingsResponse>(`/meetings${query ? `?${query}` : ''}`)
    },
    get: (id: string) => request<MeetingDetail>(`/meetings/${id}`),
    update: (id: string, input: { title?: string; summary?: string; decisions?: string }) =>
      request<MeetingDetail>(`/meetings/${id}`, { method: 'PATCH', body: input }),
    saveActions: (
      id: string,
      actions: Pick<MeetingAction, 'id' | 'text' | 'assignee_user_id' | 'completed'>[],
    ) => request<MeetingDetail>(`/meetings/${id}/actions`, {
      method: 'PUT',
      body: { actions },
    }),
    regenerate: (id: string) =>
      request<{ summary_status: string }>(`/meetings/${id}/regenerate`, { method: 'POST' }),
    delete: (id: string) => request<void>(`/meetings/${id}`, { method: 'DELETE' }),
  },
  voice: {
    config: () => request<VoiceConfigResponse>('/voice/config'),
    transcribe: (audio: Blob, signal?: AbortSignal) => transcribeAudio(audio, signal),
  },
  voiceTriggers: {
    listPersonal: () => request<VoiceTriggersResponse>('/voice/triggers'),
    createPersonal: (phrase: string) =>
      request<VoiceTrigger>('/voice/triggers', { method: 'POST', body: { phrase } }),
    deletePersonal: (triggerId: string) =>
      request<void>(`/voice/triggers/${triggerId}`, { method: 'DELETE' }),
    listChannel: (channelId: string) =>
      request<VoiceTriggersResponse>(`/channels/${channelId}/voice-triggers`),
    createChannel: (channelId: string, phrase: string) =>
      request<VoiceTrigger>(`/channels/${channelId}/voice-triggers`, {
        method: 'POST',
        body: { phrase },
      }),
    deleteChannel: (channelId: string, triggerId: string) =>
      request<void>(`/channels/${channelId}/voice-triggers/${triggerId}`, {
        method: 'DELETE',
      }),
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
    // Public: resolve a call link token to its room metadata (404 if invalid).
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
  passkeyConfig() {
    return request<PasskeyConfig>('/auth/passkeys/config', { auth: false })
  },
  passkeyLoginStart() {
    return request<PasskeyChallenge>('/auth/passkeys/login/start', {
      method: 'POST',
      auth: false,
    })
  },
  passkeyLoginFinish(ceremony_id: string, credential: unknown) {
    return request<AuthResponse>('/auth/passkeys/login/finish', {
      method: 'POST',
      body: { ceremony_id, credential },
      auth: false,
    })
  },
  passkeys() {
    return request<PasskeyList>('/auth/passkeys')
  },
  passkeyRegisterStart(name: string, password: string) {
    return request<PasskeyChallenge>('/auth/passkeys', {
      method: 'POST',
      body: { name, password },
    })
  },
  passkeyRegisterFinish(ceremony_id: string, credential: unknown) {
    return request<PasskeyRecord>('/auth/passkeys/register/finish', {
      method: 'POST',
      body: { ceremony_id, credential },
    })
  },
  renamePasskey(id: string, name: string) {
    return request<PasskeyRecord>(`/auth/passkeys/${id}`, {
      method: 'PATCH',
      body: { name },
    })
  },
  removePasskey(id: string, password: string) {
    return request<void>(`/auth/passkeys/${id}`, {
      method: 'DELETE',
      body: { password },
    })
  },
  dismissPasskeyPrompt() {
    return request<void>('/auth/passkeys/prompt/dismiss', { method: 'POST' })
  },
  startPasskeyManagement() {
    return request<PasskeyManageStart>('/auth/passkeys/manage/start', { method: 'POST' })
  },
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
  passwordResetConfig() {
    return request<{ enabled: boolean }>('/auth/password/config', { auth: false })
  },
  forgotPassword(email: string) {
    return request<void>('/auth/password/forgot', {
      method: 'POST',
      body: { email },
      auth: false,
    })
  },
  resetPassword(token: string, password: string) {
    return request<void>('/auth/password/reset', {
      method: 'POST',
      body: { token, password },
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
  nicknames() {
    return request<{ nicknames: Record<string, string> }>('/me/nicknames')
  },
  setNickname(userId: string, nickname: string) {
    return request<void>(`/users/${userId}/nickname`, {
      method: 'PUT',
      body: { nickname },
    })
  },
  deleteNickname(userId: string) {
    return request<void>(`/users/${userId}/nickname`, { method: 'DELETE' })
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
  setChannelMemberRole(id: string, userId: string, role: ChannelRole) {
    return request<void>(`/channels/${id}/members/${userId}/role`, {
      method: 'PUT',
      body: { role },
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
  sendMessage(
    channelId: string,
    content: string,
    parent_id?: string,
    attachment_ids?: string[],
    reply_to_id?: string,
    encrypted?: boolean,
  ) {
    const body: Record<string, unknown> = { content }
    if (parent_id) body.parent_id = parent_id
    if (attachment_ids && attachment_ids.length) body.attachment_ids = attachment_ids
    if (reply_to_id) body.reply_to_id = reply_to_id
    if (encrypted !== undefined) body.encrypted = encrypted
    return request<Message>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body,
    })
  },
  thread(messageId: string) {
    return request<ThreadResponse>(`/messages/${messageId}/thread`)
  },
  editMessage(messageId: string, content: string, encrypted?: boolean) {
    return request<Message>(`/messages/${messageId}`, {
      method: 'PATCH',
      body: { content, ...(encrypted !== undefined ? { encrypted } : {}) },
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

  // --- end-to-end encryption ---
  e2eeDevices(userId: string) {
    const params = new URLSearchParams({ user_id: userId })
    return request<E2eeDevicesResponse>(`/e2ee/devices?${params.toString()}`)
  },
  registerDevice(device: Pick<E2eeDevice, 'id' | 'name' | 'x25519_pub' | 'ed25519_pub'>) {
    return request<void>('/e2ee/devices', { method: 'POST', body: device })
  },
  deleteDevice(id: string) {
    return request<void>(`/e2ee/devices/${id}`, { method: 'DELETE' })
  },
  getBackup() {
    return request<E2eeBackup>('/e2ee/backup')
  },
  putBackup(backup: E2eeBackupInput) {
    return request<void>('/e2ee/backup', { method: 'PUT', body: backup })
  },

  // --- files ---
  uploadFile(
    channelId: string,
    file: File,
    onProgress?: (fraction: number) => void,
    encrypted = false,
  ): Promise<Attachment> {
    return uploadAttachment(`/channels/${channelId}/uploads`, file, onProgress, encrypted)
  },
  uploadDocImage(docId: string, file: File): Promise<Attachment> {
    return uploadAttachment(`/docs/${docId}/uploads`, file)
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
  setPrefs(body: PrefsUpdate) {
    return request<void>('/prefs', { method: 'PUT', body })
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
  setChannelMode(channelId: string, mode: ChannelNotifyMode) {
    return request<void>(`/channels/${channelId}/prefs`, {
      method: 'PUT',
      body: { mode },
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
  // Native macOS (Tauri) APNs device-token registration.
  registerApns(token: string) {
    return request<void>('/push/apns/register', { method: 'POST', body: { token } })
  },
  unregisterApns(token: string) {
    return request<void>('/push/apns/unregister', { method: 'POST', body: { token } })
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
    input: { title?: string; icon?: string; kind?: 'doc' | 'canvas' | 'board' } = {},
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
    input: {
      title?: string
      icon?: string
      everyone_role?: 'editor' | 'viewer' | 'none' | 'inherit'
    },
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

  // --- Sharpy: AI workspace assistant ---
  sharpy: {
    status: () => request<SharpyStatusResponse>('/sharpy/status'),
    conversations: () => request<SharpyConversation[]>('/sharpy/conversations'),
    createConversation: () =>
      request<SharpyConversation>('/sharpy/conversations', { method: 'POST', body: {} }),
    conversation: (id: string) =>
      request<SharpyConversationDetail>(`/sharpy/conversations/${id}`),
    deleteConversation: (id: string) =>
      request<void>(`/sharpy/conversations/${id}`, { method: 'DELETE' }),
    // Streaming send. No EventSource (needs POST + auth header): raw fetch +
    // ReadableStream reader, split on the SSE frame delimiter (\n\n), tolerate
    // CRLF, multi-event chunks, partial frames, and a trailing unterminated
    // buffer. Returns once the stream ends (done/error frame or connection end).
    send: (
      id: string,
      content: string,
      handlers: {
        onSources?: (sources: SharpySource[]) => void
        onDelta?: (text: string) => void
        onDone?: (message: SharpyMessage) => void
        onError?: (message: string) => void
      },
      signal?: AbortSignal,
    ) => sharpySend(id, content, handlers, signal),
  },

  // --- calendar (Phase 5) ---
  calendar: {
    connections: () =>
      request<CalendarConnectionsResponse>('/calendar/connections'),
    googleConnectUrl: () =>
      request<CalendarConnectUrlResponse>('/calendar/google/connect'),
    disconnect: (id: string) =>
      request<void>(`/calendar/connections/${id}`, { method: 'DELETE' }),
    setCalendarSelected: (id: string, selected: boolean) =>
      request<void>(`/calendar/calendars/${id}`, {
        method: 'PATCH',
        body: { selected },
      }),
    sync: () => request<void>('/calendar/sync', { method: 'POST' }),
    events: (from: string, to: string) => {
      const params = new URLSearchParams({ from, to })
      return request<CalendarEventsResponse>(`/calendar/events?${params.toString()}`)
    },
    meetings: {
      create: (input: {
        title: string
        description?: string
        start_at: string
        end_at: string
        all_day?: boolean
        channel_id?: string | null
        standalone_call_id?: string | null
        attendee_ids?: string[]
        post_card?: boolean
      }) =>
        request<ScheduledMeeting>('/calendar/meetings', {
          method: 'POST',
          body: input,
        }),
      get: (id: string) => request<ScheduledMeeting>(`/calendar/meetings/${id}`),
      update: (
        id: string,
        input: {
          title?: string
          description?: string
          start_at?: string
          end_at?: string
          all_day?: boolean
          attendee_ids?: string[]
        },
      ) =>
        request<ScheduledMeeting>(`/calendar/meetings/${id}`, {
          method: 'PATCH',
          body: input,
        }),
      cancel: (id: string) =>
        request<void>(`/calendar/meetings/${id}`, { method: 'DELETE' }),
      rsvp: (id: string, response: string) =>
        request<void>(`/calendar/meetings/${id}/rsvp`, {
          method: 'POST',
          body: { response },
        }),
    },
  },
}

type SharpyStreamHandlers = {
  onSources?: (sources: SharpySource[]) => void
  onDelta?: (text: string) => void
  onDone?: (message: SharpyMessage) => void
  onError?: (message: string) => void
}

function dispatchSharpyEvent(evt: SharpyStreamEvent, handlers: SharpyStreamHandlers) {
  switch (evt.type) {
    case 'sources':
      handlers.onSources?.(evt.sources)
      break
    case 'delta':
      handlers.onDelta?.(evt.text)
      break
    case 'done':
      handlers.onDone?.(evt.message)
      break
    case 'error':
      handlers.onError?.(evt.message)
      break
  }
}

/**
 * Parse one SSE frame block (one or more `data:` lines) and dispatch its JSON
 * payload. Non-`data:` lines and comments are ignored per the SSE spec.
 */
function handleSharpyFrame(frame: string, handlers: SharpyStreamHandlers) {
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return
  const payload = dataLines.join('\n')
  if (!payload) return
  try {
    dispatchSharpyEvent(JSON.parse(payload) as SharpyStreamEvent, handlers)
  } catch {
    // Ignore malformed frames rather than aborting the whole stream.
  }
}

async function sharpySend(
  id: string,
  content: string,
  handlers: SharpyStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`

  let res: Response
  try {
    res = await fetch(`${apiBase()}/sharpy/conversations/${id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content }),
      signal,
    })
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return
    handlers.onError?.('Could not reach the assistant.')
    return
  }

  if (!res.ok || !res.body) {
    if (res.status === 401 && !hasSessionToken()) {
      clearToken()
      onUnauthorized?.()
    }
    let message = `Request failed (${res.status})`
    try {
      const text = await res.text()
      const data = text ? JSON.parse(text) : undefined
      message = data?.error?.message ?? message
    } catch {
      /* ignore */
    }
    handlers.onError?.(message)
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Split complete frames on the blank-line delimiter (tolerate CRLF).
      for (let sep = indexOfFrameEnd(buffer); sep !== -1; sep = indexOfFrameEnd(buffer)) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + frameEndLength(buffer, sep))
        handleSharpyFrame(frame, handlers)
      }
    }
    // Flush any trailing unterminated frame.
    buffer += decoder.decode()
    if (buffer.trim()) handleSharpyFrame(buffer, handlers)
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') return
    handlers.onError?.('The assistant stream was interrupted.')
  }
}

/** Index of the end of the first complete SSE frame (\n\n or \r\n\r\n), or -1. */
function indexOfFrameEnd(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function frameEndLength(buffer: string, at: number): number {
  return buffer.startsWith('\r\n\r\n', at) ? 4 : 2
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
