const HANGUL = /[\uAC00-\uD7A3]/;

export function containsHangul(text: string): boolean {
  return HANGUL.test(text);
}

export function isLatinOnly(text: string): boolean {
  const squeezed = compact(text);
  return squeezed.length > 0 && ![...squeezed].some((ch) => HANGUL.test(ch));
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

const GENERIC_CREDIT_ROLES = /^(self|himself|herself|themselves|guest|guest self|guest star|n\/a|none|-)$/i;

export function formatCreditRole(character?: string): string {
  const trimmed = character?.trim();
  if (!trimmed || GENERIC_CREDIT_ROLES.test(trimmed)) return "출연";
  return trimmed;
}

const CREW_ROLE_LABELS: Record<string, string> = {
  Director: "연출",
  Creator: "기획",
  "Co-Director": "공동연출",
  Producer: "프로듀서",
  "Executive Producer": "프로듀서",
  "Co-Executive Producer": "프로듀서",
  Writer: "각본",
  Screenplay: "각본",
  Story: "스토리",
  Teleplay: "각본",
  Author: "원작",
};

export function formatCrewRole(job?: string): string {
  const trimmed = job?.trim();
  if (!trimmed) return "제작";
  return CREW_ROLE_LABELS[trimmed] ?? trimmed;
}

export function isCrewFocusedDepartment(department?: string): boolean {
  return department === "Directing" || department === "Production" || department === "Writing" || department === "Creator";
}

const DEPARTMENT_LABELS: Record<string, string> = {
  Acting: "배우",
  Directing: "연출",
  Production: "제작",
  Writing: "각본",
  Creator: "기획",
  Sound: "음악",
  Camera: "촬영",
  Editing: "편집",
  Art: "미술",
};

export function formatDepartment(department?: string): string | undefined {
  if (!department) return undefined;
  return DEPARTMENT_LABELS[department] ?? department;
}

export function classifyCreditFilter(role?: string): "direct" | "create" | "act" | "write" | undefined {
  if (!role) return undefined;
  if (role === "연출") return "direct";
  if (role === "기획" || role === "프로듀서") return "create";
  if (role === "각본" || role === "스토리" || role === "원작") return "write";
  return "act";
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

const HANGUL_DAY_PREFIXES: Record<string, string> = {
  월요: "월요일",
  화요: "화요일",
  수요: "수요일",
  목요: "목요일",
  금요: "금요일",
  토요: "토요일",
  일요: "일요일",
};

/** "놀라운 토요" → "놀라운 토요일" 등 미완성 마지막 단어 보완 */
export function hangulPartialTitleVariants(raw: string): string[] {
  const spaced = collapsed(raw);
  const parts = spaced.split(" ");
  if (parts.length < 2) return [];
  const last = parts[parts.length - 1];
  if (last.length < 2) return [];
  const completion = HANGUL_DAY_PREFIXES[last];
  if (!completion || last === completion) return [];
  const variant = [...parts.slice(0, -1), completion].join(" ");
  return variant === spaced ? [] : [variant];
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
  if (q.length >= 3 && list.some((title) => title.includes(q) || q.includes(title))) return 60;
  return 10;
}

export function isStrongMatch(titles: string[], query: string): boolean {
  return relevance(titles, query) >= 80;
}
