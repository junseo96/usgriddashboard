# 공식 대형 수용가 시설 발굴과 갱신

`Grid Atlas facility discovery`는 운영사·고객·공공기관의 공개 목록을 실제로 다시 내려받고 파싱하여 시설을 추가한다. 기존 URL의 바이트만 비교하는 `Grid Atlas census source monitoring`과 별도 작업이다. 확인된 시설·캠퍼스·계획 사업은 계통접속 신청번호가 없어도 시설 목록에 포함하며, 접속신청·계약·통전 근거는 별도 필드로 보존한다.

전국 모든 시설의 완전한 목록이나 모든 기관의 자동 수집을 보장하지 않는다. 자동 발굴은 `scripts/facility-sources/`에 구현된 공식 출처에 한한다. 운영사 한 곳의 전체 시설 목록, 특정 산업 공개 목록과 전국 전체 프로젝트는 서로 다른 모집단이다.

## 실행

기본 일정은 매주 월요일 **10:10 KST**다. 저장소 Actions → **Grid Atlas facility discovery** → **Run workflow**에서 `all`, `operators`, `hyperscale`, `industrial` 중 수집할 그룹을 선택할 수 있다. GitHub 일정은 지연될 수 있으므로 최근 실행 결과를 함께 확인한다.

앱 디렉터리에서 로컬 실행:

```sh
python3 scripts/collect-large-load-facilities.py
python3 scripts/collect-large-load-facilities.py --source operators
```

각 수집기는 다음 인터페이스를 사용한다.

```sh
python3 scripts/facility-sources/operators.py --output /path/to/operators.json --state-dir /path/to/acquisition
```

일부 고객·공공기관 PDF의 사실 추출에는 `pdftotext`가 필요하다. Ubuntu의 `poppler-utils` 패키지가 제공하며 workflow에서 설치한다. 로컬에 없으면 해당 PDF의 단계 추출은 실패·미확인으로 남고 기존 정상 자료를 유지한다.

`--output`에 이전 자료가 있으면 수집기가 출처별 마지막 정상 자료를 복원한다. 총괄 실행기는 기존 세 그룹의 fragment를 임시 디렉터리에 복사한 뒤 수집기를 호출하므로, 검증 전 자료가 공개 원장을 덮어쓰지 않는다. 그룹별 시간 상한은 기본 12분이며 `--parser-timeout`으로 1~1,200초 범위에서 조정할 수 있다.

실제 공개 파일을 바꾸지 않는 시험은 입력 fragment를 별도 디렉터리에 먼저 복사하고 모든 출력 경로를 지정한다.

```sh
mkdir -p /tmp/grid-atlas-facility-smoke/fragments
cp data/large-load-facility-fragments/*.json /tmp/grid-atlas-facility-smoke/fragments/
python3 scripts/collect-large-load-facilities.py --source operators \
  --fragments /tmp/grid-atlas-facility-smoke/fragments \
  --output /tmp/grid-atlas-facility-smoke/large-load-facilities.json \
  --observations /tmp/grid-atlas-facility-smoke/observations.json \
  --report /tmp/grid-atlas-facility-smoke/report.json \
  --state-dir /tmp/grid-atlas-facility-smoke/acquisition
```

## 신규 발견과 변경 관측

- `data/large-load-facility-fragments/*.json`: 파싱한 시설, 실제 원문 URL·취득시각·SHA-256, 기존 출처가 명시한 날짜와 용량 단위.
- `data/large-load-facilities.json`: 공통 빌더가 검증·연결한 공개 시설 목록.
- `data/large-load-facility-observations.json`: 총괄 수집기가 실제 비교해 발견한 신규 시설·생애주기 변경·상세 변경의 누적 관측 이력.
- `data/large-load-facility-collection.json`: 가장 최근 실행의 출처 그룹별 성공·부분 성공·실패와 신규/변경 건수.
- `.local/facility-collection/runs/<runId>/`: 출처별 상세 보고서, 원문 취득물, stdout/stderr, 전체 실행 보고서. 공개 저장소에는 넣지 않는다.

