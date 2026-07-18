/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __BUILD_ID__: string

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_TLDRAW_LICENSE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
