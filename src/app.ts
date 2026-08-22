import { fetchDetail, fetchPopularReviews, pingTMDB, providerLink, searchTitles, watchaSearchURL } from "./api";
import { loadRecommendations as fetchRecommendations, fetchProviderRecommendations, invalidateRecommendChart, RECOMMEND_GENRES, type RecommendProvider } from "./recommend";
import { invalidateNowPlaying, loadNowPlaying } from "./theaters";
import { containsHangul } from "./lang";
import { reviewsNeedTranslation, reviewsTranslated, translateReviews } from "./translate";
import { settings } from "./settings";
import { OFFER_LABEL, REGIONS, kindLabel, posterURL, regionName, runtimeText, type MediaFilter, type SearchHit, type TitleDetail, type WatchOffer } from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
let query = "";
let filter: MediaFilter = "all";
let hits: SearchHit[] = [];
let selected: SearchHit | undefined;
let detail: TitleDetail | undefined;
let searching = false;
let loadingDetail = false;
let error = "";
let showSettings = !settings.hasTMDB;
let debounce: number | undefined;
let searchGeneration = 0;
let recommendTrending: SearchHit[] = [];
let recommendProviders: RecommendProvider[] = [];
let selectedGenreID = 0;
let loadingRecommend = false;
let loadingProviderRecommend = false;
let recommendLoaded = false;
let nowPlayingIDs = new Set<number>();
let providerRecommendGeneration = 0;

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
let detailEl!: HTMLElement;
let settingsHost!: HTMLDivElement;

function activeGenreName(): string {
  return RECOMMEND_GENRES.find((genre) => genre.id === selectedGenreID)?.name ?? "전체";
}

function ottGroupHTML(group: RecommendProvider): string {
  return `
    <div class="ott-group">
      <div class="ott-group-head">
        ${group.logo ? `<img alt="" src="${posterURL(group.logo, "w92") ?? ""}" />` : ""}
        <span>${escapeHTML(group.name)}</span>
      </div>
      ${group.hits.map((hit) => hitButton(hit, selected?.id)).join("")}
    </div>`;
}

function isInTheaters(hit: SearchHit): boolean {
  return hit.kind === "movie" && nowPlayingIDs.has(hit.tmdbID);
}

function theaterBadgeHTML(): string {
  return `<span class="theater-badge">극장 상영중</span>`;
}

function hitButton(hit: SearchHit, selectedId?: string): string {
  const meta = [hit.titleEN !== hit.titleKO ? hit.titleEN : "", kindLabel(hit.kind), hit.year].filter(Boolean).join(" · ");
  const provider = hit.providerLogo
    ? `<img class="hit-provider" alt="" title="${escapeHTML(hit.providerName ?? "")}" src="${posterURL(hit.providerLogo, "w92") ?? ""}" />`
    : (hit.providerName ? `<span class="hit-provider-name">${escapeHTML(hit.providerName)}</span>` : "");
  const theater = isInTheaters(hit) ? theaterBadgeHTML() : "";
  return `
    <button class="hit ${selectedId === hit.id ? "selected" : ""}" data-id="${hit.id}">
      <img alt="" src="${posterURL(hit.posterPath) ?? ""}" />
      <span>
        <b>${escapeHTML(hit.titleKO || hit.titleEN)}${theater}</b>
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
      void loadSelected();
    });
  });
}

function filteredHits(): SearchHit[] {
  if (filter === "all") return hits;
  return hits.filter((hit) => hit.kind === filter);
}

let mounted = false;

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function render(): void {
  if (!mounted) mount();
  updateResults();
  updateDetail();
  updateSettings();
}

function mount(): void {
  mounted = true;
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="search-box">
          <h1>어디봐</h1>
          <input id="q" placeholder="드라마 · 영화 · 예능 (한글/영어)" />
          <div class="filters">
            ${(["all", "movie", "tv"] as MediaFilter[]).map((item) => `
              <button data-filter="${item}" class="${filter === item ? "active" : ""}">${item === "all" ? "전체" : item === "movie" ? "영화" : "시리즈"}</button>
            `).join("")}
          </div>
          <button class="linkish" id="open-settings">API 키 설정</button>
        </div>
        <div class="results"></div>
      </aside>
      <main class="detail"></main>
    </div>
    <div id="settings-host"></div>
  `;

  searchInput = app.querySelector<HTMLInputElement>("#q")!;
  resultsEl = app.querySelector<HTMLDivElement>(".results")!;
  detailEl = app.querySelector<HTMLElement>(".detail")!;
  settingsHost = app.querySelector<HTMLDivElement>("#settings-host")!;

  searchInput.value = query;
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void runSearch(query), 280);
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void runSearch(searchInput.value);
  });

  app.querySelector("#open-settings")?.addEventListener("click", () => {
    showSettings = true;
    updateSettings();
  });

  app.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter as MediaFilter;
      app.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((item) => {
        item.classList.toggle("active", item.dataset.filter === filter);
      });
      updateResults();
    });
  });
}

