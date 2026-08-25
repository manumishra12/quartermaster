/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AGENT_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
