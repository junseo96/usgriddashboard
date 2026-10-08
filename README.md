# Grid Atlas · 미국 계통접속 관측소

[![Grid Atlas checks](https://github.com/junseo96/usgriddashboard/actions/workflows/grid-atlas-check.yml/badge.svg)](https://github.com/junseo96/usgriddashboard/actions/workflows/grid-atlas-check.yml)

발전원·저장전원·수용가의 계통접속 신청을 모으고, 절차별 진행 근거와 병목점수, 수집 공백, 시점별 이력을 확인하는 대시보드입니다. 애플리케이션은 **[`apps/grid-atlas`](apps/grid-atlas)**에 있습니다.

**[대시보드 열기](https://junseo96.github.io/usgriddashboard/)** — 프로젝트 검색·CSV, 7개 ISO/RTO 부하·일별 피크 비교, 수용가 파이프라인을 제공합니다. 실측 부하는 15분 목표의 GitHub Actions 일정으로 수집·게시하며, 평가 저장은 별도 서버가 필요합니다.

![Grid Atlas 실제 로컬 화면](apps/grid-atlas/docs/assets/dashboard.png)

## 현재 상태

- 새 대시보드, 프로젝트 검색·필터·상세·CSV, 절차별 평가 입력, 관측 이력 구현.
- NYISO 수용가 원장과 LBNL 발전·저장 원장의 수집·검증·적재 구현.
- CAISO·ERCOT 5분 관측과 나머지 5개 ISO/RTO의 EIA 시간별 보고 부하, 최근 7일의 현지일 피크를 발전·저장·수용가 신청 용량과 비교합니다. 출처의 관측 주기와 게시 지연을 함께 표시합니다.
- 전국 개요 첫 화면에서 ISO/RTO별 수용가 요청·파이프라인을 비교합니다. ERCOT 전체 요청과 PPL·PG&E 등 회사별 부분 집계를 구분하며, NYISO 14.23 GW를 전국 수용가 총량으로 표시하지 않습니다.
- 수용가 탐색에 980개 출처·사례 행과 52개 별도 집계를 추가했습니다. 활성 신청 수가 아니며, 신청·계약·발표·사업자 목록·송전 지원·과거 기록을 구분합니다.
- 원장·참고 자료 13,182건 중 미국 본토 활성 개별 신청 8,513건 집계. 발전·저장 복합 신청은 전체 분모에서 한 번만 집계합니다.
- 실제 요건별 근거 평가는 아직 0건이므로 평균 점수는 **미산출**입니다. 미공개를 미진행 100점으로 간주하지 않습니다.
- GitHub Pages 조회용 사이트 게시 완료. 실제 공개 주소에서 검색·상세·CSV·모바일 화면을 검증했습니다. **평가 저장을 위한 Cloudflare 서버 배포와 주간·월간 수집은 아직 가동되지 않았습니다.**

전국 수용가의 전수 분모와 수집 공백은 해결되지 않았습니다. 현재 검증된 활성 수용가 신청은 NYISO 53건입니다. LBNL 원자료 기준일은 **2025-12-31**이며, 2026-10-08에 내려받았다고 기준일이 바뀌지 않습니다. 자세한 내용은 [데이터 출처·범위](apps/grid-atlas/docs/DATA.md)를 참고하세요.

53건은 미국 전체 대형 수용가 수가 아닙니다. [수용가 파이프라인](apps/grid-atlas/docs/LOAD_PIPELINE.md)에는 실명 사례 44건과 ERCOT·Oncor·PPL 등 공식 집계도 포함됩니다. 업체별 범위가 겹치고 계약·계획 단계가 달라 전국 합계로 더하지 않습니다.

## 실행

Node.js **24 이상**, Python **3.12**를 사용합니다. Cloudflare 계정 없이 로컬에서 실행할 수 있습니다.

```sh
git clone https://github.com/junseo96/usgriddashboard.git
cd usgriddashboard/apps/grid-atlas
npm ci
npm run dev
```

최초 실행 때 포함된 공식 자료를 로컬 SQLite에 적재합니다. 이후 실행은 기존 평가와 관측을 보존합니다. 실제 실행 주소는 터미널에 표시됩니다. 로컬 데이터와 비밀값은 Git에 포함하지 않습니다.

```sh
npm run typecheck
npm test
npm run test:python
npm run build
```

## 병목점수

기술 검토, 계약·비용·보증, 부지·인허가, 설비·계통 보강, 통전·운영 승인의 **5개 독립 요건**을 평가합니다.

각 요건의 잔여점수는 `20 × (1 − 진행률)`입니다. 모두 미진행으로 확인되면 100점, 모두 통과하면 0점입니다. 뉴스에 근거한 추정은 원문 URL·적용일·확인시각·판단 이유와 함께 기록합니다. 자동 뉴스 평가 기능은 아직 없습니다.

모든 요건을 평가한 적격 신청의 점수를 동일 가중 평균으로 계산합니다. 미공개는 별도 집계하며, 점수는 지연 기간이나 완공 확률을 뜻하지 않습니다. 원장이 없는 과거 날짜를 현재 자료로 채우지 않습니다.

## 운영·개발 안내

- [GitHub Pages 조회용 사이트 게시](apps/grid-atlas/docs/PAGES.md)
- [실측 부하·일별 피크의 출처와 갱신](apps/grid-atlas/docs/DEMAND.md)
- [수용가 파이프라인의 범위와 용량 기준](apps/grid-atlas/docs/LOAD_PIPELINE.md)
- [ISO/RTO별 대표 지표·공개 범위·원문](apps/grid-atlas/docs/REGIONAL_LOAD.md)
- [앱 구조와 시점 조회 규칙](apps/grid-atlas/README.md)
- [Cloudflare 계정 연결·배포](apps/grid-atlas/docs/DEPLOYMENT.md)
- [주간·월간 갱신과 원문 보존](apps/grid-atlas/docs/OPERATIONS.md)
- [읽기 전용 HTML 내보내기](apps/grid-atlas/docs/PREVIEW.md)
- [초기 구축 검증 기록](apps/grid-atlas/docs/STATUS_2026-10-08.md)

React/Vite 화면과 Worker API, D1 데이터베이스로 구성합니다. 개발 환경에서는 같은 SQL 스키마의 SQLite를 사용합니다. GitHub Pages 같은 정적 호스팅만으로 평가 저장 API와 데이터베이스가 실행되지는 않습니다. 관리자 키는 GitHub Secrets와 배포 환경에만 설정하며 채팅이나 저장소에 넣지 않습니다.

GitHub Pages 게시와 부하 수집은 Cloudflare 계정 없이 실행됩니다. 발전·저장 신청 원장과 수용가 조사 자료는 검토한 게시 자료를 사용하며, 실측 부하만 별도 일정으로 갱신합니다. 프로젝트 원장의 주간·월간 자동 적재와 평가 저장은 별도 운영 설정이 필요합니다.

공개 원자료의 권리와 이용 조건은 각 출처를 따릅니다. 이 저장소는 출처별 날짜·링크와 미확보 항목을 함께 보존합니다.
