const HANGUL = /[\uAC00-\uD7A3]/;

export function containsHangul(text: string): boolean {
  return HANGUL.test(text);
}

export function compact(text: string): string {
  return [...text.toLowerCase()].filter((ch) => /[0-9a-z\uAC00-\uD7A3]/i.test(ch)).join("");
}

export function collapsed(text: string): string {
  return text
    .replace(/[-_·•./']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pickKorean(candidates: string[]): string {
  const cleaned = candidates.map((item) => item.trim()).filter(Boolean);
  return cleaned.find(containsHangul) ?? cleaned[0] ?? "";
}

export function pickEnglish(candidates: string[]): string {
  const cleaned = candidates.map((item) => item.trim()).filter(Boolean);
  return cleaned.find((item) => !containsHangul(item)) ?? "";
}

export function searchVariants(raw: string): string[] {
  const spaced = collapsed(raw);
  const squeezed = compact(spaced);
  const scripted = spacedAtScriptBoundaries(raw);
  const variants: string[] = [];
  for (const value of [spaced, squeezed, scripted]) {
    if (value.length >= 2 && !variants.includes(value)) variants.push(value);
  }
  return variants;
}

export function hangulSpaceVariants(raw: string): string[] {
  const squeezed = compact(raw);
  if (squeezed.length < 3 || squeezed.length > 8) return [];
  if (![...squeezed].every((ch) => HANGUL.test(ch))) return [];
  if (/\s/.test(collapsed(raw))) return [];
  const chars = [...squeezed];
  return chars.slice(1).map((_, index) => chars.slice(0, index + 1).join("") + " " + chars.slice(index + 1).join(""));
}

export function spacedAtScriptBoundaries(text: string): string {
  const kind = (ch: string) => {
    if (HANGUL.test(ch)) return 1;
    if (/[a-zA-Z]/.test(ch)) return 2;
    if (/[0-9]/.test(ch)) return 3;
    return 0;
  };
  let output = "";
  let previous = "";
  for (const ch of collapsed(text)) {
    if (previous && kind(previous) && kind(ch) && kind(previous) !== kind(ch)) output += " ";
    output += ch;
    previous = ch;
  }
  return collapsed(output);
}

export function relevance(titles: string[], query: string): number {
  const q = compact(query);
  if (!q) return 0;
  const list = titles.map(compact).filter(Boolean);
  if (list.includes(q)) return 100;
  if (list.some((title) => title.startsWith(q) || q.startsWith(title))) return 80;
  if (list.some((title) => title.includes(q) || q.includes(title))) return 60;
  return 10;
}

export function isStrongMatch(titles: string[], query: string): boolean {
  return relevance(titles, query) >= 80;
}
