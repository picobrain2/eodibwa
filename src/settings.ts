const KEYS = {
  tmdb: "eodibwa.tmdbAPIKey",
  omdb: "eodibwa.omdbAPIKey",
  motn: "eodibwa.motnAPIKey",
  kmdb: "eodibwa.kmdbAPIKey",
  region: "eodibwa.region",
};

function readBuildEnv(name: "VITE_TMDB_KEY" | "VITE_OMDB_KEY" | "VITE_MOTN_KEY" | "VITE_KMDB_KEY"): string {
  const fromVite = import.meta.env?.[name];
  if (typeof fromVite === "string" && fromVite.length > 0) return fromVite;
  const proc = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process;
  const fromNode = proc?.env?.[name];
  return typeof fromNode === "string" ? fromNode : "";
}

const DEFAULT_TMDB = readBuildEnv("VITE_TMDB_KEY");
const DEFAULT_OMDB = readBuildEnv("VITE_OMDB_KEY");
const DEFAULT_MOTN = readBuildEnv("VITE_MOTN_KEY");
const DEFAULT_KMDB = readBuildEnv("VITE_KMDB_KEY");

export const settings = {
  get tmdb(): string {
    const stored = localStorage.getItem(KEYS.tmdb);
    return stored?.trim() ? stored.trim() : DEFAULT_TMDB;
  },
  set tmdb(value: string) {
    localStorage.setItem(KEYS.tmdb, value.trim());
  },
  get omdb(): string {
    const stored = localStorage.getItem(KEYS.omdb);
    return stored?.trim() ? stored.trim() : DEFAULT_OMDB;
  },
  set omdb(value: string) {
    localStorage.setItem(KEYS.omdb, value.trim());
  },
  get motn(): string {
    const stored = localStorage.getItem(KEYS.motn);
    return stored?.trim() ? stored.trim() : DEFAULT_MOTN;
  },
  set motn(value: string) {
    localStorage.setItem(KEYS.motn, value.trim());
  },
  get kmdb(): string {
    const stored = localStorage.getItem(KEYS.kmdb);
    return stored?.trim() ? stored.trim() : DEFAULT_KMDB;
  },
  set kmdb(value: string) {
    localStorage.setItem(KEYS.kmdb, value.trim());
  },
  get region(): string {
    return localStorage.getItem(KEYS.region) ?? "KR";
  },
  set region(value: string) {
    localStorage.setItem(KEYS.region, value);
  },
  get hasTMDB(): boolean {
    return this.tmdb.length > 0;
  },
  get hasOMDb(): boolean {
    return this.omdb.length > 0;
  },
  get hasMOTN(): boolean {
    return this.motn.length > 0;
  },
  get hasKMDB(): boolean {
    return this.kmdb.length > 0;
  },
};