function recommendHTML(): string {
  if (!settings.hasTMDB) {
    return `<div class="empty">API 키를 설정하면<br>오늘 뭐 볼지 추천해 드립니다.</div>`;
  }
  if (loadingRecommend) return `<div class="loading">추천 불러오는 중…</div>`;
  const genreLabel = selectedGenreID === 0 ? "" : ` · ${escapeHTML(activeGenreName())}`;
  return `
    <div class="recommend">
      <h2 class="recommend-title">오늘 뭐 볼까</h2>
      <h3 class="recommend-section">${escapeHTML(regionName(settings.region))} OTT별 급상승${genreLabel}</h3>
      <div class="genre-tabs">
        ${RECOMMEND_GENRES.map((genre) => `
          <button class="genre-tab ${genre.id === selectedGenreID ? "active" : ""}" data-genre="${genre.id}" ${loadingProviderRecommend && genre.id !== selectedGenreID ? "disabled" : ""}>${escapeHTML(genre.name)}</button>
        `).join("")}
      </div>
      ${loadingProviderRecommend ? `<div class="loading inline">OTT별 순위 불러오는 중…</div>` : ""}
      <p class="recommend-hint">오늘·이번 주 TMDB 급상승 차트 중 해당 OTT에서 시청 가능한 작품입니다. Netflix 앱 순위와는 다를 수 있습니다.</p>
      ${recommendProviders.map((group) => ottGroupHTML(group)).join("")}
      ${!loadingProviderRecommend && !recommendProviders.length ? `<div class="empty inline">이 장르에 해당하는 OTT 작품이 없습니다.</div>` : ""}
      <h3 class="recommend-section">요즘 인기</h3>
      ${recommendTrending.map((hit) => hitButton(hit, selected?.id)).join("")}
    </div>`;
}

function bindRecommendControls(root: ParentNode): void {
  root.querySelectorAll<HTMLButtonElement>("[data-genre]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = Number(button.dataset.genre);
      if (next === selectedGenreID) return;
      selectedGenreID = next;
      updateResults();
      void reloadProviderRecommendations();
    });
  });
}

function updateResults(): void {
  const list = filteredHits();
  const showRecommend = !query.trim() && !hits.length && !searching;
  resultsEl.innerHTML = `
    ${searching && !hits.length ? `<div class="loading">검색 중…</div>` : ""}
    ${error && !hits.length && query.trim() ? `<div class="empty">${escapeHTML(error)}</div>` : ""}
    ${showRecommend ? recommendHTML() : ""}
    ${list.map((hit) => hitButton(hit, selected?.id)).join("")}
  `;
  bindHits(resultsEl);
  bindRecommendControls(resultsEl);
}

function updateDetail(): void {
  detailEl.innerHTML = detailHTML();
  detailEl.querySelector("#region")?.addEventListener("change", (event) => {
    const next = (event.target as HTMLSelectElement).value;
    if (next === settings.region) return;
    settings.region = next;
    invalidateNowPlaying();
    invalidateRecommendChart();
    recommendLoaded = false;
    void refreshNowPlaying().then(() => {
      if (detail?.kind === "movie") {
        detail.inTheaters = nowPlayingIDs.has(detail.tmdbID);
      }
      updateDetail();
    });
    void loadRecommendations();
    updateDetail();
  });
}

