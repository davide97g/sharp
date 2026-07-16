type SharpSpeechRecognitionResult = {
  isFinal: boolean
  0: { transcript: string }
}

type SharpSpeechRecognitionEvent = Event & {
  resultIndex: number
  results: ArrayLike<SharpSpeechRecognitionResult>
}

type SharpSpeechRecognitionErrorEvent = Event & {
  error: string
}

type SharpSpeechRecognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onresult: ((event: SharpSpeechRecognitionEvent) => void) | null
  onerror: ((event: SharpSpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SharpSpeechRecognitionConstructor = new () => SharpSpeechRecognition

declare global {
  interface Window {
    SpeechRecognition?: SharpSpeechRecognitionConstructor
    webkitSpeechRecognition?: SharpSpeechRecognitionConstructor
  }
}

export type SpeechRecognitionError = 'not-allowed' | 'service-not-allowed'

const RECOVERABLE_ERRORS = new Set(['no-speech', 'aborted', 'network'])
const FATAL_ERRORS = new Set<SpeechRecognitionError>([
  'not-allowed',
  'service-not-allowed',
])

function speechRecognitionConstructor(): SharpSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

export function isSpeechSupported(): boolean {
  return speechRecognitionConstructor() !== null
}

export class PhraseRecognizer {
  private recognition: SharpSpeechRecognition
  private onPhrase: (text: string) => void
  private onError?: (error: SpeechRecognitionError) => void
  private started = false
  private paused = false
  private active = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelayMs = 200

  constructor({
    lang,
    onPhrase,
    onError,
  }: {
    lang?: string
    onPhrase: (text: string) => void
    onError?: (error: SpeechRecognitionError) => void
  }) {
    const Recognition = speechRecognitionConstructor()
    if (!Recognition) throw new Error('Speech recognition is not supported.')

    this.onPhrase = onPhrase
    this.onError = onError
    this.recognition = new Recognition()
    this.recognition.lang = lang ?? navigator.language
    this.recognition.continuous = true
    this.recognition.interimResults = false
    this.recognition.onstart = () => {
      this.active = true
      this.retryDelayMs = 200
    }
    this.recognition.onresult = (event) => {
      if (!this.started || this.paused) return
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (!result?.isFinal) continue
        const text = result[0]?.transcript.trim().slice(0, 500).trim()
        if (text) this.onPhrase(text)
      }
    }
    this.recognition.onerror = (event) => {
      this.active = false
      if (FATAL_ERRORS.has(event.error as SpeechRecognitionError)) {
        this.started = false
        this.paused = false
        this.clearRestart()
        this.onError?.(event.error as SpeechRecognitionError)
        return
      }
      if (RECOVERABLE_ERRORS.has(event.error)) {
        const delay = this.retryDelayMs
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, 2000)
        this.scheduleRestart(delay)
      }
    }
    this.recognition.onend = () => {
      this.active = false
      this.scheduleRestart(this.retryDelayMs)
    }
  }

  start() {
    if (this.started && !this.paused) return
    this.started = true
    this.paused = false
    this.startRecognition()
  }

  stop() {
    this.started = false
    this.paused = false
    this.clearRestart()
    if (!this.active) return
    this.active = false
    try {
      this.recognition.stop()
    } catch {
      // Already stopped by the browser.
    }
  }

  pause() {
    if (!this.started || this.paused) return
    this.paused = true
    this.clearRestart()
    if (!this.active) return
    this.active = false
    try {
      this.recognition.stop()
    } catch {
      // Already stopped by the browser.
    }
  }

  resume() {
    if (!this.started || !this.paused) return
    this.paused = false
    this.scheduleRestart(0)
  }

  private startRecognition() {
    if (!this.started || this.paused || this.active) return
    this.clearRestart()
    this.active = true
    try {
      this.recognition.start()
    } catch {
      this.active = false
      this.scheduleRestart(this.retryDelayMs)
    }
  }

  private scheduleRestart(delayMs: number) {
    if (!this.started || this.paused || this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.startRecognition()
    }, delayMs)
  }

  private clearRestart() {
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = null
  }
}
