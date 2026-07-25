// The single live phrase recognizer for call transcription.
//
// Module state rather than store state because it is a device resource, not data: one
// recognizer per tab, and `stopVoiceRecognizer` must be safe to call from anywhere that
// ends a call (leave, kick, error, socket reconnect) without knowing whether one is
// running. Keeping it out of the store also keeps a non-serializable object out of it.

import type { PhraseRecognizer } from '../speech'

let voiceRecognizer: PhraseRecognizer | null = null

export function currentVoiceRecognizer(): PhraseRecognizer | null {
  return voiceRecognizer
}

export function setVoiceRecognizer(next: PhraseRecognizer | null) {
  voiceRecognizer = next
}

export function stopVoiceRecognizer() {
  voiceRecognizer?.stop()
  voiceRecognizer = null
}
