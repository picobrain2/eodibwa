import { containsHangul } from "./lang";
import type { PopularReview } from "./types";

const cache = new Map<string, string>();
const MYMEMORY_CONTACT = "eodibwa@users.noreply.github.com";

function cleanTranslated(text: string): string {
  return text
    .replace(/<t\d+\/?>/gi, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function usableTranslation(source: string, translated: string): boolean {
  const trimmed = translated.trim();
  if (!trimmed || trimmed.includes("MYMEMORY WARNING")) return false;
  if (!containsHangul(trimmed)) return false;
  return trimmed.toLowerCase() !== source.trim().toLowerCase();
}

async function translateViaGoogle(text: string): Promise<string | undefined> {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "en");
  url.searchParams.set("tl", "ko");
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", text.slice(0, 500));

  const response = await fetch(url);
  if (!response.ok) return undefined;

  const data = await response.json() as [Array<[string]>, ...unknown[]];
  const translated = cleanTranslated((data[0] ?? []).map((part) => part[0] ?? "").join(""));
  return usableTranslation(text, translated) ? translated : undefined;
}

async function translateViaMyMemory(text: string): Promise<string | undefined> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text.slice(0, 480));
  url.searchParams.set("langpair", "en|ko");
  url.searchParams.set("de", MYMEMORY_CONTACT);

  const data = await (await fetch(url)).json() as {
    responseStatus?: number;
    responseData?: { translatedText?: string };
  };
  if (data.responseStatus === 429) return undefined;

  const translated = cleanTranslated(data.responseData?.translatedText ?? "");
  return usableTranslation(text, translated) ? translated : undefined;
}

export async function translateEnToKo(text: string): Promise<string | undefined> {
  const trimmed = text.trim();
  if (!trimmed || containsHangul(trimmed)) return undefined;
  if (cache.has(trimmed)) return cache.get(trimmed);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 300));

    for (const translate of [translateViaGoogle, translateViaMyMemory]) {
      try {
        const translated = await translate(trimmed);
        if (!translated) continue;
        cache.set(trimmed, translated);
        return translated;
      } catch {
        // try next provider
      }
    }
  }
  return undefined;
}

export async function translateReviews(reviews: PopularReview[]): Promise<PopularReview[]> {
  const translated: PopularReview[] = [];
  for (const review of reviews) {
    if (containsHangul(review.content)) {
      translated.push(review);
      continue;
    }
    const translatedContent = await translateEnToKo(review.content);
    translated.push(translatedContent ? { ...review, translatedContent } : review);
  }
  return translated;
}

export function reviewsNeedTranslation(reviews: PopularReview[]): boolean {
  return reviews.some((review) => !containsHangul(review.content));
}

export function reviewsTranslated(reviews: PopularReview[]): boolean {
  return reviews.some((review) => Boolean(review.translatedContent));
}
