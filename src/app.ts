import { enrichFilmographyProviders, fetchDetail, fetchPersonDetail, enrichDetail, fetchPopularReviews, isKnownStageNameQuery, isPersonSearchTitleNoise, mergeSearchResults, providerLink, refineSearchWithImdb, resolvePersonIDs, searchPersonHits, searchPersonKnownHits, searchTitleHits, sortFilmographyHits, sortPersonFilmographyHits, watchaSearchURL } from "./api";
import { motnCacheFresh } from "./motn";
import { clearRecommendBundleCache, getRecommendBundle, providersForGenre, recommendBundleFresh, type RecommendBundle } from "./recommend-data";
import { loadRecommendations as fetchRecommendations, refreshProviderGroup, invalidateRecommendChart, RECOMMEND_GENRES, regionProviderIDs, type RecommendProvider } from "./recommend";
import { invalidateNowPlaying, loadNowPlaying } from "./theaters";
import { classifyCreditFilter, compact, containsHangul } from "./lang";
import { reviewsNeedTranslation, reviewsTranslated, translateReviews } from "./translate";
import { settings } from "./settings";
import { OFFER_LABEL, REGIONS, kindLabel, posterURL, regionName, runtimeText, type FilmographySort, type MediaFilter, type PersonDetail, type SearchHit, type TitleDetail, type WatchOffer } from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
let query = "";
let filter: MediaFilter = "all";
let filmographySort: FilmographySort = "default";
let hits: SearchHit[] = [];
let selected: SearchHit | undefined;
let detail: TitleDetail | undefined;
let personDetails: PersonDetail[] = [];
let searching = false;
let loadingPersonSearch = false;
let loadingDetail = false;
let loadingPersonDetail = false;
let error = "";
let debounce: number | undefined;
let searchGeneration = 0;
let recommendTrending: SearchHit[] = [];
let recommendProviders: RecommendProvider[] = [];
let selectedGenreID = 0;
let selectedProviderID = 8;
let loadingRecommend = false;
let loadingProviderRecommend = false;
let recommendLoaded = false;
let nowPlayingIDs = new Set<number>();
let providerRecommendGeneration = 0;
let recommendError = "";
let recommendLoadScheduled = false;
let recommendFromBundle = false;
let showRecommendPage = false;
let showDetailPage = false;
let suppressHistory = false;

type MobileView = "main" | "recommend" | "detail";

function isMobileLayout(): boolean {
  return window.matchMedia("(max-width: 860px)").matches;
}

function emptyDetailHTML(): string {
  if (isMobileLayout()) {
    return `<div class="empty">검색하거나 「오늘 뭐 볼까」에서<br>작품을 골라 보세요.</div>`;
  }
  return `<div class="empty">왼쪽에서 작품을 고르거나<br>「오늘 뭐 볼까」 추천을 눌러 보세요.</div>`;
}

function recommendEntryHTML(): string {
  return `
    <div class="recommend-entry">
      <button class="primary recommend-open" type="button" id="open-recommend">오늘 뭐 볼까</button>
      <p class="hint">OTT별 급상승 · 이번 주 인기 작품</p>
    </div>`;
}

function allRecommendHits(): SearchHit[] {
  return recommendProviders.flatMap((group) => group.hits);
}

function findHit(id: string): SearchHit | undefined {
  return hits.find((hit) => hit.id === id)
    ?? recommendTrending.find((hit) => hit.id === id)
    ?? allRecommendHits().find((hit) => hit.id === id);
}

let searchInput!: HTMLInputElement;
let resultsEl!: HTMLDivElement;
let filtersEl!: HTMLDivElement;
let filmographySortEl!: HTMLSelectElement;
let filmographySortWrapEl!: HTMLLabelElement;
let detailEl!: HTMLElement;
let recommendHost!: HTMLDivElement;
let detailHost!: HTMLDivElement;

function syncMobileViewFromHistory(state: { mobile?: MobileView } | null): void {
  const view = state?.mobile ?? "main";
  showDetailPage = view === "detail";
  showRecommendPage = view === "recommend";
}

function pushMobileView(view: MobileView): void {
  if (!isMobileLayout() || suppressHistory) return;
  history.pushState({ mobile: view }, "");
}

function openRecommendPage(): void {
  showRecommendPage = true;
  ensureRecommendationsLoaded();
  pushMobileView("recommend");
  updateRecommendPage();
}

function openDetailPage(): void {
  showDetailPage = true;
  pushMobileView("detail");
  updateDetail();
}

function closeRecommendPage(useHistory = true): void {
  if (useHistory && isMobileLayout() && history.state?.mobile === "recommend") {
    suppressHistory = true;
    history.back();
    suppressHistory = false;
    return;
  }
  showRecommendPage = false;
  updateRecommendPage();
}

function closeDetailPage(useHistory = true): void {
  if (useHistory && isMobileLayout() && history.state?.mobile === "detail") {
    suppressHistory = true;
    history.back();
    suppressHistory = false;
    return;
  }
  showDetailPage = false;
  updateDetail();
}

function goToMainHome(): void {
  window.clearTimeout(debounce);
  query = "";
  hits = [];
  selected = undefined;
  detail = undefined;
  personDetails = [];
  detailError = "";
  loadingDetail = false;
  loadingPersonDetail = false;
  loadingReviews = false;
  searching = false;
  error = "";
  searchGeneration += 1;
  detailGeneration += 1;
  personDetailGeneration += 1;

  if (isMobileLayout()) {
    showDetailPage = false;
    showRecommendPage = false;
    recommendHost.innerHTML = "";
    detailHost.innerHTML = "";
    suppressHistory = true;
    history.replaceState({ mobile: "main" as MobileView }, "");
    suppressHistory = false;
    updateRecommendPage();
  }

  if (searchInput) searchInput.value = "";
  filter = "all";
  filmographySort = "default";
  selectedProviderID = 8;
  ensureSelectedProvider();
  updateFilmographyControls();
  updateResults();
  updateDetail();
  searchInput?.focus();
}

function bindHomeButtons(root: ParentNode = app): void {
  root.querySelectorAll<HTMLButtonElement>(".go-home").forEach((button) => {
    button.onclick = () => goToMainHome();
  });
}

