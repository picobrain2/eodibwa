# 어디봐 (eodibwa-web) — 새 대화 핸드오프

> 이 문서는 새 Cursor 대화로 이어갈 때 컨텍스트용입니다.  
> 작성 기준: 2026-09-07 · `main` @ `bf08302`

## 한 줄 요약

**어디봐** = 영화·시리즈 검색 + 「오늘 뭐 볼까」 추천 PWA (GitHub Pages).  
추천 목록은 **사전 생성 JSON**, 상세(예고편·스틸컷·평점)는 **TMDB 등 라이브 API**.

| | |
|---|---|
| 경로 | `/Users/picobrain/code/Game/eodibwa-web` |
| 원격 | https://github.com/picobrain2/eodibwa |
| 라이브 | https://picobrain2.github.io/eodibwa/ |
| 스택 | vanilla TypeScript + Vite · 정적 `dist/` + `public/recommend/` |
| macOS 앱 | 같은 Game 모노레포의 `EodiBwa/` (별도 Xcode 프로젝트) |
| 사용자 | Yi-hyun (PM) · 코드로 바로 고치고 Pages 배포까지 하는 워크플로 선호 |

## 아키텍처

### 1. 추천 JSON (번들)

- CI에서 `scripts/pregenerate-recommendations.ts`로 MOTN + TMDB 기반 추천 생성
- `public/recommend/` 아래 지역·장르·OTT별 JSON
- **스케줄** (`.github/workflows/pages.yml`):
  - **KR**: 12시간마다 (`0 */12 * * *` UTC)
  - **해외**(US,JP,TW,HK,GB): 매일 15:00 UTC
- **push 배포**: `npm run merge-recommendations`만 (기존 라이브 JSON 병합) → 빠른 배포 (~1분)
- **schedule**: full `pregenerate` (MOTN API 사용)
- MOTN 월 한도 ~1,000 → 위 스케줄로 **~840/월** 수준

### 2. 검색·상세 (라이브)

- **검색**: TMDB multi + 인물 필모그래피 (2단계)
- **상세**: 클릭 시 TMDB `append_to_response` (providers, videos, images, credits …)
- **캐시**: detail 30분, person filmography 30분, recommend bundle TTL (KR 12h / 해외 24h)

### 3. API 키

- GitHub Secrets: `VITE_TMDB_KEY`, `VITE_OMDB_KEY`, `VITE_MOTN_KEY`, `VITE_KMDB_KEY`
- 로컬/설정 화면: `localStorage` (`settings.ts`) — 빌드 env fallback

## 검색 로직 (중요 — 최근 수정)

### 2단계 흐름 (`app.ts` → `runSearch`)

1. **제목 검색** (`searchTitleHits`) → 즉시 결과 표시
2. **인물 검색** (비동기) → 필모그래피 병합

### 최근 버그·수정 (2026-08~09)

| 이슈 | 원인 | 수정 |
|------|------|------|
| 「호프」 잠깐 보이다 사라짐 | 인물 검색 완료 후 **선택을 필모그래피로 강제 전환** | `shouldIncludePersonFilmography` · 선택 유지 |
| 「호프」 → 2013 「소원」 | 잘못된 TITLE alias | alias 제거, **2026 `1058424` pinned** |
| 「호프 2026」만 됨 | 연도 파싱 + pinned | `parseTitleSearchQuery`, `TITLE_PINNED` |
| 짧은 한글 4글자 | 인물 80점(접두)만으로 300만점 부스트 | 한글 짧은 검색은 **인물 100점(완전일치)** 만 |

### 핵심 함수 (`api.ts`)

- `parseTitleSearchQuery` — `호프 2026` → text + year
- `TITLE_PINNED` — `{ 호프: [{ kind: "movie", tmdbID: 1058424, year: "2026" }] }`
- `shouldIncludePersonFilmography` — pinned/정확 제목이면 **인물 검색 생략**
- `isExactTitleSearch` / `isKnownStageNameQuery` — 하하·IU 등 stage name은 인물 우선
- `filterTitleNoise` — 짧은 검색에서 제목·인물 균형
- `isPersonSearchTitleNoise` — 「무한」→「무한도전」 노이즈는 **인물 검색에만** (`forPersonSearch: true`)

## 상세 화면 미디어 (최근)

- **예고편 · 영상**: Trailer, Teaser, Clip, Featurette, Behind the Scenes, NG, Opening Credits — YouTube, **최대 16개**, 유형 뱃지
- **스틸컷 · 배경**: `include_image_language=ko,null,en`, ko+en 병합, **최대 16개**
- 클릭 → **라이트박스/모달** (예고편 embed, 이미지 w1280)
- 상단 **히어로 backdrop** 1장은 별도 (`backdrop_path`)

## UI / 레이아웃

- **데스크톱**: 검색 | 상세 2-pane
- **모바일** (`max-width: 860px`): 홈에 추천 인라인, 상세는 별도 페이지
- 「오늘 뭐 볼까」: 장르·OTT별 추천, pregenerated JSON

## 배포

```bash
cd /Users/picobrain/code/Game/eodibwa-web
npm run build          # 로컬: tsc + vite만
# main push → Actions "GitHub Pages"
#   push: merge-recommendations + build (~1–2분)
#   schedule: pregenerate + build
```

**주의**: push 후 Actions가 `queued`로 오래 멈추면 `gh workflow run pages.yml --ref main` 수동 실행. 가끔 `startup_failure` 발생.

## 자주 건드리는 파일

| 파일 | 역할 |
|------|------|
| `src/app.ts` | UI·검색·상세·추천·모바일 라우트 |
| `src/api.ts` | TMDB 검색/상세/인물/핀·필터 |
| `src/recommend.ts` | MOTN·장르·OTT 추천 로직 |
| `src/recommend-data.ts` | JSON 번들 로드·TTL |
| `src/motn.ts` | MOTN API·캐시 |
| `src/lang.ts` | 한글 검색 variant, relevance |
| `src/style.css` | video-row, stills, modal |
| `.github/workflows/pages.yml` | 배포·pregenerate 스케줄 |
| `scripts/pregenerate-recommendations.ts` | CI 추천 생성 |

## 다음에 손대면 좋을 후보 (미요청)

- 스틸컷 라이트박스 prev/next
- `TITLE_PINNED`를 설정 파일로 분리 (자주 추가 시)
- 인물 vs 제목 모호 검색 UI (탭 전환?)
- Actions `startup_failure` 모니터링

## 새 대화에 붙여넣을 프롬프트 (복사용)

```
어디봐(eodibwa-web) 이어서 작업하자.
경로: /Users/picobrain/code/Game/eodibwa-web
핸드오프: docs/handoff.md 먼저 읽고 시작해.
라이브: https://picobrain2.github.io/eodibwa/
추천=JSON(pregenerate), 검색·상세=TMDB 라이브. 고치면 main push로 Pages 배포.
검색은 2단계(제목→인물) — 짧은 한글·pinned 제목 주의.
```

## Git 상태 (핸드오프 시점)

- 브랜치: `main` @ `bf08302` (origin 동기화)
- 최근 커밋: 검색 인물 덮어쓰기 방지, 호프(2026) pinned, 미디어 16개 갤러리
