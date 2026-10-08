# GitHub Pages 조회용 대시보드

Cloudflare 계정 없이 현재 화면을 공개하려면 GitHub Pages를 사용한다. 이 버전은 공개 원장 자료를 포함한 단일 HTML이다. 검색·유형/권역 필터·상세·CSV·점수 계산 예시가 동작한다. 평가 저장, 원자료 자동 갱신, 서버 API는 제공하지 않는다.

## 최초 게시

1. 저장소 [Settings → Pages](https://github.com/junseo96/usgriddashboard/settings/pages)에서 **Build and deployment → Source → GitHub Actions**를 선택한다.
2. [Grid Atlas public dashboard](https://github.com/junseo96/usgriddashboard/actions/workflows/grid-atlas-pages.yml)에서 **Run workflow → main**을 실행한다.
3. 배포 성공 후 Actions의 `github-pages` 환경 또는 Pages 설정에 표시되는 실제 URL로 접속한다. 설정과 파일 생성만으로 사이트가 공개됐다고 판단하지 않는다.

이 저장소에 연결된 Codex GitHub 권한은 코드 업로드를 허용하지만 Pages 최초 생성 API는 `Resource not accessible by integration`으로 거부됐다. 따라서 최초 Source 설정은 저장소 관리자 화면에서 한 번 수행해야 한다. 비밀 토큰을 채팅에 전달할 필요는 없다.

이후 `main`의 새 앱 코드가 바뀌면 위 워크플로가 읽기 전용 화면을 다시 게시한다. 이것은 새 원자료를 수집하는 일정이 아니며, 원자료 기준일은 보존된다. 게시 자료를 갱신하려면 검증한 초기 데이터를 코드에 반영해야 한다.

## 로컬 생성

`apps/grid-atlas`에서 실행한다.

```sh
npm ci
npm run build:pages
```

결과는 `.state/pages/index.html`이다. 임시 SQLite를 새로 만들고 포함된 bootstrap을 적재한 뒤, 실제 로컬 API 응답을 검증해 내보낸다. 기존 개발 DB, 평가 근거, 수집 원문을 읽거나 수정하지 않는다. 생성한 DB 관측 시각은 원자료 기준일이나 신규 수집 시각을 의미하지 않는다.

배포 파일에는 공개 자료와 화면 코드만 포함된다. DB·관리자 키·개발 서버는 배포하지 않는다. 현재 내보내기는 미평가 초기 자료만 지원하므로 실제 평가 이력을 게시하려면 해당 내보내기 기능을 먼저 확장해야 한다.
