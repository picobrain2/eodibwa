import { containsHangul } from "./lang";
import type { PopularReview } from "./types";

const cache = new Map<string, string>();
const REVIEW_GAP_MS = 120;

interface BrowserTranslator {
  translate(text: string): Promise<string>;
}

interface BrowserTranslatorStatic {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslator>;
}

let browserTranslator: BrowserTranslator | null | undefined;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

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

async function getBrowserTranslator(): Promise<BrowserTranslator | null> {
  if (browserTranslator !== undefined) return browserTranslator;
  browserTranslator = null;

  const ctor = (self as typeof self & { Translator?: BrowserTranslatorStatic }).Translator;
  if (!ctor) return null;

  try {
    const availability = await ctor.availability({ sourceLanguage: "en", targetLanguage: "ko" });
    if (availability !== "available") return null;
    browserTranslator = await ctor.create({ sourceLanguage: "en", targetLanguage: "ko" });
    return browserTranslator;
  } catch {
    return null;
  }
}

async function translateViaBrowserAI(text: string): Promise<string | undefined> {
  const translator = await getBrowserTranslator();
  if (!translator) return undefined;
  try {
    const translated = cleanTranslated(await translator.translate(text));
    return usableTranslation(text, translated) ? translated : undefined;
  } catch {
    browserTranslator = null;
    return undefined;
  }
}

async function translateViaGoogleClients5(text: string): Promise<string | undefined> {
  const url = new URL("https://clients5.google.com/translate_a/t");
  url.searchParams.set("client", "dict-chrome-ex");
  url.searchParams.set("sl", "en");
  url.searchParams.set("tl", "ko");
  url.searchParams.set("q", text.slice(0, 500));

  const response = await fetch(url);
  if (!response.ok) return undefined;

  const data = await response.json() as string[];
  const translated = cleanTranslated(data[0] ?? "");
  return usableTranslation(text, translated) ? translated : undefined;
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

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return undefined;

  const data = await response.json() as [Array<[string]>, ...unknown[]];
  const translated = cleanTranslated((data[0] ?? []).map((part) => part[0] ?? "").join(""));
  return usableTranslation(text, translated) ? translated : undefined;
}

async function translateViaMyMemory(text: string): Promise<string | undefined> {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text.slice(0, 480));
  url.searchParams.set("langpair", "en|ko");

  const data = await (await fetch(url)).json() as {
    responseStatus?: number;
    responseData?: { translatedText?: string };
  };
  if (data.responseStatus === 429) return undefined;

  const translated = cleanTranslated(data.responseData?.translatedText ?? "");
  return usableTranslation(text, translated) ? translated : undefined;
}

const providers = [
  translateViaBrowserAI,
  translateViaGoogleClients5,
  translateViaGoogle,
  translateViaMyMemory,
];

export async function translateEnToKo(text: string): Promise<string | undefined> {
  const trimmed = text.trim();
  if (!trimmed || containsHangul(trimmed)) return undefined;
  if (cache.has(trimmed)) return cache.get(trimmed);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await delay(400);

    for (const translate of providers) {
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
    if (translatedContent) await delay(REVIEW_GAP_MS);
  }
  return translated;
}

export function reviewsNeedTranslation(reviews: PopularReview[]): boolean {
  return reviews.some((review) => !containsHangul(review.content));
}

export function reviewsTranslated(reviews: PopularReview[]): boolean {
  return reviews.some((review) => Boolean(review.translatedContent));
}
