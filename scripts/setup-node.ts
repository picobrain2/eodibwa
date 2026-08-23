const store: Record<string, string> = {};

globalThis.localStorage = {
  getItem(key: string) {
    return store[key] ?? null;
  },
  setItem(key: string, value: string) {
    store[key] = value;
  },
  removeItem(key: string) {
    delete store[key];
  },
  clear() {
    for (const key of Object.keys(store)) delete store[key];
  },
  key(index: number) {
    return Object.keys(store)[index] ?? null;
  },
  get length() {
    return Object.keys(store).length;
  },
};
