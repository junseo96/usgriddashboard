# 송배전 제약

`data/grid-constraints.json`은 프로젝트 인허가·진척 병목점수와 별도인 공식 출처 기반 자료다. 송전과 배전을 나누고, 같은 지표·같은 관측 범위의 값만 시계열로 연결한다. 서로 다른 시장의 정산액, 제약별 누적시간, 배전 수용능력, 정전 신뢰도를 합쳐 0–100점이나 전국 혼잡률로 만들지 않는다.

## 실제 확보한 자료

| 범위 | 자료 | 해석 |
| --- | --- | --- |
| PJM | Monitoring Analytics 2025 보고서 Table 11-11의 2008–2025년 하루전·총 혼잡 정산액; 2024–2025년 제약별 누적 혼잡시간 | 여러 제약이 같은 시간에 발생하면 중복 가산하므로 8,760으로 나눌 수 없음 |
| CAISO | DMM 2025 보고서 §5.3의 2024–2025년 하루전 내부·intertie 혼잡 지대 | 손실 surplus 제외. 2024년은 내부373 + intertie164 백만 USD |
| ERCOT | IMM 2025 보고서 Figure 38 설명의 SCED 제약 초과64 제약·시간 | 단순 binding 전체시간·정전시간과 다름 |
| MISO | IMM 2025 Figure 26의 2023–2025년 실시간 nominal congestion value 및 하루전 정산수입 | 실시간 경제적 가치와 실제 정산액 구분 |
| SPP | MMU 2025 §5.1의 2024–2025년 실시간 uncongested/breached 구간 비율 | 하나 이상 binding/breached인 비율을100−uncongested로 계산. M2M 포함 |
| ISO-NE | EMM 2025 Figure 2 설명의 2023–2025년 평균 하루전 혼잡액0.39 USD/MWh | 3년 평균 하나의 관측. 연도별로 복제하지 않음 |
| NYISO | MMU 2025 Figure A-39의 2024–2025년 하루전 congestion revenue | TCC 지급액·shortfall 별개 |
| PG&E 배전 | 공식 GRIP 공개 LineDetail 레이어의 부하 ICA | 피더별 선로구간 최소·최대 `LoadCapacity_kW`, 공개된 구간 중0 kW 비율 |
| EIA 본토 | EIA-861 final2024·2025 Reliability의 IEEE 기준 유틸리티·주 및 공식 주 집계 | SAIDI/SAIFI, major event days 포함/제외 별도. 신뢰도 보조자료이며 혼잡 대체값 아님 |

PJM·CAISO·MISO·NYISO의 금액은 같은 표시단위라도 정산 정의와 시장 범위가 다르다. 금융적 혼잡수입은 ARR/FTR/TCC 환급 전 수치이며 사회적 비용이나 소비자의 순부담으로 읽을 수 없다. 신규 송전의 경제성은 재급전 생산비 절감 등 별도 분석이 필요하다.

PG&E 데이터는 특정 유틸리티의 모델 기반 추가 **부하** 수용여유이며, 발전 hosting capacity와 혼합하지 않는다. 공개 GRIP 포털의 User Documentation ZIP 안 `PGE_GRIP_UserGuide.pdf`, pp.6–8은 Load Capacity를 “Amount of load that can be installed at that location without any thermal or voltage violations”로 정의한다. 문서 ZIP의 실제 취득시각·SHA-256과 공개 다운로드 색인을 보존하며, 임시 서명이 있는 다운로드 URL은 게시하지 않는다. 2025년6월 이후 LICA 분석에는 향후1년의 부하·DER 전망, 계획 공사, 승인 부하, 예정 계통 재구성을 반영한다. 따라서 실시간 제약과 구분한 계획 참고치다. 피더별 최솟값이 모든 지점의 값은 아니고, 최댓값을 특정 부지에 바로 적용할 수도 없다. 상위 공유 설비와 구간 중복 때문에 MW를 피더 간 더하지 않는다. 0 kW 비율의 분모는 값이 공개된 선로구간 레코드 수이며 선로길이·고객 수·부하가중 비율이 아니다. null은0으로 계산하지 않는다. 서비스 승인이나 실시간 이용률을 뜻하지 않는다.