function activeGenreName(): string {
  return RECOMMEND_GENRES.find((genre) => genre.id === selectedGenreID)?.name ?? "전체";
}

const PROVIDER_FALLBACK_NAMES: Record<number, string> = {
  8: "Netflix",
  1883: "TVING",
  356: "Wavve",
  97: "Watcha",
  1881: "Coupang Play",
  337: "Disney+",
  119: "Prime Video",
  350: "Apple TV+",
  384: "HBO Max",
  531: "Paramount+",
  84: "U-NEXT",
  39: "Now TV",
};

function ensureSelectedProvider(): void {
  const ids = regionProviderIDs(settings.region);
  if (!ids.includes(selectedProviderID)) {
    selectedProviderID = ids.includes(8) ? 8 : ids[0];
  }
}

function providerTabOptions(): { id: number; name: string; logo?: string }[] {
  const ids = regionProviderIDs(settings.region);
  const byID = new Map(recommendProviders.map((group) => [group.id, group]));
  return ids.map((id) => {
    const loaded = byID.get(id);
    return {
      id,
      name: loaded?.name ?? PROVIDER_FALLBACK_NAMES[id] ?? `OTT ${id}`,
      logo: loaded?.logo,
    };
  });
}

function activeProviderName(): string {
  return providerTabOptions().find((item) => item.id === selectedProviderID)?.name ?? "OTT";
}

function ensureRecommendationsLoaded(): void {
  if (recommendLoaded || loadingRecommend || recommendLoadScheduled || !settings.hasTMDB) return;
  recommendLoadScheduled = true;
  void loadRecommendations();
}

function visibleRecommendProviders(): RecommendProvider[] {
  const match = recommendProviders.filter((group) => group.id === selectedProviderID);
  if (match.length) return match;
  const meta = providerTabOptions().find((item) => item.id === selectedProviderID);
  if (!meta) return [];
  return [{ id: meta.id, name: meta.name, logo: meta.logo, hits: [] }];
}

function ottTabsHTML(): string {
  return `
    <div class="ott-tabs">
      ${providerTabOptions().map((provider) => `
        <button
          class="ott-tab ${provider.id === selectedProviderID ? "active" : ""}"
          type="button"
          data-provider="${provider.id}"
          ${loadingProviderRecommend && provider.id !== selectedProviderID ? "disabled" : ""}
        >
          ${provider.logo ? `<img alt="" src="${posterURL(provider.logo, "w92") ?? ""}" />` : ""}
          <span>${escapeHTML(provider.name)}</span>
        </button>
      `).join("")}
    </div>`;
}

function ottGroupHTML(group: RecommendProvider, hideHead = false): string {
  return `
    <div class="ott-group">
      ${hideHead ? "" : `
      <div class="ott-group-head">
        ${group.logo ? `<img alt="" src="${posterURL(group.logo, "w92") ?? ""}" />` : ""}
        <span>${escapeHTML(group.name)}</span>
      </div>`}
      ${group.hits.map((hit) => hitButton(hit, selected?.id)).join("")}
    </div>`;
}

function isInTheaters(hit: SearchHit): boolean {
  return hit.kind === "movie" && nowPlayingIDs.has(hit.tmdbID);
}

function shouldDeferDetailForPersonSearch(hit: SearchHit | undefined, query: string): boolean {
  if (!hit || hit.matchedPerson) return false;
  if (isKnownStageNameQuery(query)) return true;
  if (isPersonSearchTitleNoise(hit, query, { forPersonSearch: true })) return true;
  if (containsHangul(query) && compact(query).length <= 4) return true;
  return false;
}

function prioritizeNowPlaying(hits: SearchHit[], playing = nowPlayingIDs): SearchHit[] {
  if (!playing.size) return hits;
  const inTheaters: SearchHit[] = [];
  const rest: SearchHit[] = [];
  for (const hit of hits) {
    if (hit.kind === "movie" && playing.has(hit.tmdbID)) inTheaters.push(hit);
    else rest.push(hit);
  }
  return [...inTheaters, ...rest];
}

function theaterBadgeHTML(): string {
  return `<span class="theater-badge">극장 상영중</span>`;
}

function hitRatingHTML(hit: SearchHit): string {
  if (!hit.matchedPerson || hit.voteAverage <= 0) return "";
  const votes = hit.voteCount;
  const hint = votes > 0 ? `TMDB ${hit.voteAverage.toFixed(1)} · ${votes.toLocaleString()}명` : `TMDB ${hit.voteAverage.toFixed(1)}`;
  return `<span class="hit-rating" title="${escapeHTML(hint)}">★ ${hit.voteAverage.toFixed(1)}</span>`;
}

function hitProvidersHTML(hit: SearchHit): string {
  const providers = hit.streamingProviders?.length
    ? hit.streamingProviders
    : hit.providerLogo || hit.providerName
      ? [{ providerID: hit.providerID ?? 0, name: hit.providerName ?? "", logo: hit.providerLogo }]
      : [];
  if (!providers.length) return "";
  return `<span class="hit-providers">${providers.map((provider) => (
    provider.logo
      ? `<img class="hit-provider" alt="" title="${escapeHTML(provider.name)}" src="${posterURL(provider.logo, "w92") ?? ""}" loading="lazy" decoding="async" />`
      : `<span class="hit-provider-name">${escapeHTML(provider.name)}</span>`
  )).join("")}</span>`;
}

function hitButton(hit: SearchHit, selectedId?: string): string {
  const personMeta = hit.matchedPerson
    ? `${hit.matchedPerson}${hit.matchedRole ? ` · ${hit.matchedRole}` : ""}`
    : "";
  const meta = [personMeta, hit.titleEN !== hit.titleKO ? hit.titleEN : "", kindLabel(hit.kind), hit.year].filter(Boolean).join(" · ");
  const provider = hitProvidersHTML(hit);
  const rating = hitRatingHTML(hit);
  const theater = isInTheaters(hit) ? theaterBadgeHTML() : "";
  return `
    <button class="hit ${selectedId === hit.id ? "selected" : ""}" data-id="${hit.id}">
      <img alt="" src="${posterURL(hit.posterPath) ?? ""}" loading="lazy" decoding="async" />
      <span>
        <b>${escapeHTML(hit.titleKO || hit.titleEN)}${rating}${theater}</b>
        <small>${escapeHTML(meta)}</small>
      </span>
      ${provider}
    </button>`;
}

