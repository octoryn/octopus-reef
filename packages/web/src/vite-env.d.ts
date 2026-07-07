/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Reef daemon; empty = same-origin (dev proxy / Docker). */
  readonly VITE_REEF_SERVER?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