공개 ICA에서 `lica_analysis_date`는 선로마다 다르고 오래된 월과 미공개가 섞인다. 수집 스냅샷 일자는 실제 취득일이며 원자료 분석일로 대체하지 않는다. `sourceAsOf:null`, `periodKind:snapshot` 및 원자료 분석월 범위를 함께 보존한다. PG&E 자료를 CAISO 전체 또는 전국 배전망으로 확대하지 않는다.

EIA는 IEEE 기준 신고 고객만 포함한다. 주 집계와 유틸리티·주 행은 겹치므로 다시 합산하지 않는다. `customerCount`는 원문 표에 발표된 보고 고객 수다. 특히 주 집계의 IEEE 전체 고객 수는 개별 지표의 유효 분모와 다를 수 있고 원문 주 집계와 유틸리티 행의 합이 서로 일치하지 않을 수도 있다. 따라서 공식 주 지표를 그대로 보존하고, 이 고객 수를 이용한 주·전국 가중평균 재계산은 제공하지 않는다. 다른 기준의 신뢰도값을 IEEE 값에 섞지 않는다. 본토48주·DC에서 값이 보고된 범위이며 AK·HI·해외 영토는 제외한다. 한 주가 여러 ISO에 걸치므로 주 자료를 ISO 하나에 임의로 배분하지 않는다. 신뢰도에는 기상·설비고장·공급상실 등이 섞여 있어 혼잡의 인과를 판단할 수 없다.

## 수집·재현·보존

```sh
python3 scripts/build-grid-constraints.py --refresh
python3 scripts/build-grid-constraints.py --rebuild
python3 scripts/build-grid-constraints.py --check
```

`--refresh`는 공개 HTTPS 원문을 실제 취득한다. `--rebuild`는 `.local/grid-constraints/` 원문과 메타데이터를 SHA-256으로 대조해 재생성한다. `--check`는 체크인된 정규화 자료의 출처·유일키·수치·분모를 검증하며 네트워크나 파일 변경이 없다. 원문은 커밋하지 않고 정규화 자료에 URL·취득시각·원문SHA-256·표/셀 위치를 남긴다. `generatedAt`은 사용한 원문의 가장 최근 실제 취득시각이다.

Python3.12, `openpyxl`, PDF용 `pdftotext`가 필요하다. PG&E 쿼리는 공개 조회만 사용하고 모든 페이지를 취득한다. 공개 전체 선로구간 수와 피더별 구간 수 합계를 대조하고, 알려진 구간 분모·0구간 분자를 검증한다. 잘린 페이지, 스키마 변경, 보고서의 검토한 원문 불일치, 취득 실패가 있으면 전체 게시를 중단하고 기존 체크인 데이터는 유지한다. 파일은 모든 검증 후 원자적으로 교체한다.

보고서 연도와 표는 현재 검토한2025년 문서에 고정돼 있다. 새 연도 보고서의 자동 발굴·해석·검증을 구현한 것은 아니다. 이 수집기의 작성만으로 예약 실행이 가동되는 것도 아니다. ICA 현재 스냅샷은 재취득 가능하지만 과거 스냅샷을 소급 생성하지 않는다.

## 남은 공백

비ISO West·Southeast의 공통 정의 송전혼잡 수치, 모든 유틸리티의 배전망 실측 과부하율은 미확보다. 송전선별 운전한도 대비 실제 흐름, 동일시점 노드별 혼잡 성분P90−P10, 송전 원인만 분리한 출력제한MWh도 아직 수록하지 않았다. 확보하지 못한 지표와 권역을0으로 표시하지 않고 화면의 범위표에서 공개한다.