function bindHits(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selected = findHit(button.dataset.id ?? "");
      updateResults();
      if (isMobileLayout()) {
        if (showRecommendPage) {
          showRecommendPage = false;
          updateRecommendPage();
        }
        openDetailPage();
      }
      void loadSelected();
    });
  });
}

const FILTER_LABELS: Record<MediaFilter, string> = {
  all: "전체",
  movie: "영화",
  tv: "시리즈",
  direct: "연출",
  create: "기획",
  act: "출연",
  write: "각본",
};

function hasPersonFilmography(list: SearchHit[] = hits): boolean {
  return list.some((hit) => hit.matchedPerson);
}

function availableFilters(list: SearchHit[] = hits): MediaFilter[] {
  const options: MediaFilter[] = ["all", "tv", "movie"];
  if (!hasPersonFilmography(list)) return options;
  const roles = new Set(
    list
      .filter((hit) => hit.matchedPerson)
      .map((hit) => classifyCreditFilter(hit.matchedRole))
      .filter((role): role is Exclude<typeof role, undefined> => Boolean(role)),
  );
  if (roles.has("direct")) options.push("direct");
  if (roles.has("create")) options.push("create");
  if (roles.has("act")) options.push("act");
  if (roles.has("write")) options.push("write");
  return options;
}

function updateFilterButtons(): void {
  if (!filtersEl) return;
  const options = availableFilters();
  if (!options.includes(filter)) filter = "all";
  filtersEl.innerHTML = options.map((item) => `
    <button data-filter="${item}" class="${filter === item ? "active" : ""}">${FILTER_LABELS[item]}</button>
  `).join("");
  filtersEl.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter as MediaFilter;
      updateFilmographyControls();
      updateResults();
    });
  });
}

function updateFilmographySortControl(): void {
  if (!filmographySortWrapEl || !filmographySortEl) return;
  const show = hasPersonFilmography();
  filmographySortWrapEl.hidden = !show;
  if (!show) {
    filmographySortEl.value = "default";
    return;
  }
  filmographySortEl.value = filmographySort;
}

function updateFilmographyControls(): void {
  updateFilterButtons();
  updateFilmographySortControl();
}

function filteredHits(): SearchHit[] {
  let list = hits;
  if (filter === "movie" || filter === "tv") list = hits.filter((hit) => hit.kind === filter);
  else if (filter !== "all") list = hits.filter((hit) => classifyCreditFilter(hit.matchedRole) === filter);
  if (!hasPersonFilmography(list)) return list;
  return sortFilmographyHits(list, filmographySort);
}

let mounted = false;

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function personSearchButton(name: string, className = "person-search"): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return `<button type="button" class="${className}" data-person-search="${escapeHTML(trimmed)}">${escapeHTML(trimmed)}</button>`;
}

function directorLinksHTML(director: string): string {
  const names = director.split(",").map((part) => part.trim()).filter(Boolean);
  if (!names.length) return "";
  return `<p>감독/제작 ${names.map((name) => personSearchButton(name, "person-search linkish")).join(" · ")}</p>`;
}

function searchForPerson(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  window.clearTimeout(debounce);
  query = trimmed;
  if (searchInput) searchInput.value = trimmed;

  if (isMobileLayout()) {
    showDetailPage = false;
    showRecommendPage = false;
    detailHost.innerHTML = "";
    suppressHistory = true;
    history.replaceState({ mobile: "main" as MobileView }, "");
    suppressHistory = false;
    updateRecommendPage();
  }

  void runSearch(trimmed);
  searchInput?.focus();
}

function bindPersonSearch(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-person-search]").forEach((button) => {
    button.onclick = () => searchForPerson(button.dataset.personSearch ?? "");
  });
}

export function render(): void {
  if (!mounted) mount();
  updateResults();
  updateDetail();
  updateRecommendPage();
}

