# Grid Atlas 게시 안내

Cloudflare는 새 사이트를 인터넷에서 계속 실행해 주는 호스팅 서비스입니다. Codex가 코드를 수정하고, GitHub가 코드와 변경 이력을 보관하며, Cloudflare가 방문자에게 사이트와 데이터를 제공합니다.

| 구성 | 이 프로젝트에서 하는 일 |
| --- | --- |
| Cloudflare Workers | 대시보드 화면과 조회·저장 API 실행 |
| Cloudflare D1 | 프로젝트, 출처, 절차별 평가, 시점별 관측, 수집 실행 기록 저장 |
| GitHub Actions | 코드 검사, 요청한 배포, 주간 또는 월간 수집 실행 |
| Codex | 구현·수정·검증 작업 |

별도 서버를 직접 관리하거나 처음부터 도메인을 구입할 필요는 없습니다. 먼저 Cloudflare가 제공하는 `https://us-grid-atlas.<계정 하위 도메인>.workers.dev` 형태의 새 주소를 사용할 수 있습니다. 실제 주소는 최초 배포 후 확인합니다. 기존 Work 사이트는 참고 자료이며 이 배포의 대상이 아닙니다.

이 안내와 워크플로 파일 작성만으로 사이트가 게시되거나 정기 수집이 가동되는 것은 아닙니다. Cloudflare 계정 연결과 GitHub 기본 브랜치에 코드 저장이 필요합니다. 요금제별 사용량 한도와 비용은 계정 생성 시 [Cloudflare 가격 안내](https://www.cloudflare.com/plans/developer-platform/)에서 확인하세요.

현재 약 1만 3천 건의 초기 자료 검증·전체 요약은 로컬 측정에서 수백 밀리초 규모의 CPU 처리를 사용합니다. 이 수치는 실제 Workers 환경의 측정값은 아니지만, Workers 무료 요금제의 요청별 CPU 한도로는 부족할 수 있음을 보여 줍니다. 최초 게시 전에 [Workers 한도](https://developers.cloudflare.com/workers/platform/limits/)와 [D1 한도](https://developers.cloudflare.com/d1/platform/limits/)를 확인하고, 실제 계정에서 초기 적재·요약 조회·스냅샷 저장을 검증하세요. 필요하면 유료 요금제와 적절한 CPU 한도를 선택하거나 집계 처리를 분리해야 합니다. 계정 없이 로컬 개발은 가능하지만 **무료 요금제로 전체 기능이 운영된다고 보장하지 않습니다.**

## 1. Cloudflare 계정과 새 데이터베이스 만들기

1. [Cloudflare 가입 페이지](https://dash.cloudflare.com/sign-up)에서 계정을 만듭니다. 이미 계정이 있으면 로그인합니다.
2. 대시보드에서 Workers와 D1을 찾습니다. D1 데이터베이스를 **새로** 만들고 이름을 `us-grid-atlas`로 지정합니다. 기존 사이트의 데이터베이스를 선택하지 않습니다.
3. 새 D1의 Database ID와 계정의 Account ID를 확인합니다. 이후 GitHub 설정에서 사용합니다.
4. API 토큰 관리 화면에서 이 계정에 한정된 토큰을 만듭니다. 이 워크플로에 필요한 권한은 Workers Scripts 편집과 D1 편집이며, 계정 확인에 필요한 Account Settings 읽기를 포함할 수 있습니다. 계정 범위는 사용할 계정으로 제한합니다. 사이트용 Zone 권한이나 Global API Key는 필요하지 않습니다.

토큰이나 비밀번호를 채팅에 붙여 넣지 않습니다. 아래 GitHub Secrets 입력란에 직접 저장합니다.

## 2. GitHub 설정값 등록

이 저장소의 [Settings → Secrets and variables → Actions](https://github.com/junseo96/usgriddashboard/settings/secrets/actions)에서 다음 값을 등록합니다. 관리 권한이 있는 GitHub 계정으로 로그인해야 합니다.

| 종류 | 이름 | 값 |
| --- | --- | --- |
| Secret | `CLOUDFLARE_API_TOKEN` | 위에서 발급한 계정 한정 API 토큰 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | 사용할 Cloudflare Account ID |
| Secret | `GRID_ATLAS_ADMIN_TOKEN` | 새 사이트의 쓰기 API 전용 무작위 비밀값, 최소 32자 |
| Variable | `D1_DATABASE_ID` | 새로 만든 Grid Atlas D1의 Database ID |
| Variable | `GRID_ATLAS_URL` | 최초 게시 후 확인한 새 HTTPS 주소, 경로·쿼리 없이 입력 |
| Variable | `ENABLE_GRID_ATLAS_REFRESH` | 처음에는 `false`; 수집을 활성화할 때만 `true` |
| Variable | `GRID_ATLAS_REFRESH_CADENCE` | `weekly` 또는 `monthly`; 미설정 시 `weekly` |

`GRID_ATLAS_ADMIN_TOKEN`은 Cloudflare 계정 토큰과 다릅니다. 임의의 웹 방문자가 프로젝트나 점수를 바꾸지 못하도록 새 사이트의 쓰기 API를 보호합니다. 비밀번호 관리기의 무작위 문자열 생성 기능을 사용할 수 있습니다. 브라우저 코드, 저장소 파일, 로그에 저장하지 않습니다. 배포 워크플로가 같은 값을 Worker의 `ADMIN_TOKEN` 비밀값으로 설치합니다.

이 버전은 **조회 화면과 조회 API를 공개**하고 쓰기 API만 인증합니다. 공개해도 되는 공식 데이터만 적재합니다. 비공개 원장이나 내부 자료를 다루려면 별도의 조회 접근 제어를 먼저 구현해야 합니다.

## 3. 최초 게시와 데이터 초기화

1. 검토한 새 앱 코드와 `.github/workflows/grid-atlas-*.yml`을 이 GitHub 저장소의 기본 브랜치에 저장합니다. 이 문서를 작성한 작업이 자동으로 커밋·푸시했다는 뜻은 아닙니다.
2. GitHub Actions의 **Grid Atlas checks** 통과를 확인합니다.
3. **Grid Atlas deploy (manual)** → Run workflow를 실행합니다. 첫 실행에서는 `seed_empty_database`를 선택하지 않습니다.
4. 워크플로가 타입검사·테스트·빌드, 새 D1의 스키마 적용, Worker 게시, 쓰기 비밀값 설정 순서로 진행됩니다. 게시 로그나 Cloudflare 대시보드에서 새 `workers.dev` 주소를 확인해 GitHub Variable `GRID_ATLAS_URL`에 저장합니다.
5. 같은 배포 워크플로를 다시 실행하면서 `seed_empty_database`를 선택합니다. 검토된 초기 데이터만 빈 새 데이터베이스에 적재하고 최초 관측을 저장합니다. 이미 자료가 있는 DB는 HTTP 409로 거부하며 덮어쓰지 않습니다.
6. 새 주소에서 데이터 기준일, 수집 공백, 프로젝트 목록, 절차별 평가와 최초 관측을 확인합니다. 과거 관측이 없던 날짜에는 자료 없음이 표시되어야 합니다.

배포는 수동 실행이며 기본 브랜치에서만 가능합니다. 후속 코드 수정도 Codex에서 검증한 뒤 GitHub에 반영하고 같은 배포 워크플로를 실행합니다. 매번 초기 데이터 적재를 선택하지 않습니다.

`npm run cf:configure`는 저장소의 `wrangler.jsonc`와 환경변수를 바탕으로 로컬 임시 설정 `wrangler.deploy.json`을 생성합니다. 생성된 계정별 설정을 저장소에 커밋하지 않습니다. 마이그레이션은 Wrangler 명령으로 적용하며, API 요청이 스키마를 만드는 구조가 아닙니다.

## 4. 정기 수집 활성화

초기 데이터와 URL 확인 후 `ENABLE_GRID_ATLAS_REFRESH=true`를 설정합니다. 활성화 또는 주기 값을 바꾼 뒤에는 **Grid Atlas deploy (manual)**을 초기 적재 선택 없이 다시 실행해 사이트의 일정 표시에도 반영합니다. 이후 **Grid Atlas collection**을 수동 실행하고 `run_refresh`를 선택해 실제 수집 보고서를 먼저 확인합니다. 토큰·URL이 없으면 수집을 실행하지 않으며 설정 누락으로 실패합니다. 활성화 값이 없거나 `false`이면 수집 작업이 건너뛰어지고 **Disabled**라고 기록됩니다.

- `weekly`: 매주 월요일 **한국시간 09:00** 예약
- `monthly`: 매월 1일 **한국시간 09:00** 예약

두 cron 중 선택한 주기만 실행됩니다. 사이트의 일정 설정 표시는 배포 시의 선언이며 실행 성공의 증거가 아닙니다. 실제 최근 실행 시각과 상태를 함께 확인합니다. GitHub 예약 작업은 기본 브랜치에서 실행되고 혼잡 시 지연되거나 누락될 수 있습니다. 정확한 시각이나 실행 보장이 필요한 운영에는 별도 모니터링과 작업 실행 서비스가 필요합니다. 저장소에서 Actions를 허용하고 예약 작업이 비활성화되지 않았는지도 확인합니다.

현재 수집기는 NYISO 개별 수용가 원장과 LBNL 발전·저장 활성 신청 원장을 검증·정규화합니다. LBNL은 공식 목록에서 원장 파일을 찾아 목록과 파일을 각각 보관하며, 검증된 원장의 기준일은 2025년 12월 31일입니다. 매주 또는 매월 수집해도 새 판이 발행되지 않으면 이 기준일은 그대로 유지됩니다. 두 출처가 모두 검증·적재되면 실행이 성공할 수 있지만, 이는 전국의 모든 신청이나 나머지 수용가 출처가 갱신됐다는 뜻이 아닙니다. 새 판의 필드·범위 변경 또는 다운로드 실패는 출처별 오류로 남기고 기존 정상 자료를 보존합니다. 자세한 포괄 범위는 [DATA.md](DATA.md)를 확인하세요.

## 로컬 개발

명령 실행 위치는 저장소 루트가 아닌 `apps/grid-atlas`입니다. Node.js 24와 Python 3이 필요합니다. Cloudflare 계정 없이도 개발과 검증을 진행할 수 있습니다.

```sh
npm ci
npm run dev
```

로컬 API는 `127.0.0.1:8789`, 화면은 `127.0.0.1:5175`를 사용합니다. 클라우드 작업공간의 포트가 외부에 공개되어 있다는 뜻은 아닙니다. 사용 가능한 브라우저 미리보기 경로 또는 실제 배포 주소를 사용합니다.

계정 연결 전에는 실행 중인 로컬 API와 빌드한 화면을 하나의 읽기 전용 HTML 파일로 내보낼 수 있습니다.

```sh
npm run build
node scripts/export-preview.mjs --output .state/grid-atlas-preview.html
```

생성한 파일을 내려받아 브라우저에서 열면 필터·목록·상세 내용을 확인할 수 있습니다. 배포된 사이트가 아니며 평가 저장·정기 수집·갱신 기능은 실행되지 않습니다. 필요한 실행 순서와 포함 범위는 [PREVIEW.md](PREVIEW.md)를 확인하세요.

```sh
npm run typecheck
npm test
npm run test:python
npm run build
```

수집과 복구의 세부 규칙은 [OPERATIONS.md](OPERATIONS.md)를 참고합니다.