`facility_discovered`는 이번 실행에서 목록에 새로 연결한 시설이라는 뜻이다. `lifecycle_changed`는 직전 정상 자료와 다른 상태를 실제로 관측했다는 뜻이다. 두 경우 모두 `observedAt`을 착공일·신청일·통전일로 바꾸지 않는다. 실제 사건 날짜가 원문에 있을 때만 시설의 `events`에 기록한다. 과거 사건을 뒤늦게 확인한 경우 사건일과 관측일을 각각 유지한다.

원문 해시·취득시각·근거 식별자만 바뀌고 시설의 사실은 그대로이면 진행 변경으로 기록하지 않는다. IT 전력, 시설 전력, 요청 전력, 현장 발전의 단위를 구분하며 회사 전체 용량을 개별 시설에 배분하지 않는다. 원자료에 없는 용량과 관할 권역은 미확인으로 보존한다.

## 실패 보존과 게시

수집기에 실패가 있으면 해당 출처의 이전 시설·근거를 유지한다. 목록에서 시설이 사라졌다는 이유만으로 삭제·취소·철회를 확정하지 않는다. 이전 시설 ID를 누락한 그룹 출력은 총괄 실행기가 거부한다. 빈 목록·근거 없는 수집시각·해시 누락·부서진 출처 참조도 검증 실패다.

정상 후보가 하나 이상 있으면 전체 시설 빌더로 staging 자료를 검증한다. 빌더가 거부하면 공개 fragment, 시설 원장과 관측 이력을 유지한다. 부분 성공은 `partial`로 기록하고 정상 그룹만 갱신한다. 모든 요청 그룹이 실패하거나 전체 검증에 실패하면 종료 코드 1, 원장은 유지하며 실패 보고서는 남긴다. 개별 사이트의 403 등 접근 거부를 우회하지 않는다.

GitHub workflow는 공통 데이터 검증·타입 검사·테스트·빌드 후 시설 관련 JSON만 `main`에 커밋한다. 별도 API 토큰이나 Cloudflare 쓰기 권한은 필요하지 않으며 GitHub가 제공하는 작업 토큰의 `contents: write`, `actions: write`를 사용한다. 보호 브랜치 정책이나 Actions 쓰기 제한이 있으면 게시 단계가 실패하므로 해당 실행의 오류를 확인한다. 동시 `main` 변경으로 push가 거절되면 강제 덮어쓰지 않고 다음 실행에서 최신 자료로 다시 수집한다.

GitHub 작업 토큰의 push는 다른 workflow를 자동 시작하지 않을 수 있으므로 커밋 후 `grid-atlas-pages.yml`을 명시적으로 실행한다. 수집 성공, 데이터 커밋 성공, Pages 배포 성공은 별도 결과다. 전체 취득 실패도 가능한 실패 보고서를 게시한 뒤 작업을 실패로 표시한다. 최초 게시에는 검증된 기존 시설 원장이 필요하다.

원문·보고서 artifact는 90일 보존한다. 커밋된 관측 이력은 이후 실행에서도 추가 보존되지만 원문 바이너리의 영구 보관을 대신하지 않는다. 새 운영사나 목록을 추가하려면 파서와 출처 범위를 구현·검증해야 한다. 기존 URL 감시만 추가해서는 신규 시설 발굴이 활성화되지 않는다.

## 검증

```sh
python3 -m unittest discover -s tests -p test_facility_collection.py
python3 -m unittest discover -s tests -p test_pipeline.py
```

시설 수집 검증은 신규 시설 추가, 상태 변경과 취득시각의 분리, 근거만 달라진 경우의 오탐 방지, 실패 출처 보존, 목록 누락과 전체 빌더 실패를 확인한다. 네트워크 연결 없이 재현 가능한 테스트이며 실제 사이트 취득 성공은 실행 보고서로 별도 확인한다.
