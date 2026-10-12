# 수용가 조사 출처의 정기 점검

`Grid Atlas census source monitoring` 워크플로는 `data/load-project-census.json`의 근거 URL을 다시 내려받아 바이트 변경 여부를 확인한다. 유틸리티 공급 신청·PUC/PSC 심사·송전계획·고객 공시의 근거를 같은 방식으로 점검한다. 이는 모든 사업자 웹사이트 탐색이나 프로젝트 원장의 자동 갱신과 구분된다. 신규 문서 발견, 고객 식별, 중복 판단, 용량·진행 상태 해석은 별도 검토가 필요하다.

## 일정과 실행

기본 일정은 매주 월요일 **09:35 KST**다. 저장소 Actions 변수 `GRID_ATLAS_CENSUS_CADENCE`를 `monthly`로 설정하면 매월 1일 **09:35 KST**만 실행한다. 변수 미설정 또는 다른 값은 주간 일정이다. Actions의 `Grid Atlas census source monitoring` → `Run workflow`로 기본 브랜치에서 수동 실행할 수도 있다. 일정 등록·예약 실행 성공·개별 원문 취득 성공은 서로 다른 상태이며, GitHub 일정은 지연되거나 저장소 비활성으로 중단될 수 있다.

수동 실행의 `max_sources`는 1–2,000 사이 정수이며 기본값은 1,000이다. 첫 연결 시험은 `12`처럼 작은 값으로 실행할 수 있다. 예약 실행은 항상 기존 한도 1,000개를 유지한다. 수동 한도를 줄이면 나머지 URL은 `skipped_limit`로 남으며 전체 수집 성공으로 표시하지 않는다.

```sh
gh workflow run grid-atlas-census-sources.yml --ref main --field max_sources=12
```

이 워크플로는 `contents: read`만 사용하고, 운영 API나 DB에 쓰거나 커밋·배포하지 않는다. 기존 프로젝트 원장 적재 워크플로의 활성화 변수·API 비밀값은 사용하지 않는다.

로컬 재현은 앱 디렉터리에서 실행한다.

```sh
python3 scripts/check-load-census-sources.py

# 적은 수의 URL만 점검하는 별도 시험. 운영 비교 상태와 분리한다.
python3 scripts/check-load-census-sources.py --max-sources 3 --workers 1 --state-dir /tmp/grid-atlas-census-monitor-smoke

python3 -m unittest discover -s tests -p 'test_load_census_source_check.py'
```

## 결과 해석

| 상태 | 의미 |
| --- | --- |
| `baseline` | 이 모니터가 처음 정상 취득한 바이트. 과거에 비해 변경됐다고 판정하지 않는다. |
| `unchanged` | 이 모니터의 직전 정상 취득 바이트와 SHA-256이 같다. 프로젝트 상태가 동일하다는 판정은 아니다. |
| `changed` | 직전 정상 취득과 바이트가 다르다. 문서 검토 전에는 프로젝트 진척으로 해석하지 않는다. |
| `fetch_failed` | HTTP 오류, DNS·TLS·네트워크 오류, 잘린 응답, 크기 제한 등으로 취득하지 못했다. |
| `blocked_url` | HTTPS 공개 주소 요건을 충족하지 않거나 사설 주소로 연결된다. 요청하지 않는다. |
| `skipped_budget` / `skipped_limit` | 실행 시간·총 다운로드·대상 수 한도 때문에 미점검이다. 다음 실행은 미점검 또는 오래된 URL부터 시작한다. |

기존 조사에 저장된 `sha256`·`retrievedAt`·`sourceAsOf`는 과거 근거로 보고서에 보존하며 새 다운로드의 비교 기준으로 자동 채택하지 않는다. 실제 새 바이트의 `retrievedAt`과 `sha256`만 새 관측에 기록한다. 취득에 실패하면 이전 정상 관측의 시각·해시를 그대로 보존한다. 공개 원자료 기준일을 실행일로 바꾸지 않는다.

첫 취득과 변경은 `reviewRequired: true`다. 다음 실행에서 바이트가 같아도 미검토 상태를 자동 해제하지 않는다. 이 필드는 원문 검토 완료 여부를 대신하는 승인 장부가 아니며, 프로젝트 자료를 수정하지 않는다. 동적 HTML의 광고·날짜·메뉴 변경도 바이트 변경을 만들 수 있다. 반대로 고정 PDF가 같아도 다른 URL에 새 문서가 발표될 수 있다.

`.local/census-source-monitor/runs/<실행시각>/report.json`은 실행 보고서, `state.json`은 URL별 마지막 정상 바이트 관측, `latest-report.json`은 최근 보고서다. GitHub는 실행별 보고서와 상태를 **90일 artifact**로 보존하고, 다음 실행용 상태·최근 보고서를 캐시한다. 캐시가 만료·삭제되면 새 기준선을 만든다. 장기 보존이 필요하면 artifact를 별도 보관해야 한다. 다운로드 원문 바이트는 이 모니터에 저장하지 않으며 기존 검토 조사 원문 보관과 구분한다.

기본 한도는 최대 1,000개 고유 URL, 동시 3건·같은 호스트 1건, 요청당 25초, 원문당 20 MiB, 실행 전체 192 MiB·13분이다. 워크플로는 18분 상한을 둔다. 공개 HTTPS만 요청하고 DNS 응답·리다이렉트의 사설 주소를 차단하며 검증한 IP로 연결하고 원래 호스트의 TLS 인증서를 확인한다. 프록시 환경변수·인증·쿠키·차단 우회·재시도는 사용하지 않는다. 403은 그대로 실패로 기록한다.

일부 URL만 성공하면 실행 보고서는 `partial`이며 그 결과를 보존한다. 적어도 하나 정상 취득하면 명령은 성공 종료하므로 Actions의 초록 표시가 전체 URL 수집 성공을 뜻하지 않는다. 모두 실패하면 실패 종료하지만 가능한 실행 보고서와 마지막 정상 상태는 보존한다.