function mount(): void {
  mounted = true;
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="search-box">
          <button type="button" class="app-title go-home" id="go-home">어디봐</button>
          <input id="q" placeholder="제목 · 출연진 · 감독 (한글/영어)" />
          <div class="filters" id="filters"></div>
          <label class="filmography-sort" id="filmography-sort-wrap" hidden>
            <span>정렬</span>
            <select id="filmography-sort">
              <option value="default">추천순</option>
              <option value="title">제목순 (ㄱ~ㅎ)</option>
              <option value="rating">평점순</option>
              <option value="year">출시년도순</option>
            </select>
          </label>
        </div>
        <div class="results"></div>
      </aside>
      <main class="detail"></main>
    </div>
    <div id="recommend-host"></div>
    <div id="detail-host"></div>
  `;

  searchInput = app.querySelector<HTMLInputElement>("#q")!;
  resultsEl = app.querySelector<HTMLDivElement>(".results")!;
  filtersEl = app.querySelector<HTMLDivElement>("#filters")!;
  filmographySortWrapEl = app.querySelector<HTMLLabelElement>("#filmography-sort-wrap")!;
  filmographySortEl = app.querySelector<HTMLSelectElement>("#filmography-sort")!;
  detailEl = app.querySelector<HTMLElement>(".detail")!;
  recommendHost = app.querySelector<HTMLDivElement>("#recommend-host")!;
  detailHost = app.querySelector<HTMLDivElement>("#detail-host")!;

  if (isMobileLayout()) history.replaceState({ mobile: "main" as MobileView }, "");

  searchInput.value = query;
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void runSearch(query), 280);
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void runSearch(searchInput.value);
  });

  bindHomeButtons();

  filmographySortEl.addEventListener("change", () => {
    filmographySort = filmographySortEl.value as FilmographySort;
    updateResults();
  });

  updateFilmographyControls();

  window.addEventListener("resize", () => {
    if (!isMobileLayout()) {
      showRecommendPage = false;
      showDetailPage = false;
      recommendHost.innerHTML = "";
      detailHost.innerHTML = "";
      updateDetail();
    } else if (!history.state?.mobile) {
      history.replaceState({ mobile: "main" as MobileView }, "");
    }
    updateResults();
    updateRecommendPage();
  });

  window.addEventListener("popstate", (event) => {
    if (!isMobileLayout()) return;
    syncMobileViewFromHistory(event.state as { mobile?: MobileView } | null);
    updateDetail();
    updateRecommendPage();
  });
}

function recommendHintText(): string {
  if (recommendFromBundle) {
    return "Netflix·Disney+ MOTN Top 10과 TVING·Wavve 등 OTT 추천을 서버 JSON으로 제공합니다. KR 12시간 · 해외 매일 갱신됩니다.";
  }
  if (settings.hasMOTN) {
    if (motnCacheFresh(settings.region)) {
      const cacheHours = settings.region === "KR" ? "12시간" : "24시간";
      return `Netflix·Disney+ 등은 플랫폼 공식 Top 10(브라우저 ${cacheHours} 캐시), TVING·Wavve·Watcha·쿠팡플레이는 TMDB 급상승+최근 한국 인기작입니다.`;
    }
    if (loadingRecommend || loadingProviderRecommend) {
      return "Netflix·Disney+ 공식 Top 10을 불러오는 중…";
    }
    return "Netflix·Disney+ Top 10을 불러오지 못해 TMDB 급상승으로 표시합니다.";
  }
  return "TVING·Wavve·Watcha·쿠팡플레이는 TMDB 급상승+최근 한국 인기작, Netflix 등은 Movie of the Night 공식 Top 10을 사용합니다.";
}

function applyRecommendBundle(bundle: RecommendBundle, genreID = selectedGenreID): void {
  recommendTrending = bundle.trending;
  recommendProviders = providersForGenre(bundle, genreID);
  recommendFromBundle = true;
  recommendLoaded = true;
  ensureSelectedProvider();
  if (!recommendProviders.length) {
    recommendError = "OTT 추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
  } else {
    recommendError = "";
  }
}

function recommendHTML(options?: { hideTitle?: boolean }): string {
  if (!settings.hasTMDB) {
    return `<div class="empty">추천을 불러올 수 없습니다.</div>`;
  }
  if (loadingRecommend) return `<div class="loading">추천 불러오는 중…</div>`;
  const genreLabel = selectedGenreID === 0 ? "" : ` · ${escapeHTML(activeGenreName())}`;
  const motnHint = recommendHintText();
  return `
    <div class="recommend">
      ${options?.hideTitle ? "" : `<h2 class="recommend-title">오늘 뭐 볼까</h2>`}
      <h3 class="recommend-section">${escapeHTML(regionName(settings.region))} ${escapeHTML(activeProviderName())} 급상승${genreLabel}</h3>
      <div class="genre-tabs">
        ${RECOMMEND_GENRES.map((genre) => `
          <button class="genre-tab ${genre.id === selectedGenreID ? "active" : ""}" data-genre="${genre.id}" ${loadingProviderRecommend && genre.id !== selectedGenreID ? "disabled" : ""}>${escapeHTML(genre.name)}</button>
        `).join("")}
      </div>
      ${ottTabsHTML()}
      ${loadingProviderRecommend ? `<div class="loading inline">순위 불러오는 중…</div>` : ""}
      ${recommendError ? `<div class="empty inline">${escapeHTML(recommendError)}</div>` : ""}
      <p class="recommend-hint">${escapeHTML(motnHint)}</p>
      ${visibleRecommendProviders().map((group) => ottGroupHTML(group, true)).join("")}
      ${!loadingProviderRecommend && !visibleRecommendProviders().length && !recommendError ? `<div class="empty inline">이 OTT·장르에 해당하는 작품이 없습니다.</div>` : ""}
      <h3 class="recommend-section">이번 주 인기 <small>TMDB 주간·일간 급상승</small></h3>
      ${recommendTrending.map((hit) => hitButton(hit, selected?.id)).join("")}
    </div>`;
}

function bindRecommendControls(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-genre]").forEach((button) => {
    if (button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => {
      const next = Number(button.dataset.genre);
      if (next === selectedGenreID) return;
      selectedGenreID = next;
      updateResults();
      updateRecommendPage();
      void reloadProviderRecommendations();
    });
  });
}

function bindProviderControls(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-provider]").forEach((button) => {
    if (button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => {
      const next = Number(button.dataset.provider);
      if (next === selectedProviderID) return;
      selectedProviderID = next;
      updateResults();
      updateRecommendPage();
      if (selectedGenreID !== 0 && !recommendFromBundle) {
        void reloadProviderRecommendations();
      }
    });
  });
}

function bindRecommendUI(root: ParentNode): void {
  bindHits(root);
  bindRecommendControls(root);
  bindProviderControls(root);
}

function updateResults(): void {
  const list = filteredHits();
  const showRecommend = !query.trim() && !hits.length && !searching;
  if (showRecommend) ensureRecommendationsLoaded();
  const mobile = isMobileLayout();
  resultsEl.innerHTML = `
    ${searching && !hits.length ? `<div class="loading">검색 중…</div>` : ""}
    ${loadingPersonSearch ? `<div class="loading inline">출연작 불러오는 중…</div>` : ""}
    ${error && !hits.length && query.trim() ? `<div class="empty">${escapeHTML(error)}</div>` : ""}
    ${showRecommend && mobile ? recommendEntryHTML() : ""}
    ${showRecommend && !mobile ? recommendHTML() : ""}
    ${list.map((hit) => hitButton(hit, selected?.id)).join("")}
  `;
  bindHits(resultsEl);
  bindRecommendControls(resultsEl);
  bindProviderControls(resultsEl);
  resultsEl.querySelector("#open-recommend")?.addEventListener("click", () => {
    openRecommendPage();
  });
  updateFilmographySortControl();
}

function updateRecommendPage(): void {
  if (!mounted) return;
  if (!isMobileLayout() || !showRecommendPage) {
    recommendHost.innerHTML = "";
    return;
  }
  recommendHost.innerHTML = `
    <div class="recommend-page">
      <header class="recommend-page-head">
        <button class="ghost" type="button" id="close-recommend">← 돌아가기</button>
        <button class="ghost go-home" type="button">어디봐</button>
        <h2>오늘 뭐 볼까</h2>
      </header>
      <div class="recommend-page-body">${recommendHTML({ hideTitle: true })}</div>
    </div>
  `;
  recommendHost.querySelector("#close-recommend")?.addEventListener("click", () => {
    closeRecommendPage();
  });
  bindHomeButtons(recommendHost);
  const body = recommendHost.querySelector(".recommend-page-body");
  if (!body) return;
  bindRecommendUI(body);
}

function bindDetailControls(root: ParentNode): void {
  root.querySelector("#region")?.addEventListener("change", (event) => {
    const next = (event.target as HTMLSelectElement).value;
    if (next === settings.region) return;
    settings.region = next;
    invalidateNowPlaying();
    invalidateRecommendChart();
    clearRecommendBundleCache();
    recommendLoaded = false;
    recommendFromBundle = false;
    selectedProviderID = 8;
    ensureSelectedProvider();
    void refreshNowPlaying().then(() => {
      if (detail?.kind === "movie") {
        detail.inTheaters = nowPlayingIDs.has(detail.tmdbID);
      }
      updateDetail();
    });
    void loadRecommendations();
    updateDetail();
  });
  bindPersonSearch(root);
}

function updateDetail(): void {
  if (isMobileLayout()) {
    detailEl.innerHTML = "";
    updateDetailPage();
    return;
  }
  detailHost.innerHTML = "";
  if (detail) {
    detailEl.innerHTML = detailHTML();
    bindDetailControls(detailEl);
    return;
  }
  if (loadingDetail || detailError) {
    detailEl.innerHTML = detailHTML();
    bindDetailControls(detailEl);
    return;
  }
  if (personDetails.length || loadingPersonDetail) {
    detailEl.innerHTML = personDetailHTML();
    return;
  }
  detailEl.innerHTML = detailHTML();
  bindDetailControls(detailEl);
}

function formatPersonBirthday(value?: string): string | undefined {
  if (!value) return undefined;
  return value.length >= 10 ? value.slice(0, 10) : value;
}

function personDetailCardHTML(person: PersonDetail): string {
  const primary = person.nameKO || person.nameEN;
  const secondary = person.nameEN && person.nameEN !== primary ? person.nameEN : "";
  const meta = [person.department, formatPersonBirthday(person.birthday), person.placeOfBirth].filter(Boolean);
  return `
    <article class="person-card">
      <div class="header person-header">
        <img class="person-photo" alt="" src="${posterURL(person.profilePath, "w500") ?? ""}" loading="lazy" decoding="async" />
        <div>
          <h1>${escapeHTML(primary)}</h1>
          ${secondary ? `<p>${escapeHTML(secondary)}</p>` : ""}
          <div class="pills">${meta.map((item) => `<span>${escapeHTML(String(item))}</span>`).join("")}</div>
        </div>
      </div>
      ${person.biography ? `<section class="section"><h2>소개</h2><p>${escapeHTML(person.biography)}</p></section>` : ""}
      <section class="section links">
        <a href="${person.tmdbURL}" target="_blank" rel="noreferrer">TMDB에서 열기</a>
      </section>
    </article>
  `;
}

function personDetailHTML(): string {
  if (loadingPersonDetail && !personDetails.length) {
    return `<div class="loading">인물 정보를 불러오는 중…</div>`;
  }
  if (!personDetails.length) return emptyDetailHTML();
  const homonymNote = personDetails.length > 1
    ? `<p class="hint">동명이인 ${personDetails.length}명입니다. 왼쪽 목록에는 직업별로 작품이 함께 표시됩니다.</p>`
    : hasPersonFilmography()
      ? `<p class="hint">왼쪽 목록에서 작품을 선택하면 상세 정보를 볼 수 있습니다.</p>`
      : "";
  return `
    ${homonymNote}
    <div class="person-cards">${personDetails.map((person) => personDetailCardHTML(person)).join("")}</div>
    <p class="attr">인물 정보 TMDB</p>
  `;
}

function updateDetailPage(): void {
  if (!mounted || !isMobileLayout() || !showDetailPage) {
    detailHost.innerHTML = "";
    return;
  }
  const heading = detail
    ? (detail.titleKO || detail.titleEN)
    : personDetails.length
      ? personDetails.length > 1
        ? `${personDetails[0].nameKO || personDetails[0].nameEN} 외 ${personDetails.length - 1}명`
        : (personDetails[0].nameKO || personDetails[0].nameEN)
    : selected
      ? (selected.titleKO || selected.titleEN)
      : "상세 정보";
  detailHost.innerHTML = `
    <div class="detail-page">
      <header class="detail-page-head">
        <button class="ghost" type="button" id="close-detail">← 돌아가기</button>
        <button class="ghost go-home" type="button">어디봐</button>
        <h2>${escapeHTML(heading)}</h2>
      </header>
      <div class="detail-page-body">${detail || loadingDetail || detailError ? detailHTML({ forOverlay: true }) : personDetailHTML()}</div>
    </div>
  `;
  detailHost.querySelector("#close-detail")?.addEventListener("click", () => {
    closeDetailPage();
  });
  bindHomeButtons(detailHost);
  const body = detailHost.querySelector(".detail-page-body");
  if (body) bindDetailControls(body);
}

function detailHTML(options?: { forOverlay?: boolean }): string {
  if (!detail) {
    if (detailError) return `<div class="empty">${escapeHTML(detailError)}</div>`;
    if (searching && query.trim()) return `<div class="loading">검색 중…</div>`;
    if (loadingDetail) return `<div class="loading">정보를 불러오는 중…</div>`;
    if (loadingPersonDetail || personDetails.length) return personDetailHTML();
    return options?.forOverlay ? `<div class="loading">정보를 불러오는 중…</div>` : emptyDetailHTML();
  }
  const d = detail;
  const primary = d.titleKO || d.titleEN;
  const secondary = d.titleEN && d.titleEN !== primary ? d.titleEN : "";
  const meta = [kindLabel(d.kind), d.year, runtimeText(d), d.certification, ...d.genres.slice(0, 4)].filter(Boolean);
  const region = settings.region;
  const local = d.availability.find((item) => item.countryCode === region);
  const offers: WatchOffer[] = ["flatrate", "free", "ads", "rent", "buy"];
  const theaterBadge = d.kind === "movie" && d.inTheaters ? theaterBadgeHTML() : "";
  const backdrop = posterURL(d.backdropPath, "w1280");
  const primaryVideo = d.videos[0];
  return `
    ${backdrop ? `<div class="detail-backdrop"><img alt="" src="${backdrop}" loading="lazy" decoding="async" /></div>` : ""}
    <div class="header">
      <img class="poster" alt="" src="${posterURL(d.posterPath, "w500") ?? ""}" loading="lazy" decoding="async" />
      <div>
        <h1>${escapeHTML(primary)}</h1>
        ${secondary ? `<p>${escapeHTML(secondary)}</p>` : ""}
        <div class="pills">${theaterBadge}${meta.map((item) => `<span>${escapeHTML(String(item))}</span>`).join("")}</div>
        ${d.tagline ? `<p><i>${escapeHTML(d.tagline)}</i></p>` : ""}
        ${d.director ? directorLinksHTML(d.director) : ""}
        ${d.networks.length ? `<p>방송/공개 ${escapeHTML(d.networks.join(" · "))}</p>` : ""}
      </div>
    </div>
    <section class="section">
      <h2>평점</h2>
      <div class="ratings">
        ${d.tmdbCount ? badge("TMDB", d.tmdbScore.toFixed(1), `${d.tmdbCount.toLocaleString()}명`, "tmdb") : ""}
        ${d.imdb ? badge("IMDb", d.imdb, d.imdbVotes ? `${d.imdbVotes}표` : undefined, "imdb") : ""}
        ${d.rottenTomatoes ? badge("Rotten Tomatoes", d.rottenTomatoes, undefined, "rotten") : ""}
        ${d.metacritic ? badge("Metacritic", d.metacritic, undefined, "meta") : ""}
        ${d.tvmaze ? badge("TVMaze", d.tvmaze, "시리즈", "tvmaze") : ""}
      </div>
      ${!settings.hasOMDb ? `<p class="hint">IMDb · 로튼토마토 점수는 OMDb 연동 시 표시됩니다.</p>` : ""}
    </section>
    ${primaryVideo ? `
    <section class="section">
      <h2>예고편</h2>
      <div class="video-embed">
        <iframe
          src="${primaryVideo.embedURL}"
          title="${escapeHTML(primaryVideo.name)}"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen
        ></iframe>
      </div>
      ${d.videos.length > 1 ? `
      <div class="video-links">
        ${d.videos.map((video, index) => `
          <a href="${video.url}" target="_blank" rel="noreferrer"${index === 0 ? ' aria-current="true"' : ""}>
            ${escapeHTML(video.name)}
          </a>`).join("")}
      </div>` : ""}
    </section>` : ""}
    ${d.stills.length ? `
    <section class="section">
      <h2>스틸컷</h2>
      <div class="stills">
        ${d.stills.map((path) => `<img alt="" src="${posterURL(path, "w780") ?? ""}" loading="lazy" decoding="async" />`).join("")}
      </div>
    </section>` : ""}
    ${loadingReviews ? `
    <section class="section">
      <h2>인기 평가</h2>
      <div class="loading">평가 불러오는 중…</div>
    </section>` : reviewsSectionHTML(d)}
    <section class="section">
      <h2>어디서 볼 수 있나요
        <select id="region">${REGIONS.map((item) => `<option value="${item.code}" ${item.code === region ? "selected" : ""}>${item.name}</option>`).join("")}</select>
      </h2>
      ${local && local.providers.length ? offers.map((type) => {
        const providers = local.providers.filter((item) => item.offerType === type);
        if (!providers.length) return "";
        return `<p><b>${OFFER_LABEL[type]}</b></p>
          <div class="providers">${providers.map((item) => {
            const href = providerLink(item.name, primary) ?? local.justWatchURL ?? "#";
            return `<a class="provider" href="${href}" target="_blank" rel="noreferrer">
              <img class="logo" alt="" src="${posterURL(item.logoPath, "w92") ?? ""}" loading="lazy" decoding="async" />
              <span>${escapeHTML(item.name)}</span>
            </a>`;
          }).join("")}</div>`;
      }).join("") : `<p class="hint">${regionName(region)}에서는 등록된 스트리밍 정보가 없습니다.</p>`}
    </section>
    ${d.overview ? `<section class="section"><h2>줄거리</h2><p>${escapeHTML(d.overview)}</p></section>` : ""}
    ${d.cast.length ? `<section class="section"><h2>출연</h2><div class="cast">${d.cast.map((person) => `
      <button type="button" class="person person-search" data-person-search="${escapeHTML(person.name)}">
        <img class="face" alt="" src="${posterURL(person.profilePath) ?? ""}" loading="lazy" decoding="async" />
        <div>${escapeHTML(person.name)}</div>
        <small>${escapeHTML(person.role)}</small>
      </button>`).join("")}</div></section>` : ""}
    <section class="section links">
      <a href="${d.tmdbURL}" target="_blank" rel="noreferrer">TMDB에서 열기</a>
      ${d.kmdbURL ? `<a href="${d.kmdbURL}" target="_blank" rel="noreferrer">KMDb에서 열기</a>` : ""}
      ${d.imdbID ? `<a href="https://www.imdb.com/title/${d.imdbID}/" target="_blank" rel="noreferrer">IMDb에서 열기</a>` : ""}
      ${d.wikipediaURL ? `<a href="${d.wikipediaURL}" target="_blank" rel="noreferrer">위키백과</a>` : ""}
      ${!primaryVideo ? `<a href="https://www.youtube.com/results?search_query=${encodeURIComponent(`${primary} 예고편 trailer`)}" target="_blank" rel="noreferrer">예고편</a>` : ""}
      ${d.homepage ? `<a href="${d.homepage}" target="_blank" rel="noreferrer">공식 사이트</a>` : ""}
    </section>
    <p class="attr">작품 정보 TMDB${settings.hasKMDB ? " · 한국영화 KMDb" : ""} · 시리즈 TVMaze · 시청 가능 플랫폼 JustWatch</p>
  `;
}

function badge(label: string, value: string, sub: string | undefined, klass: string): string {
  return `<div class="badge"><small>${label}</small><div class="${klass}"><b>${escapeHTML(value)}</b></div>${sub ? `<small>${escapeHTML(sub)}</small>` : ""}</div>`;
}

function reviewsSectionHTML(d: TitleDetail): string {
  const hasKorean = d.popularReviews.some((review) => containsHangul(review.content) || containsHangul(review.translatedContent ?? ""));
  const translationBlocked = reviewsNeedTranslation(d.popularReviews) && !reviewsTranslated(d.popularReviews);
  const watcha = watchaSearchURL(d.titleKO, d.titleEN);
  return `
    <section class="section">
      <h2>인기 평가</h2>
      ${d.popularReviews.length ? `
      <div class="reviews">
        ${d.popularReviews.map((review) => `
          <article class="review-card">
            <div class="review-head">
              <div>
                <b>${escapeHTML(review.author)}</b>
                <span class="review-source">${escapeHTML(review.source)}</span>
              </div>
              ${review.likes != null ? `<span class="review-likes">추천 ${review.likes.toLocaleString()}</span>` : ""}
              ${review.rating != null ? `<span class="review-rating">★ ${review.rating.toFixed(0)}/10</span>` : ""}
            </div>
            <p>${escapeHTML(review.translatedContent ?? review.content)}</p>
            ${review.translatedContent ? `<details class="review-original"><summary>원문 보기</summary><p>${escapeHTML(review.content)}</p></details>` : ""}
            ${review.url ? `<a href="${review.url}" target="_blank" rel="noreferrer">원문 보기</a>` : ""}
          </article>
        `).join("")}
      </div>` : `<p class="hint">TMDB에 등록된 한국어 리뷰가 없습니다.</p>`}
      ${!hasKorean ? `<p class="hint"><a href="${watcha}" target="_blank" rel="noreferrer">왓챠피디아에서 한국어 평가 보기</a></p>` : ""}
      ${translationBlocked ? `<p class="hint warn">영어 평가 번역 서비스가 일시적으로 제한 중입니다. 잠시 후 다시 시도하거나 원문을 참고해 주세요.</p>` : ""}
      <p class="hint">한글 리뷰를 우선 표시하며, 영어 리뷰는 자동 번역합니다.</p>
    </section>`;
}

async function runSearch(raw: string): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) {
    hits = [];
    error = "";
    searching = false;
    loadingPersonSearch = false;
    filter = "all";
    filmographySort = "default";
    updateFilmographyControls();
    updateResults();
    return;
  }
  if (!settings.hasTMDB) {
    error = "검색을 사용할 수 없습니다.";
    updateResults();
    return;
  }

  const generation = ++searchGeneration;
  searching = true;
  loadingPersonSearch = false;
  error = "";
  filter = "all";
  filmographySort = "default";
  detailGeneration += 1;
  loadingDetail = !isMobileLayout();
  detail = undefined;
  personDetails = [];
  loadingPersonDetail = false;
  detailError = "";
  personDetailGeneration += 1;
  if (!isMobileLayout()) selected = undefined;
  updateResults();
  updateDetail();

  try {
    const [titleHits, playing] = await Promise.all([
      searchTitleHits(trimmed),
      loadNowPlaying(settings.region),
    ]);
    if (generation !== searchGeneration) return;
    if (searchInput.value.trim() !== trimmed) return;
    nowPlayingIDs = playing;
    hits = prioritizeNowPlaying(titleHits, playing);
    selected = isMobileLayout() ? undefined : hits[0];
    searching = false;
    updateFilmographyControls();
    updateResults();
    const deferDetail = shouldDeferDetailForPersonSearch(selected, trimmed);
    if (selected && !deferDetail) {
      void loadSelected();
    } else if (!deferDetail) {
      loadingDetail = false;
      updateDetail();
    } else {
      loadingDetail = false;
      updateDetail();
    }

    loadingPersonSearch = true;
    updateResults();

    void (async () => {
      try {
        const quickHits = await searchPersonKnownHits(trimmed);
        if (generation !== searchGeneration) return;
        if (searchInput.value.trim() !== trimmed) return;

        let combined = titleHits;
        if (quickHits.length) {
          combined = await applyPersonFilmography(quickHits, titleHits, trimmed, generation, selected?.id);
        }

        if (quickHits.length >= 10) {
          loadingPersonSearch = false;
          updateResults();
          void refineSearchWithImdb(combined, trimmed).then((refined) => {
            if (generation !== searchGeneration) return;
            if (searchInput.value.trim() !== trimmed) return;
            hits = sortPersonFilmographyHits(prioritizeNowPlaying(refined, nowPlayingIDs));
            updateResults();
          });
          return;
        }

        const personHits = await searchPersonHits(trimmed);
        if (generation !== searchGeneration) return;
        if (searchInput.value.trim() !== trimmed) return;
        loadingPersonSearch = false;
        combined = await applyPersonFilmography(personHits, titleHits, trimmed, generation, selected?.id);

        void refineSearchWithImdb(combined, trimmed).then((refined) => {
          if (generation !== searchGeneration) return;
          if (searchInput.value.trim() !== trimmed) return;
          hits = sortPersonFilmographyHits(prioritizeNowPlaying(refined, nowPlayingIDs));
          updateResults();
        });
      } catch {
        if (generation !== searchGeneration) return;
        loadingPersonSearch = false;
        updateResults();
      }
    })();
  } catch (err) {
    if (generation !== searchGeneration) return;
    error = err instanceof Error ? err.message : "검색에 실패했습니다.";
    loadingDetail = false;
    updateResults();
    updateDetail();
  } finally {
    if (generation === searchGeneration) {
      searching = false;
      updateResults();
    }
  }
}

let detailGeneration = 0;
let personDetailGeneration = 0;
let loadingReviews = false;
let detailError = "";

async function loadPersonContext(query: string, generation: number): Promise<void> {
  if (!hasPersonFilmography()) return;
  const personGen = ++personDetailGeneration;
  loadingPersonDetail = true;
  detail = undefined;
  detailError = "";
  loadingDetail = false;
  updateDetail();
  try {
    const personIDs = await resolvePersonIDs(query);
    if (generation !== searchGeneration || personGen !== personDetailGeneration) return;
    if (!personIDs.length) return;
    personDetails = await Promise.all(personIDs.map((personID) => fetchPersonDetail(personID)));
  } catch {
    if (personGen === personDetailGeneration) personDetails = [];
  } finally {
    if (personGen === personDetailGeneration) loadingPersonDetail = false;
    if (generation === searchGeneration && !detail) updateDetail();
  }
}

async function applyPersonFilmography(
  personHits: SearchHit[],
  titleHits: SearchHit[],
  trimmed: string,
  generation: number,
  previousSelected?: string,
): Promise<SearchHit[]> {
  const enriched = sortPersonFilmographyHits(await enrichFilmographyProviders(personHits, settings.region));
  const combined = mergeSearchResults(titleHits, enriched, trimmed);
  hits = prioritizeNowPlaying(combined, nowPlayingIDs);
  updateFilmographyControls();
  if (!isMobileLayout()) {
    const prev = previousSelected ? hits.find((hit) => hit.id === previousSelected) : undefined;
    const filmography = hits.filter((hit) => hit.matchedPerson);
    if (filmography.length) {
      selected = prev?.matchedPerson ? prev : filmography[0];
    } else {
      selected = prev ?? hits[0];
    }
  }
  updateResults();
  if (!isMobileLayout() && hasPersonFilmography(hits)) {
    void loadPersonContext(trimmed, generation);
  }
  return combined;
}

async function loadSelected(): Promise<void> {
  if (!selected) return;
  const hit = selected;
  const generation = ++detailGeneration;
  loadingDetail = true;
  loadingReviews = false;
  detailError = "";
  detail = undefined;
  updateDetail();
  try {
    const next = await fetchDetail(hit.kind, hit.tmdbID);
    if (generation !== detailGeneration) return;
    detail = next;
    loadingDetail = false;
    updateDetail();
  } catch (err) {
    if (generation !== detailGeneration) return;
    detailError = err instanceof Error ? err.message : "상세 정보를 불러오지 못했습니다.";
    detail = undefined;
    loadingDetail = false;
    updateDetail();
    return;
  }

  loadingReviews = true;
  updateDetail();

  const enrichTask = enrichDetail(detail).then(() => {
    if (generation !== detailGeneration || !detail) return;
    updateDetail();
  });

  const reviewsTask = (async () => {
    try {
      const reviews = await fetchPopularReviews(hit.kind, hit.tmdbID, detail!.titleKO, detail!.titleEN);
      if (generation !== detailGeneration || !detail) return;
      detail.popularReviews = await translateReviews(reviews);
      if (generation !== detailGeneration || !detail) return;
    } catch {
      if (generation !== detailGeneration || !detail) return;
      detail.popularReviews = detail.popularReviews ?? [];
    }
  })();

  try {
    await Promise.all([enrichTask, reviewsTask]);
  } finally {
    if (generation !== detailGeneration) return;
    loadingReviews = false;
    updateDetail();
  }
}

async function refreshNowPlaying(): Promise<void> {
  if (!settings.hasTMDB) {
    nowPlayingIDs = new Set();
    return;
  }
  nowPlayingIDs = await loadNowPlaying(settings.region);
  updateResults();
}

export async function loadRecommendations(): Promise<void> {
  if (!settings.hasTMDB || loadingRecommend || recommendLoaded) return;
  loadingRecommend = true;
  recommendError = "";
  updateResults();
  updateRecommendPage();
  try {
    const bundle = await getRecommendBundle(settings.region);
    if (bundle && recommendBundleFresh(bundle)) {
      applyRecommendBundle(bundle, selectedGenreID);
      await refreshNowPlaying();
      return;
    }

    recommendFromBundle = false;
    const [data] = await Promise.all([
      fetchRecommendations(settings.region, selectedGenreID),
      refreshNowPlaying(),
    ]);
    recommendTrending = data.trending;
    recommendProviders = data.providers;
    recommendLoaded = true;
    ensureSelectedProvider();
    if (!recommendProviders.length) {
      recommendError = "OTT 추천을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
  } catch (err) {
    recommendTrending = [];
    recommendProviders = [];
    recommendFromBundle = false;
    recommendError = err instanceof Error ? err.message : "OTT 추천을 불러오지 못했습니다.";
  } finally {
    loadingRecommend = false;
    recommendLoadScheduled = false;
    updateResults();
    updateRecommendPage();
  }
}

async function reloadProviderRecommendations(): Promise<void> {
  if (!settings.hasTMDB || !recommendLoaded) return;

  const bundle = await getRecommendBundle(settings.region);
  if (bundle && recommendBundleFresh(bundle)) {
    recommendProviders = providersForGenre(bundle, selectedGenreID);
    recommendFromBundle = true;
    recommendError = visibleRecommendProviders()[0]?.hits.length
      ? ""
      : "이 장르에 해당하는 OTT 작품을 찾지 못했습니다.";
    updateResults();
    updateRecommendPage();
    return;
  }

  const generation = ++providerRecommendGeneration;
  loadingProviderRecommend = true;
  recommendError = "";
  updateResults();
  updateRecommendPage();
  try {
    const providers = await refreshProviderGroup(
      settings.region,
      selectedProviderID,
      selectedGenreID,
      recommendProviders,
    );
    if (generation !== providerRecommendGeneration) return;
    recommendProviders = providers;
    recommendFromBundle = false;
    if (!visibleRecommendProviders()[0]?.hits.length) {
      recommendError = "이 장르에 해당하는 OTT 작품을 찾지 못했습니다.";
    }
  } catch (err) {
    if (generation !== providerRecommendGeneration) return;
    recommendError = err instanceof Error ? err.message : "OTT 추천을 불러오지 못했습니다.";
  } finally {
    if (generation !== providerRecommendGeneration) return;
    loadingProviderRecommend = false;
    updateResults();
    updateRecommendPage();
  }
}
