# 송전 운영 관측

`송배전 제약 → 송전`의 기본 화면이다. 연간 혼잡 정산액은 **연간 시장보고서**의 보조자료로 남긴다. 7개 ISO/RTO의 실제 수치·기간·공백을 표시하며 출처 링크만으로 운영 지표 수집 완료를 주장하지 않는다.

## 산식과 분모

| 지표 | 산식 | 범위 |
| --- | --- | --- |
| 제약 발생시간 | 시설+contingency의 binding/breached 시간 합집합 ÷ 검증한 관측시간 | 시장 급전을 제한한 모델 제약. 동시 제약시간을 권역 시간으로 더하지 않음 |
| 혼잡가격 격차 | 노드별 시간 평균 MCC를 먼저 구한 뒤 동일 UTC 시간의 선형 P90−P10 | 에너지·손실 성분 제외. 부하구역·물리 노드·전기 버스·공개 위치·허브 분리 |
| 운영한도 대비 이용률 | 같은 시각·시설·contingency·방향의 흐름 ÷ 운전한도 ×100 | ERCOT은 SCED 효력기간 가중, NYISO는 순간표본 평균·최대 |
| 송전 원인 출력제한 | 공식 Local congestion으로 분류된 실제 MWh | 현재 CAISO 태양광·풍력. System 사유와 잠재발전량 차이는 제외 |

분위수는 노드 동일 가중 Type 7 선형 보간이며 부호 있는 MCC를 사용한다. 각 노드의 시간 평균은 완전한 60분 원자료가 필요하다. 5분 공간 격차를 평균한 값을 시간당 노드 평균의 격차로 바꾸지 않는다. 완전히 빠진 노드는 후보 수에서 검출되지 않을 수 있으므로 위치 수를 전력망 전수 확보율로 부르지 않는다.

권역 일평균은 확인된 시간만 가중한다. 통합 지수는 **같은 시장·위치 분류·UTC 날짜의 24시간 가격과 같은 24시간 실제 부하**가 모두 있는 권역만 `Σ(권역 일평균 격차 × 실제 MWh) / Σ실제 MWh`로 계산한다. 포함 권역과 분모를 각 점에 기록한다. 비ISO 지역은 분모에 없다. 권역마다 노드 분할 방식이 달라 동일한 물리 혼잡률이나 사회적 비용이 아니다. 동일 권역 구성을 선택해 가변 모집단의 영향을 구분한다.

한 구간이 검증한 24시간 중 8시간 binding이면 33.3%다. 두 구간이 같은 8시간에 binding이어도 권역 고유 발생시간은 8시간이다. 실패한 파일·빠진 시간은 0으로 만들지 않는다. 특정 제약의 미발생은 해당 기간의 완전한 이벤트 보고를 확인한 범위에서만 계산한다.

## 권역별 공식 원자료

| 권역 | 가격 | 제약·이용률·출력제한의 범위 |
| --- | --- | --- |
| CAISO | OASIS RTM 5분 MCC, PG&E·SCE·SDG&E 3개 DLAP | RTM nomogram/branch 제약에 WEIM 포함. CAISO 내부선로 전용 통계 아님. Local 출력제한은 태양광·풍력 |
| ERCOT | 약 19,500 전기 버스의 uncapped LMP−동시 uncapped system lambda; 공식 SCED 초 가중 | 동일 제약쌍의 shadow price·flow/limit. 열정격 전체 원격계측 아님. MIS 보관기간 이전은 공백 |
| PJM | 공식 공개 LMP 지도 21개 송전 존 MCC 스냅샷 | 시장시각 미공개. 취득시각을 관측시각으로 바꾸지 않고 시간/일 평균·통합 지수에서 제외. 과거 Data Miner 인증 필요 |
| MISO | 공식 시간당 RT MCC의 Loadzone 분류 | 일별 5분 transmission binding, reserve 제외. 원문 고정 EST·interval-ending 적용 |
| SPP | BAA SPP의 고유 PNODE, SWPW 제외·정산지점 중복 제거 | BINDING/BREACHED만 포함, ACTIVATED 제외. 흐름이 없어 이용률 미산출. 일별 가격 공개 지연 존재 |
| NYISO | 시간당 11개 부하구역 MCC | 시설+contingency 제약. 보고 인터페이스 흐름/방향별 한도의 순간표본 비율이며 선로 실측·열정격 이용률로 확인된 값이 아님. 원문 MWH 열표기 보존. SCH 계열·충돌·0/±9999 한도 제외 |
| ISO-NE | RT Congestion, 같은 날 공식 분류의 NETWORK NODE·8개 LOAD ZONE 분리 | 공개 final 5분 송전 constraint, SYSTEM reserve 제외. final 미게시 기간은 공백 |

일별 차트는 UTC 00–24시로 통일한다(KST 당일09시–다음날09시). 원문의 UTC offset·공식 고정 시간대를 적용하며 모호한 DST 시각은 임의 배정하지 않는다. 수집대상 운영일·실제 관측시각·취득시각을 구분한다. 최신 수치와 기간은 화면·CSV·`coverage`를 기준으로 한다.

PJM에서 중앙80% 격차가 0이어도 일부 존의 차이는 있을 수 있어 최솟값·최댓값도 보존한다. 이용률 100%를 초과한 유효 모델 관측은 잘라내지 않는다. NYISO 순간표본의 기술상 1초 저장 구간은 관측 지속시간을 뜻하지 않는다.

## 저장·매일 갱신

- 어댑터: `scripts/transmission_*.py`; 공통 산식: `transmission_common.py`, `collect-transmission.py`.
- 정규화 원관측: `data/transmission-fragments/`. 권역·UTC ISO 주 단위로 분할해 파일당 16MiB 이하로 저장한다. 원래 행 순서를 보존하며 메타데이터를 원자적으로 교체한다. 과거 관측은 유지하고 수정 원문은 SHA별 출처 버전으로 연결한다.
- 공개 집계: `data/transmission-observations.json`. 시간값·일평균·통합 지수·시설별 제약·이용률·출력제한·7×5 수집상태표를 포함한다.
- 원문은 `.local/transmission/`에 저장한다. Git에는 원본 파일이나 비밀값을 넣지 않는다. Actions는 새 원문 해시의 바이트와 영수증을 14일 보관 아티팩트로 제공하며 정규화 이력은 저장소에 남긴다.
- `grid-atlas-transmission.yml`은 매일 **17:35 KST** 목표로 최근 14개 운영일을 재조회한다. 공개 지연·보관기간을 바꾸지 않으며 미게시 날짜는 공백이다. 실패 시 이전 검증 관측과 원래 취득시각을 보존한다.
- 검사 후 해당 데이터만 커밋하고 Pages를 호출한다. 동시 main 변경에는 강제 푸시하지 않는다. 일정 정의·실행·수집 성공·배포 성공은 별도 확인한다.

```sh
python3 -m pip install -r requirements.txt
python3 scripts/collect-transmission.py --days 14 --refresh
python3 scripts/collect-transmission.py --assemble-only --start 2026-07-15 --end 2026-10-12
npm run data:transmission:check
```

`--check`는 네트워크 없이 보존된 정규화 원관측에서 지표를 재산출해 일치 여부를 검사한다. [CAISO·ERCOT 세부 정의](TRANSMISSION_WEST.md)를 함께 참고한다.
