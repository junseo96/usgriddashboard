# GitHub Pages 조회용 대시보드

공개 주소는 **https://junseo96.github.io/usgriddashboard/** 다. Cloudflare 계정 없이 GitHub Pages에서 공개 원장 검색·유형/권역 필터·상세·CSV·점수 계산 예시, 7개 ISO/RTO 부하 비교와 수용가 파이프라인을 제공한다. 평가 저장과 서버 API는 제공하지 않는다.

**관측 시계열 → 공식 과거 자료**에는 2020년 이후 확보한 원장·공시의 점수·건수·용량 계열과 CSV를 포함한다. 이 자료는 실제 앱 관측 기록과 분리하며 반복 게시로 과거 관측을 만들지 않는다. [기간·출처와 비교 한계](HISTORY.md)를 함께 확인한다.

## 최초 게시

1. 저장소 [Settings → Pages](https://github.com/junseo96/usgriddashboard/settings/pages)에서 **Build and deployment → Source → GitHub Actions**를 선택한다.
2. [Grid Atlas public dashboard](https://github.com/junseo96/usgriddashboard/actions/workflows/grid-atlas-pages.yml)에서 **Run workflow → main**을 실행한다.
3. 배포 성공 후 Actions의 `github-pages` 환경 또는 Pages 설정에 표시되는 실제 URL로 접속한다. 설정과 파일 생성만으로 사이트가 공개됐다고 판단하지 않는다.

이 저장소에 연결된 Codex GitHub 권한은 코드 업로드를 허용하지만 Pages 최초 생성 API는 `Resource not accessible by integration`으로 거부됐다. 따라서 최초 Source 설정은 저장소 관리자 화면에서 한 번 수행해야 한다. 비밀 토큰을 채팅에 전달할 필요는 없다.

## 부하 수집과 게시 일정

`main`의 새 앱 코드 변경·수동 실행 외에 매시 7·22·37·52분의 GitHub Actions 예약을 설정했다. 예약 시각은 실행 목표이며 GitHub 큐·원천 지연 때문에 정확한 15분 간격을 보장하지 않는다.

1. 마지막 검증 부하 JSON을 Actions 캐시에서 복원하고 공식 출처를 다시 수집한다.
2. 정상 관측과 권역별 `stale`/`unavailable`을 함께 검증한다. 손상된 캐시나 예상치 못한 수집기 오류는 게시를 중단한다. 일부 출처 실패 때는 검증된 이전 값을 유지하고 지연·실패를 표시한다.
3. 타입·데이터·API 검증 후 공개 HTML과 `grid-demand.json`을 함께 게시한다. API 키 없이 공식 CAISO·ERCOT 및 EIA 보고 자료를 사용한다.
4. 열려 있는 부하 화면은 1분마다 같은 사이트의 JSON을 재조회한다. 연결·검증 실패 때 최신 값으로 가장하지 않고 이전 관측을 `stale`로 표시한다.

Actions 요약에는 수집 성공 여부와 권역별 관측 시각을 남긴다. 배포 성공과 원천 수집 성공은 별개다. 실행 보고서·최종 JSON은 `demand-audit-*` 아티팩트로 **14일** 보관한다. CI 원문 파일은 실행 환경에만 생성되며 영구 보관되지 않는다. 이 부하 갱신은 전체 프로젝트 원장·수용가 공시·평가 점수의 자동 갱신을 뜻하지 않는다. 프로젝트 자료의 주간·월간 자동 적재는 별도 운영 설정이다.

출처·현지일·완전성·대체 피드 규칙은 [DEMAND.md](DEMAND.md), 수용가 조사 범위는 [LOAD_PIPELINE.md](LOAD_PIPELINE.md)를 참고한다.

## 로컬 생성

`apps/grid-atlas`에서 실행한다.

```sh
npm ci
python3 scripts/collect-demand.py
npm run build:pages
```

결과는 `.state/pages/index.html`, `grid-demand.json`, `.nojekyll`이다. `build:pages`는 수집을 수행하지 않으므로 별도 수집 명령이 실패했다면 출력 JSON의 실패·지연 상태를 확인한다. 임시 SQLite를 새로 만들고 포함된 bootstrap을 적재한 뒤, 실제 로컬 API 응답을 검증해 내보낸다. 기존 개발 DB, 평가 근거, 수집 원문을 읽거나 수정하지 않는다. 생성한 DB 관측 시각은 원자료 기준일이나 신규 수집 시각을 의미하지 않는다.

배포 파일에는 공개 자료와 화면 코드만 포함된다. DB·관리자 키·개발 서버는 배포하지 않는다. 현재 내보내기는 저장된 직접 요건 평가가 없는 원장과 `stage-proxy-v1` 단계 추정 점수를 지원한다. 개별 직접 평가 이력을 게시하려면 해당 내보내기 기능을 먼저 확장해야 한다. 단계 추정의 배점·원자료 날짜·미산출 분모는 [SCORE_COVERAGE.md](SCORE_COVERAGE.md)에 설명한다.
