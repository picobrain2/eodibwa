import { containsHangul } from "./lang";
import type { PopularReview } from "./types";

const cache = new Map<string, string>();

function cleanTranslated(text: string): string {
  return text
    .replace(/<t\d+\/?>/gi, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export async function translateEnToKo(text: string): Promise<string | undefined> {
  const trimmed = text.trim();
  if (!trimmed || containsHangul(trimmed)) return undefined;
  if (cache.has(trimmed)) return cache.get(trimmed);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 400 * attempt));

    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", trimmed.slice(0, 480));
    url.searchParams.set("langpair", "en|ko");

    try {
      const data = await (await fetch(url)).json() as {
        responseStatus?: number;
        responseData?: { translatedText?: string };
      };
      if (data.responseStatus !== 200) continue;
      const translated = cleanTranslated(data.responseData?.translatedText ?? "");
      if (!translated || translated.toLowerCase() === trimmed.toLowerCase()) continue;
      cache.set(trimmed, translated);
      return translated;
    } catch {
      // retry
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
