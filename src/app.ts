import { fetchDetail, pingTMDB, providerLink, searchTitles } from "./api";
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

function filteredHits(): SearchHit[] {
  if (filter === "all") return hits;
  return hits.filter((hit) => hit.kind === filter);
}

function escapeHTML(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function render(): void {
  const list = filteredHits();
  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar">
        <div class="search-box">
          <h1>어디봐</h1>
          <input id="q" value="${escapeHTML(query)}" placeholder="드라마 · 영화 · 예능 (한글/영어)" />
          <div class="filters">
            ${(["all", "movie", "tv"] as MediaFilter[]).map((item) => `
              <button data-filter="${item}" class="${filter === item ? "active" : ""}">${item === "all" ? "전체" : item === "movie" ? "영화" : "시리즈"}</button>
            `).join("")}
          </div>
          <button class="linkish" id="open-settings">API 키 설정</button>
        </div>
        <div class="results">
          ${searching && !hits.length ? `<div class="loading">검색 중…</div>` : ""}
          ${error && !hits.length ? `<div class="empty">${escapeHTML(error)}</div>` : ""}
          ${!query.trim() && !hits.length ? `<div class="empty">한글이나 영어 제목으로 검색하세요.<br>예: 오징어게임, Squid Game</div>` : ""}
          ${list.map((hit) => `
            <button class="hit ${selected?.id === hit.id ? "selected" : ""}" data-id="${hit.id}">
              <img alt="" src="${posterURL(hit.posterPath) ?? ""}" />
              <span>
                <b>${escapeHTML(hit.titleKO || hit.titleEN)}</b>
                <small>${escapeHTML([hit.titleEN !== hit.titleKO ? hit.titleEN : "", kindLabel(hit.kind), hit.year].filter(Boolean).join(" · "))}</small>
              </span>
            </button>
          `).join("")}
        </div>
      </aside>
      <main class="detail">${detailHTML()}</main>
    </div>
    ${showSettings ? settingsHTML() : ""}
  `;
  bind();
}

function detailHTML(): string {
  if (loadingDetail && !detail) return `<div class="loading">정보를 불러오는 중…</div>`;
  if (!detail) return `<div class="empty">왼쪽에서 작품을 고르면<br>어디서 볼 수 있는지와 평점을 보여 줍니다.</div>`;
  const d = detail;
  const primary = d.titleKO || d.titleEN;
  const secondary = d.titleEN && d.titleEN !== primary ? d.titleEN : "";
  const meta = [kindLabel(d.kind), d.year, runtimeText(d), d.certification, ...d.genres.slice(0, 4)].filter(Boolean);
  const region = settings.region;
  const local = d.availability.find((item) => item.countryCode === region);
  const offers: WatchOffer[] = ["flatrate", "free", "ads", "rent", "buy"];
  return `
    <div class="header">
      <img class="poster" alt="" src="${posterURL(d.posterPath, "w500") ?? ""}" />
      <div>
        <h1>${escapeHTML(primary)}</h1>
        ${secondary ? `<p>${escapeHTML(secondary)}</p>` : ""}
        <div class="pills">${meta.map((item) => `<span>${escapeHTML(String(item))}</span>`).join("")}</div>
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

function settingsHTML(): string {
  return `
    <div class="modal-bg">
      <div class="modal">
        <h2>API 키 설정</h2>
        <p>키는 이 브라우저에만 저장됩니다. GitHub Pages에는 올라가지 않습니다.</p>
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

function bind(): void {
  const input = document.querySelector<HTMLInputElement>("#q");
  input?.addEventListener("input", () => {
    query = input.value;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void runSearch(query), 280);
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void runSearch(query);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      filter = button.dataset.filter as MediaFilter;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((button) => {
    button.addEventListener("click", () => {
      selected = hits.find((hit) => hit.id === button.dataset.id);
      void loadSelected();
    });
  });
  document.querySelector("#open-settings")?.addEventListener("click", () => {
    showSettings = true;
    render();
  });
  document.querySelector("#region")?.addEventListener("change", (event) => {
    settings.region = (event.target as HTMLSelectElement).value;
    render();
  });
  document.querySelector("#save-settings")?.addEventListener("click", () => {
    settings.tmdb = document.querySelector<HTMLInputElement>("#tmdb-key")?.value ?? "";
    settings.omdb = document.querySelector<HTMLInputElement>("#omdb-key")?.value ?? "";
    showSettings = false;
    render();
  });
  document.querySelector("#ping")?.addEventListener("click", async () => {
    settings.tmdb = document.querySelector<HTMLInputElement>("#tmdb-key")?.value ?? "";
    const status = document.querySelector("#settings-status");
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
    render();
    return;
  }
  if (!settings.hasTMDB) {
    showSettings = true;
    render();
    return;
  }
  searching = true;
  error = "";
  render();
  try {
    hits = await searchTitles(trimmed);
    selected = hits[0];
    searching = false;
    render();
    if (selected) await loadSelected();
  } catch (err) {
    searching = false;
    error = err instanceof Error ? err.message : "검색에 실패했습니다.";
    render();
  }
}

async function loadSelected(): Promise<void> {
  if (!selected) return;
  loadingDetail = true;
  render();
  try {
    detail = await fetchDetail(selected.kind, selected.tmdbID);
  } catch (err) {
    error = err instanceof Error ? err.message : "상세 정보를 불러오지 못했습니다.";
  } finally {
    loadingDetail = false;
    render();
  }
}
