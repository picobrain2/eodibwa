/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TMDB_KEY?: string;
  readonly VITE_OMDB_KEY?: string;
  readonly VITE_MOTN_KEY?: string;
  readonly VITE_KMDB_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
