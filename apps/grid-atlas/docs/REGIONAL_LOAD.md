# ISO/RTO별 수용가 요청·파이프라인 비교

전국 발전 신청 1,303.58 GW와 NYISO 개별 수용가 원장 14.23 GW는 서로 다른 지역 범위다. 개요 화면은 이 둘을 전국 수급처럼 나란히 표시하지 않는다. 7개 ISO/RTO의 수용가 공개 지표를 해당 권역의 발전·저장 신청과 함께 표시하고, 각 행에 대상 지역·단계·원자료 기준일·확인 시각을 붙인다. 발전·저장 전국 원장 합계에는 ISO/RTO 밖의 서부·남동부도 포함된다.

## 2026-10-08 확인한 대표 지표

| 권역 | 표시 규모 | 범위와 기준 |
| --- | ---: | --- |
| CAISO | 12.710 GW | PG&E 구역의 20 MW 이상 신규 데이터센터. 신청·설계·공사 단계의 부분 파이프라인, 2026-06-30 기준. |
| ERCOT | **438 GW 초과** | 운영기관이 공식 추적하는 대규모 부하 접속 요청. 2026-06-18 발표, 정확 추출 기준일 미공개. |
| ISO-NE | 0.285 GW | 공식 연구계약에 들어와 CELT 전망에 선별된 2건의 계획 용량. 2026-03-27 자료. 전체 접속 요청이 아니며 전망 감액 후 110 MW와 구별. |
| MISO | 약 26.6 GW | MTEP26 권고 송전 포트폴리오가 지원하는 부하. 2026-10-07 발표, 사업 정보 2026-08-19 기준. 전체 고객 신청 큐가 아님. |
| NYISO | 14.2329 GW | 공개 Load Projects 중 활성 개별 원장 53행. 철회·운영 제외, 배전·소매 신청 전체 포함 여부 미확인. 단일 원장 기준일 미공개. |
| PJM | **240 GW 초과** | PPL Electric 구역에서 2024-09 이후 접수한 누적 요청. 2026-09-29 발표. PJM 전체 또는 현재 순수 대기량으로 해석하지 않음. |
| SPP | 약 1.7 GW | Evergy가 추가 발표한 ESA 체결 프로젝트의 정상상태 최대부하. 2026-08-06 발표, SPP 전체 요청과 별도. |

각 행은 지역 안에서 확인한 **서로 다른 범주의 지표**다. 같은 GW 단위여도 합산하여 전국 수용가 요청 총량을 만들지 않는다. 수용가 전국 합계는 미확보로 표시한다. 회사별 부분 집계와 선별 원장은 전체 ISO/RTO 부하 대비 배수를 표시하지 않는다. ERCOT 요청/피크 배수도 규모 비교이며 실현될 미래 부하나 전력 부족률이 아니다.

원문:

- [PG&E Q2 2026 발표 — SEC](https://www.sec.gov/Archives/edgar/data/75488/000100498026000047/q226earningspresentation.htm)
- [ERCOT 2026-06-18 발표](https://www.ercot.com/news/release/06182026-puct-approves-ercots)
- [ISO-NE 2026 대규모 부하 전망 검토](https://www.iso-ne.com/static-assets/documents/100033/fx2026_large_loads.pdf)
- [MISO MTEP26 Report Review, 2026-10-07, p4](https://cdn.misoenergy.org/20261007%20PAC%20Item%2006%20MTEP26%20Report%20Review785938.pdf)
- [NYISO 공개 접속 원장](https://www.nyiso.com/documents/20142/1407078/NYISO-Interconnection-Queue.xlsx)
- [PPL의 PJM 제출자료, 2026-09-29](https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5e---ppl.pdf)
- [Evergy 2026-08-06 발표](https://investors.evergy.com/static-files/73352465-a5e0-4dbf-ac4b-98692902443f)

## 전체 요청 총계의 공백

- [PJM 공식 Large Load 페이지](https://www.pjm.com/markets-and-operations/large-load)는 통합 도구를 2027-02-01, zone/area 공개 집계를 2027-03 제공 예정으로 안내한다. 현재 PPL·FirstEnergy·Exelon·Dominion 지표는 별도 부분 범위이며 합계로 대체하지 않는다.
- [SPP 2026-09-17 공식 Q&A](https://www.spp.org/documents/77803/Large%20Load%20Q&A-20260917%20Transcript.docx)는 모든 고객 요청을 공개하지 않으며, 주로 망보강·NTC 관련 연구가 공개된다고 설명한다. 과거 DPA 기록 수는 현재 고객 요청 수가 아니다.
- [ISO-NE 2026-09-24 정책 요약](https://www.iso-ne.com/static-assets/documents/100039/large_loads_integration_proposal_information_summary_9.24.26.pdf)은 검색 가능한 Large Loads 공개 추적표를 향후 게시할 계획이라고 설명한다.

이 일정들은 실제 게시·승인 완료를 뜻하지 않는다. 검증한 대표 지표가 있다는 사실과 권역 전체 고객 신청 명부를 확보했다는 사실은 구별한다.

## 구현·갱신 규칙

`data/regional-pipeline-coverage.json`은 검토한 대표 지표 ID와 보조 지표 ID, 공개 범위·해석을 보관한다. `scripts/build-load-pipeline.py`가 이를 검증하고 공개 JSON에 포함한다. NYISO 대표값은 초기 원장의 적격 활성 행에서 계산한다. 원문 없는 익명 프로젝트를 생성하거나 점수 분모를 늘리지 않는다.

`shared/regional-pipeline.ts`는 명시된 출처 ID만 해석한다. 가장 큰 수치를 자동 선택하거나 서로 겹치는 회사·단계 자료를 더하지 않는다. 잘못된 참조·권역·공개 범위는 미확보로 처리한다. 전국 개요와 부하 비교 화면이 같은 표시 기준을 사용한다.

부하 실측의 15분 목표 갱신과 이 조사 자료의 갱신은 별개다. 조사 지표를 바꿀 때 원문·단위·현재/누적 범위·단계·실제 확인 시각을 검토하고 재생성한다. 페이지 재배포로 원자료 기준일을 현재로 바꾸지 않는다.
