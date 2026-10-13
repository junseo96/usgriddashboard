# CAISO / ERCOT 운영 원자료 수집

`scripts/transmission_west.py`는 공개 공식 보고서만 사용하며 API 키나 인증을 요구하는 과거 아카이브를 우회하지 않는다. 생성된 fragment는 `scripts/collect-transmission.py`의 일별·권역별 집계 입력이다. 시간 구간은 UTC `[start,end)`이고 요청 날짜는 각 권역의 현지 운영일이다.

```sh
python scripts/transmission_west.py --start 2026-09-13 --end 2026-10-12
python -m unittest discover -s tests -p test_transmission_west.py
```

`--refresh`는 공개 원자료를 재취득한다. 기본 실행은 같은 URL의 검증된 로컬 캐시를 사용하므로 ERCOT 신규 문서 목록 갱신에는 `--refresh`가 필요하다. URL별 최신 캐시 외에 기존·정정 원문을 모두 `.local/transmission/west/history/by-sha256/<sha256>.raw`와 메타데이터로 보존한다. source에는 공식 URL, 실제 취득시각, SHA-256, 보고 기준일을 담는다. 실패한 날짜는 별도 notes/coverage와 실제 확보 시간으로 노출하고 0으로 만들지 않는다.

## CAISO

- OASIS `PRC_INTVL_LMP`, RTM, `LMP_TYPE=MCC`: PG&E·SCE·SDG&E의 세 DLAP에 한정한다. 5분 가격을 부호 그대로 노드별 60분 평균한 뒤 세 노드의 선형 P90−P10을 계산한다. 모든 물리 노드, 부하 가중 분위수, 5분 공간 분산의 단순 평균이 아니다.
- `SLD_FCST`, `MARKET_RUN_ID=ACTUAL`, `TAC_AREA_NAME=CA ISO-TAC`, `Total Actual Hourly Integrated Load`: 공식 시간 통합 실제 부하이다. EIM의 다른 BAA와 개별 TAC 소계를 더하지 않는다. 1시간 MW가 해당 구간의 MWh 분모가 된다.
- `PRC_RTM_NOMOGRAM`: 공식 5분 제약쌍의 shadow price가 0이 아닌 효력 구간을 이용한다. 동일 제약의 반복 GROUP 행은 중복 제거한다. **CAISO가 운영하는 RTM 보고 범위에는 WEIM도 포함**되며 응답에는 BAA/소유권 필터가 없다. CAISO 내부 선로로만 간주하지 않는다. Intertie는 이 수집기의 범위 밖이고, 선로 flow/limit은 이 가격 보고서에서 만들지 않는다.
- `https://www.caiso.com/documents/daily-renewable-report-{mmm-dd-yyyy}.html`: 공식 HTML의 날짜를 검사하고 `curt_hr_tot_{solar|wind}_{econ|ss|oi}_local_mwh` 여섯 배열만 시간별 합산한다. 보고서는 Local을 `mitigate local congestion`으로 정의한다. System 사유, 최대 MW, 월별 누적 배열은 제외한다. NA는 결측이다. 아직 발행되지 않은 최근 운영일은 공백으로 남는다.

CAISO 전력량, 세 DLAP 가격, WEIM 포함 제약 보고서는 서로 다른 공간 범위다. Binding 지속시간에 CA ISO-TAC MWh를 물리 선로 노출량처럼 붙이지 않는다.

## ERCOT

공개 문서 목록은 `https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId=…`, 공개 원문은 `https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId=…`에서 가져온다. `SecurityStatus=P`인 CSV ZIP만 처리한다.

- **11485**: SCED별 Electrical Bus의 `UncappedLMP`.
- **13114**: 정확히 같은 SCED 시각의 `UncappedSystemLambda`.
- **12302**: SCED Shadow Prices and Binding Transmission Constraints. ConstraintName+ContingencyName의 ShadowPrice, Value, Limit.
- **12340**: System-Wide Demand의 15분 실제 평균 MW와 TimeEnding.

가격 비교는 동일 SCED의 `UncappedLMP−UncappedSystemLambda`를 사용한다. VOLL 캡으로 잘린 노드 가격과 lambda를 빼거나 reliability adder를 포함한 15분 정산가격을 혼잡 성분으로 사용하지 않는다. 전체 공개 전기 버스 풀을 사용하되 시간 내 결측 버스는 제외하고 후보/완전 버스 수를 보존한다.

ERCOT Nodal Protocols Section 6(2026-08-28 발효)은 가격 효력 시각을 게시하고 §6.6.1.1의 TLMP를 SCED interval의 **초 단위 지속시간**으로 정의한다. SCED 시각은 정각 5분이 아니므로 다음 실제 공개 SCED 시각까지의 지속초로 각 버스 시간평균을 계산한 뒤 P90−P10을 취한다. 효력 구간 누락, 10분 초과 공백, 미확보 노드를 임의로 연장하지 않는다. 완전한 60분의 버스가 2개 미만이면 시간 가격 분산을 만들지 않는다. 10분 연속성 상한은 공식 SCED 길이 단정이 아닌 보수적 수집 검증 규칙이다.

제약의 경제적 binding은 `ShadowPrice>0`으로 정의한다. 0의 shadow price가 있다고 물리 제약 자체가 없다고 단정하지 않는다. 이용률은 **같은 SCED 제약쌍의 방향성 모델 flow(Value) / 양의 Limit**이고 음의 반대 방향 flow는 제외한다. 이것은 모든 물리 선로의 열정격 대비 원격계측 흐름이 아니다. 제약 행과 SCED 효력시각을 함께 확보한 구간만 지속시간에 포함한다. 미확보 보고서 구간을 무혼잡으로 채우지 않는다.

2026-10-13 취득 시 SCED 가격 목록은 약 5일, 시간별 제약·부하 목록은 약 7일의 순환 보관이다. 30일을 요청해도 이전 날짜를 복원할 수 있다는 뜻이 아니다. 원문·정규화 이력을 매일 보존해 이후 시계열을 늘린다. 송전 원인이 명시된 해당 기간 출력제한 MWh는 아직 연결하지 않았으며, 발전 잠재량과 실적의 차이를 송전 출력제한으로 대체하지 않는다.

테스트는 시간평균과 공간 분위수의 계산 순서, 부호 보존, SCED 초 가중·경계·결측, capped/uncapped 동시각 조인, 24:00와 DST 반복시각, 원인별 MWh, 제약 중복, 원문 정정본의 해시 보존을 검증한다.
