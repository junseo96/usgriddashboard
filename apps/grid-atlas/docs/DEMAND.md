# ISO/RTO 실측 부하와 일별 피크

수요 관측은 프로젝트 신청 용량과 별도 데이터셋인 `data/grid-demand.json`에 보관한다. 실제 전력 사용은 MW, 프로젝트 신청 용량도 MW로 비교할 수 있지만 같은 의미가 아니다. 발전 신청은 예정 발전 출력, 저장 신청은 출력 용량으로서 충전 부하 또는 MWh가 아니며, 수용가 신청은 실제 동시 사용량이 아니다. 발전·저장·수용가 용량을 하나의 신청 부하로 합산하지 않는다. 운영기관별 계측 경계와 신청 원장의 사업 지역도 완전히 일치한다고 보장하지 않는다.

## 공식 원문과 측정 주기

| 권역 | 최신 부하 출처 | 측정 간격·범위 |
| --- | --- | --- |
| CAISO | [Today's Outlook](https://www.caiso.com/todays-outlook/demand) | 공식 `Current demand` 5분 관측, 현지 최근 7일 CSV |
| ERCOT | [Supply and Demand](https://www.ercot.com/gridmktinfo/dashboards/supplyanddemand) | 공식 `forecast=0` 5분 관측, 현재 현지 운영일 |
| ISO-NE, MISO, NYISO, PJM, SPP | [EIA-930 Grid Monitor](https://www.eia.gov/electricity/gridmonitor/) | 운영기관이 보고한 1시간 평균 MW, 현지 최근 7일 |

CAISO는 `https://www.caiso.com/outlook/history/YYYYMMDD/demand.csv`의 `Current demand`만 읽으며 예측·순부하 열을 제외한다. 끝에 반복되는 `00:00` 차트 경계 행은 제외한다. UTC 오프셋이 없는 일광절약시간(DST) 중복·존재하지 않는 현지 시각은 추측하지 않고 누락 처리한다.

ERCOT는 `https://www.ercot.com/api/1/services/read/dashboards/supply-demand.json`에서 실제 관측만 읽는다. 예측 행은 제외하고 시간대 오프셋을 가진 타임스탬프와 epoch가 정확히 일치하는지 검증한다. ERCOT의 공식 정의상 이 수요 값에는 에너지저장장치 충전이 포함되지 않는다.

EIA는 공개 HTTPS `https://www.eia.gov/electricity/930-api/region_data/data`의 수요(`D`)를 사용한다. CAISO=CISO, ERCOT=ERCO, ISO-NE=ISNE, MISO=MISO, NYISO=NYIS, PJM=PJM, SPP=SWPP다. 이 엔드포인트는 API 키를 요구하지 않는다. `VAL`에 미보고 값의 대체·추정치가 들어갈 수 있으므로 **유효한 `REPORTED_VAL`만 실제 부하로 사용**하고 원천 품질 플래그를 보존한다. 추정·누락·미래 값은 제외 수와 경고를 남기며 0으로 채우지 않는다.

직접 피드가 실패하면 EIA의 검증된 보고값으로 대체한다. 직접 피드보다 EIA 관측이 2시간 이상 최신이면 EIA를 선택한다. EIA 최신 시각이 4시간, 5분 피드 최신 시각이 2시간 이상 지연되면 `stale`로 표시한다. 이러한 임계값은 공급기관의 SLA가 아니라 앱의 지연 표시 기준이다. NYISO 직접 피드는 현재 실행 환경에서 접근이 거부되어 직접 실시간 수집 성공을 주장하지 않는다. EIA의 시간별 자료를 5분 실시간으로 부르지 않는다.

## 날짜, 일일 피크, 시계열

관측·취득 시각은 UTC ISO 형식으로 저장하고 화면에서는 KST로 표시한다. **일일 피크의 날짜는 해당 권역 현지 달력 날짜**다. CAISO는 Pacific, ERCOT/MISO/SPP는 Central, ISO-NE/NYISO/PJM은 Eastern이다. 일일 피크 날짜를 KST 날짜로 재해석하면 안 된다.

EIA는 시간 종료(HE) 관측이다. 현지 자정으로 끝나는 관측은 그 직전 1시간이 속한 전날 피크에 포함한다. 시각 자체는 원문 HE 그대로 보존한다. 5분 직접 피드는 관측 시각의 현지 날짜에 속한다. 하루가 지난 뒤 모든 간격이 확인돼야 `complete: true`다. 시간별 자료는 보통 24개지만 DST 전환일은 23개 또는 25개이며, 5분 자료는 통상 288개다. 누락·원천 품질 플래그·중복 시각이 있으면 완결된 일일 피크로 표시하지 않는다. 관측하지 못한 더 높은 부하가 있을 수 있으므로 미완결 피크는 **확인한 표본 중 잠정 최댓값**이다.

ERCOT 직접 피드는 오늘만 제공하므로 지난 날짜의 일별 피크에는 EIA의 시간별 보고값을 사용한다. 각 `DailyPeak`에는 별도 `sourceName`, `sourceUrl`, `intervalMinutes`를 기록한다. 하루 전체 EIA가 있을 때 불완전한 과거 직접 표본으로 대체하지 않는다. 최신 부하 선 그래프에는 ERCOT 5분 표본만 포함해 시간별·5분 관측을 섞지 않는다. 1시간 평균의 피크는 5분 관측 피크를 놓칠 수 있어 측정 주기를 함께 비교해야 한다.

## 수집과 장애 처리

```sh
python3 scripts/collect-demand.py
python3 scripts/collect-demand.py --output /path/to/grid-demand.json --previous /path/to/previous.json
python3 scripts/collect-demand.py --eia-only --days 7
python3 -m unittest discover -s tests -p 'test_demand*.py' -v
```

기본 출력은 `data/grid-demand.json`, 원문 보존 경로는 `.local/demand`다. 각 공식 HTTPS 응답은 SHA-256 원문 파일로 저장하고 실행 보고서에 URL·최종 URL·실제 취득 시각·바이트 수·해시를 남긴다. 원문은 Git에 커밋하지 않는다. 호스트 허용 목록과 TLS 검증, 20초 제한, 16MiB 응답 상한, 최대 2회 시도가 적용되며 출력 JSON은 원자적으로 교체한다.

하나의 권역이 모두 실패하면 기존 검증된 값·관측 시각·취득 시각을 보존하고 `stale`과 실패 경고만 추가한다. 새 출처가 직전 값보다 과거를 반환해도 기존 관측을 보존한다. 기존 자료도 없으면 `unavailable`과 null이다. `lastAttemptAt`은 이번 실행 시작 시각, `generatedAt`은 파일 생성 시각, 각 `retrievedAt`은 실제 공식 응답 취득 시각으로 구분한다. 기존 캐시는 7개 권역·타임스탬프·시계열 순서·최신 값 일치·일별 간격 수·공식 출처 URL을 검증한 뒤에만 보존하며, 손상된 캐시는 종료 코드 2로 거부하고 출력 파일을 수정하지 않는다. 모든 권역이 신선한 검증값을 제공하면 종료 코드 0, 일부 실패·지연이면 1이다. 직접 피드만 실패해도 정상 EIA 대체가 있으면 전체 수집은 성공할 수 있으며 실행 보고서의 `directFailures`에 원인을 남긴다.

`refreshMinutes: 15`는 배포된 자동 갱신의 목표 주기다. GitHub Actions 예약은 정확한 실행 시각을 보장하지 않으며 15분마다 사이트를 갱신해도 원천 시간별 자료가 5분 실시간 자료가 되지는 않는다. 자동 수집 실행 여부·실제 마지막 성공·게시 완료를 각각 확인해야 한다.