function detailHTML(): string {
  if (loadingDetail && !detail) return `<div class="loading">정보를 불러오는 중…</div>`;
  if (detailError && !detail) return `<div class="empty">${escapeHTML(detailError)}</div>`;
  if (!detail) return `<div class="empty">왼쪽에서 작품을 고르거나<br>「오늘 뭐 볼까」 추천을 눌러 보세요.</div>`;
  const d = detail;
  const primary = d.titleKO || d.titleEN;
  const secondary = d.titleEN && d.titleEN !== primary ? d.titleEN : "";
  const meta = [kindLabel(d.kind), d.year, runtimeText(d), d.certification, ...d.genres.slice(0, 4)].filter(Boolean);
  const region = settings.region;
  const local = d.availability.find((item) => item.countryCode === region);
  const offers: WatchOffer[] = ["flatrate", "free", "ads", "rent", "buy"];
  const theaterBadge = d.kind === "movie" && d.inTheaters ? theaterBadgeHTML() : "";
  return `
    <div class="header">
      <img class="poster" alt="" src="${posterURL(d.posterPath, "w500") ?? ""}" />
      <div>
        <h1>${escapeHTML(primary)}</h1>
        ${secondary ? `<p>${escapeHTML(secondary)}</p>` : ""}
        <div class="pills">${theaterBadge}${meta.map((item) => `<span>${escapeHTML(String(item))}</span>`).join("")}</div>
        ${d.tagline ? `<p><i>${escapeHTML(d.tagline)}</i></p>` : ""}
        ${d.director ? `<p>감독/제작 ${escapeHTML(d.director)}</p>` : ""}
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
      ${!settings.hasOMDb ? `<p class="hint">IMDb · 로튼토마토 점수는 API 키 설정에서 OMDb 키를 넣으면 표시됩니다.</p>` : ""}
    </section>
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
              <img class="logo" alt="" src="${posterURL(item.logoPath, "w92") ?? ""}" />
              <span>${escapeHTML(item.name)}</span>
            </a>`;
          }).join("")}</div>`;
      }).join("") : `<p class="hint">${regionName(region)}에서는 등록된 스트리밍 정보가 없습니다.</p>`}
    </section>
    ${d.overview ? `<section class="section"><h2>줄거리</h2><p>${escapeHTML(d.overview)}</p></section>` : ""}
    ${d.cast.length ? `<section class="section"><h2>출연</h2><div class="cast">${d.cast.map((person) => `
      <div class="person">
        <img class="face" alt="" src="${posterURL(person.profilePath) ?? ""}" />
        <div>${escapeHTML(person.name)}</div>
        <small>${escapeHTML(person.role)}</small>
      </div>`).join("")}</div></section>` : ""}
    <section class="section links">
      <a href="${d.tmdbURL}" target="_blank" rel="noreferrer">TMDB에서 열기</a>
      ${d.imdbID ? `<a href="https://www.imdb.com/title/${d.imdbID}/" target="_blank" rel="noreferrer">IMDb에서 열기</a>` : ""}
      ${d.wikipediaURL ? `<a href="${d.wikipediaURL}" target="_blank" rel="noreferrer">위키백과</a>` : ""}
      <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(`${primary} 예고편 trailer`)}" target="_blank" rel="noreferrer">예고편</a>
      ${d.homepage ? `<a href="${d.homepage}" target="_blank" rel="noreferrer">공식 사이트</a>` : ""}
    </section>
    <p class="attr">작품 정보 TMDB · 시리즈 TVMaze · 시청 가능 플랫폼 JustWatch</p>
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

function settingsHTML(): string {
  return `
    <div class="modal-bg">
      <div class="modal">
        <h2>API 키 설정</h2>
        <p>키는 이 브라우저에만 저장됩니다. 배포본에는 기본 키가 포함되어 있어 바로 검색할 수 있습니다.</p>
        <label>TMDB API 키</label>
        <input id="tmdb-key" value="${escapeHTML(settings.tmdb)}" placeholder="TMDB API Key 또는 Read Access Token" />
        <div class="row">
          <a class="ghost" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noreferrer">TMDB 키 받기</a>
          <button class="ghost" id="ping">연결 확인</button>
        </div>
        <label>OMDb API 키 (선택)</label>
        <input id="omdb-key" value="${escapeHTML(settings.omdb)}" placeholder="예: 9fa86b4e" />
        <a class="ghost" href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer">OMDb 키 받기</a>
        <p id="settings-status" class="hint"></p>
        <button class="primary" id="save-settings">완료</button>
      </div>
    </div>
  `;
}

function updateSettings(): void {
  settingsHost.innerHTML = showSettings ? settingsHTML() : "";
  if (!showSettings) return;

  settingsHost.querySelector("#save-settings")?.addEventListener("click", () => {
    settings.tmdb = settingsHost.querySelector<HTMLInputElement>("#tmdb-key")?.value ?? "";
    settings.omdb = settingsHost.querySelector<HTMLInputElement>("#omdb-key")?.value ?? "";
    showSettings = false;
    updateSettings();
  });
  settingsHost.querySelector("#ping")?.addEventListener("click", async () => {
    settings.tmdb = settingsHost.querySelector<HTMLInputElement>("#tmdb-key")?.value ?? "";
    const status = settingsHost.querySelector("#settings-status");
    try {
      await pingTMDB();
      if (status) status.textContent = "연결 성공";
    } catch (err) {
      if (status) status.textContent = err instanceof Error ? err.message : "연결 실패";
    }
  });
}

async function runSearch(raw: string): Promise<void> {
  const trimmed = raw.trim();
  if (!trimmed) {
    hits = [];
    error = "";
    searching = false;
    updateResults();
    return;
  }
  if (!settings.hasTMDB) {
    showSettings = true;
    updateSettings();
    return;
  }

  const generation = ++searchGeneration;
  searching = true;
  error = "";
  updateResults();

  try {
    const nextHits = await searchTitles(trimmed);
    if (generation !== searchGeneration) return;
    if (searchInput.value.trim() !== trimmed) return;
    hits = nextHits;
    selected = hits[0];
    updateResults();
    if (selected) await loadSelected();
  } catch (err) {
    if (generation !== searchGeneration) return;
    error = err instanceof Error ? err.message : "검색에 실패했습니다.";
    updateResults();
  } finally {
    if (generation === searchGeneration) {
      searching = false;
      updateResults();
    }
  }
}

let detailGeneration = 0;
let loadingReviews = false;
let detailError = "";

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
  try {
    const reviews = await fetchPopularReviews(hit.kind, hit.tmdbID, detail.titleKO, detail.titleEN);
    if (generation !== detailGeneration || !detail) return;
    detail.popularReviews = await translateReviews(reviews);
    if (generation !== detailGeneration || !detail) return;
  } catch {
    if (generation !== detailGeneration || !detail) return;
    detail.popularReviews = detail.popularReviews ?? [];
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
  updateResults();
  try {
    const [data] = await Promise.all([
      fetchRecommendations(settings.region, selectedGenreID),
      refreshNowPlaying(),
    ]);
    recommendTrending = data.trending;
    recommendProviders = data.providers;
    recommendLoaded = true;
  } catch {
    recommendTrending = [];
    recommendProviders = [];
  } finally {
    loadingRecommend = false;
    updateResults();
  }
}

async function reloadProviderRecommendations(): Promise<void> {
  if (!settings.hasTMDB) return;
  const generation = ++providerRecommendGeneration;
  loadingProviderRecommend = true;
  updateResults();
  try {
    const providers = await fetchProviderRecommendations(settings.region, selectedGenreID);
    if (generation !== providerRecommendGeneration) return;
    recommendProviders = providers;
  } catch {
    if (generation !== providerRecommendGeneration) return;
    recommendProviders = [];
  } finally {
    if (generation !== providerRecommendGeneration) return;
    loadingProviderRecommend = false;
    updateResults();
  }
}
