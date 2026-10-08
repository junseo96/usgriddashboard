#!/usr/bin/env python3
"""Build a classified, non-additive public load evidence index.

This is an offline reproducible projection, not a fresh source collector. Reviewed
named evidence is embedded below so the public checkout needs no legacy archive.
Neither rebuilding nor republishing changes checkedAt or bootstrap eligibility.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
from urllib.parse import urlparse

APP = Path(__file__).resolve().parents[1]
CLASSES = {'application', 'utility_register', 'contract', 'announced', 'grid_support', 'historical'}
BASES = {'requested_grid_mw', 'contracted_grid_mw', 'site_power_mw', 'it_mw', 'generation_mw', 'mixed_mw', 'unknown'}
STATUSES = {'planned', 'active', 'construction', 'operating', 'withdrawn', 'unknown'}
SECTORS = {'data_center', 'manufacturing', 'crypto', 'other', 'undisclosed'}
REGISTER_SOURCES = {
    'nyiso-load-register': 'application',
    'california-pge-industrial-register': 'utility_register',
    'california-sdge-register': 'utility_register',
    'gpc-main-register': 'utility_register',
    'bpa-ll-register': 'grid_support',
    'pjm-aes-contract-table': 'contract',
    'west-nv-llesa': 'contract',
    'west-idaho-contracts': 'contract',
    'west-pacificorp-contract': 'contract',
    'gpc-named-openai': 'contract',
    'southeast-lge-case': 'announced',
    'west-blackhills-wyoming-case': 'announced',
    'west-blackhills': 'contract',
    'isone-selected-forecast': 'utility_register',
    'spp-dpns-reports': 'grid_support',
    'gpc-removed-screen': 'historical',
}
NON_ADDITIVE = '원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.'


def record_status(project: dict, source_id: str) -> str:
    """Do not equate a transmission milestone or a closed service ticket to operation."""
    raw = project.get('rawStatus', '').lower()
    if source_id == 'bpa-ll-register':
        return 'withdrawn' if raw == 'withdrawn' else 'unknown'
    if source_id in {'spp-dpns-reports', 'gpc-removed-screen'}:
        return 'unknown'
    if source_id == 'california-sdge-register':
        return 'active' if raw == 'tariff ongoing' else 'unknown'
    if source_id == 'gpc-main-register':
        return 'unknown'  # Final-load planning entries can contain existing/ramping demand.
    if project.get('status') == 'withdrawn' or 'cancelled' in raw:
        return 'withdrawn'
    if project.get('status') == 'operational':
        return 'operating'
    if 'under construction' in raw:
        return 'construction'
    if project.get('status') == 'active' or raw == 'tariff - in-progress':
        return 'active'
    return 'unknown'


def project_from_register(project: dict, source: dict) -> dict:
    sid = project['sourceId']
    classification = REGISTER_SOURCES[sid]
    capacity, basis = None, 'unknown'
    caveats = list(source.get('gaps', []))
    sector = 'undisclosed'
    if sid == 'nyiso-load-register':
        capacity, basis = project.get('loadMw'), 'requested_grid_mw'
        caveats.insert(0, '기존 활성 신청 지표와 연결된 동일 원장 행입니다. 이 탐색 목록에 다시 나타나도 신청 건수에 추가하지 않습니다.')
    elif sid == 'gpc-main-register':
        capacity, basis = project.get('loadMw'), 'site_power_mw'
        caveats.insert(0, '보고된 고객 최종 부하입니다. 기존·램프업·미통전 부분을 분해하지 못해 신규 접속 신청 MW로 취급하지 않습니다.')
    elif sid == 'gpc-named-openai':
        capacity, basis, sector = project.get('loadMw'), 'contracted_grid_mw', 'data_center'
    elif sid == 'southeast-lge-case':
        capacity, basis, sector = project.get('loadMw'), 'site_power_mw', 'data_center'
    elif sid == 'west-blackhills-wyoming-case':
        capacity, basis = project.get('loadMw'), 'site_power_mw'
        caveats.insert(0, '최종 계약을 향한 협의 단계의 발표 규모입니다. 확정 계약·통전 완료·현재 계통 요청 대기열과 구별합니다.')
    elif sid == 'isone-selected-forecast':
        capacity, basis = project.get('loadMw'), 'requested_grid_mw'
        sector = 'data_center' if project['id'] == 'ISO-NE::ISONE-2026-NEMA-ANON' else 'other'
    elif sid == 'pjm-aes-contract-table':
        capacity, basis = project.get('loadMw'), 'site_power_mw'
        caveats.insert(0, 'ESO·MOU·CC·Other가 혼재한 제출표의 계획 부하입니다. 모든 행이 확정 전력서비스 계약은 아닙니다.')
    elif sid == 'california-pge-industrial-register':
        sector = 'other'
        caveats.insert(0, '원문 New Industrial 분류입니다. 제조업·데이터센터 등 세부 업종이 공개되지 않아 제조공장 수로 세지 않습니다.')
    elif sid == 'west-idaho-contracts':
        sector = 'manufacturing' if project['id'] in {'IPUC::IPC-E-24-44', 'IPUC::IPC-E-26-19'} else 'undisclosed'
    elif sid == 'west-nv-llesa':
        sector = 'data_center' if any(n in project['name'] for n in ('Vantage', 'Amazon', 'Novva')) else 'undisclosed'
    if sid in {'bpa-ll-register', 'spp-dpns-reports'}:
        caveats.insert(0, '송전 접속·지원 기록입니다. 계절별 서비스 MW·설비 정격·기존 수요를 신규 고객 신청 MW로 바꾸지 않으므로 비교 용량을 비워 둡니다.')
    if capacity is None:
        basis = 'unknown'
    state = project.get('state')
    if state and not re.fullmatch(r'[A-Z]{2}', state):
        state = None
    return {
        'id': 'register:' + project['id'], 'name': project['name'],
        'region': project['region'], 'state': state, 'sector': sector,
        'classification': classification, 'status': record_status(project, sid),
        'capacityMw': capacity, 'capacityBasis': basis,
        'sourceName': source['name'], 'sourceUrl': project['sourceUrl'],
        'sourceAsOf': project.get('sourceAsOf'), 'checkedAt': source.get('lastCheckedAt'),
        'evidence': f"원문 식별자: {project['sourceRecordId']}. 원문 상태: {project.get('rawStatus') or '미공개'}.",
        'caveats': [*caveats, NON_ADDITIVE], 'linkedProjectId': project['id'],
    }


def historical_register_aggregates(bootstrap: dict) -> list[dict]:
    sources = {s['id']: s for s in bootstrap['sources']}
    out = []
    for sid, label in (
        ('spp-dpa-history', 'SPP DPA 공개 과거 예비평가 기록'),
        ('pjm-m3-support', 'PJM M-3 고객·부하 송전 지원 기록'),
        ('miso-mtep-approved', 'MISO 승인 송전 지원 사업 기록'),
        ('miso-mtep-evaluation', 'MISO 검토 송전 지원 사업 기록'),
    ):
        if sid not in sources:
            continue
        source = sources[sid]
        out.append({
            'id': 'register-summary:' + sid, 'region': source['region'], 'name': label,
            'capacityMw': None, 'capacityBasis': 'unknown',
            'projectCount': sum(p['sourceId'] == sid for p in bootstrap['projects']),
            'sourceName': source['name'], 'sourceUrl': source['url'],
            'sourceAsOf': source.get('sourceAsOf'), 'checkedAt': source.get('lastCheckedAt'),
            'scope': '보존된 출처 레코드 수입니다. 현재 대기 중인 개별 수용가 수나 물리 사업 수가 아닙니다.',
            'caveats': [*source.get('gaps', []), NON_ADDITIVE],
        })
    return out


def valid_date(value: object) -> bool:
    if value is None:
        return True
    if not isinstance(value, str):
        return False
    try:
        if re.fullmatch(r'\d{4}-\d{2}', value):
            datetime.strptime(value, '%Y-%m')
        elif re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
            datetime.strptime(value, '%Y-%m-%d')
        else:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                return False
        return True
    except ValueError:
        return False


def validate(dataset: dict) -> None:
    if dataset.get('schemaVersion') != 1 or not dataset.get('generatedAt') or not valid_date(dataset.get('generatedAt')):
        raise ValueError('Invalid schema version or generatedAt')
    for collection in ('projects', 'aggregates'):
        seen = set()
        for p in dataset[collection]:
            if not p.get('id') or p['id'] in seen:
                raise ValueError(f'Duplicate/missing {collection} ID: {p.get("id")}')
            seen.add(p['id'])
            value = p.get('capacityMw')
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0):
                raise ValueError(f'Invalid MW: {p["id"]}')
            if p.get('capacityBasis') not in BASES or (value is None) != (p['capacityBasis'] == 'unknown'):
                raise ValueError(f'Capacity basis must identify a disclosed MW quantity: {p["id"]}')
            url = urlparse(p.get('sourceUrl', ''))
            if url.scheme != 'https' or not url.netloc or url.username or url.password:
                raise ValueError(f'Invalid public source URL: {p["id"]}')
            if not p.get('sourceName') or not valid_date(p.get('sourceAsOf')) or not valid_date(p.get('checkedAt')):
                raise ValueError(f'Invalid provenance: {p["id"]}')
            if not isinstance(p.get('caveats'), list) or not all(isinstance(c, str) for c in p['caveats']):
                raise ValueError(f'Invalid caveats: {p["id"]}')
            if collection == 'projects':
                if p.get('classification') not in CLASSES or p.get('status') not in STATUSES or p.get('sector') not in SECTORS:
                    raise ValueError(f'Invalid classification: {p["id"]}')
                if not p.get('evidence'):
                    raise ValueError(f'Missing evidence: {p["id"]}')
            elif p.get('projectCount') is not None and (isinstance(p['projectCount'], bool) or not isinstance(p['projectCount'], int) or p['projectCount'] < 0):
                raise ValueError(f'Invalid disclosed count: {p["id"]}')
            if collection == 'aggregates' and p.get('capacityQualifier', 'exact') not in {'exact', 'approximate', 'greater_than', 'at_least'}:
                raise ValueError(f'Invalid capacity qualifier: {p["id"]}')


def build(bootstrap: dict, generated_at: str) -> dict:
    source_map = {s['id']: s for s in bootstrap['sources']}
    projects = [project_from_register(p, source_map[p['sourceId']]) for p in bootstrap['projects']
                if 'load' in p['types'] and p['sourceId'] in REGISTER_SOURCES]
    projects += REVIEWED_EVIDENCE['projects']
    # Named cases first; this is a discovery index, not a queue-size leaderboard.
    projects.sort(key=lambda p: (p['linkedProjectId'] is not None, p['region'], p['name'], p['id']))
    result = {
        'schemaVersion': 1, 'generatedAt': generated_at,
        'projects': projects,
        'aggregates': REVIEWED_EVIDENCE['aggregates'] + historical_register_aggregates(bootstrap),
        'limitations': [
            '기존 53건은 NYISO 공개 원장에서 현재 활성으로 확인된 행 수이며 미국 전체 데이터센터·공장의 수가 아닙니다.',
            '이 목록은 신청·유틸리티 원장·계약·공시·송전 지원·이력을 분리한 탐색 자료입니다. 전체 행 수를 활성 접속 대기열 규모로 해석하지 않습니다.',
            '용량 미공개인 공장과 익명 고객도 보존합니다. 미공개 MW는 0으로 바꾸거나 투자액·생산량·MVA에서 추정하지 않습니다.',
            'IT 부하, 부지 총전력, 발전설비, 계약 수요, 접속 요청, 혼합 단계 집계는 서로 다른 분모입니다. 전국 총계나 실시간 부하 비율로 합산하지 않습니다.',
            '유틸리티별 집계에는 중복 문의·복수 부지·기존 운영 용량이 포함될 수 있고 명명 사례와도 겹칠 수 있습니다.',
            'checkedAt은 실제 근거 확인일을 보존합니다. generatedAt은 이 파일을 조립한 시각이며 최신 원문 확인일이나 현재 진행상태가 아닙니다.',
            '미국 본토의 비RTO 권역도 별도 West·Southeast로 표시합니다. 해당 사례를 인접 ISO의 수요에 임의 배정하지 않습니다.',
            '이 목록의 사례·집계는 기존 병목 점수 분모·평가 이력을 변경하지 않습니다. 실제 개별 절차 근거 확인이 별도로 필요합니다.',
        ],
    }
    validate(result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bootstrap', type=Path, default=APP / 'data/bootstrap.json')
    parser.add_argument('--output', type=Path, default=APP / 'public/data/load-pipeline.json')
    parser.add_argument('--generated-at')
    parser.add_argument('--check', action='store_true', help='Compare with checked-in output without rewriting source check dates')
    args = parser.parse_args()
    existing = json.loads(args.output.read_text()) if args.check else None
    stamp = args.generated_at or (existing['generatedAt'] if existing else datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))
    result = build(json.loads(args.bootstrap.read_text()), stamp)
    if args.check:
        if result != existing:
            raise SystemExit('Pipeline output differs; rebuild and review the changes')
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'projects': len(result['projects']), 'classifications': dict(Counter(p['classification'] for p in result['projects'])), 'aggregates': len(result['aggregates']), 'freshSourceFetch': False}, ensure_ascii=False))


# Reviewed public disclosures, normalized with original dates and explicit units.
# This material is data, never executable instructions from source documents.
REVIEWED_EVIDENCE = json.loads(r'''{
  "projects": [
    {
      "id": "named:NAMED_ORACLE_JUPITER_NM",
      "name": "Oracle Project Jupiter — Doña Ana",
      "region": "West",
      "state": "NM",
      "sector": "data_center",
      "classification": "announced",
      "status": "construction",
      "capacityMw": 2450,
      "capacityBasis": "generation_mw",
      "sourceName": "Oracle — Project Jupiter fuel cell technology",
      "sourceUrl": "https://www.oracle.com/news/announcement/oracle-borderplex-and-bloom-energy-to-power-project-jupiter-with-fuel-cell-technology-2026-04-27/",
      "sourceAsOf": "2026-09-14",
      "checkedAt": "2026-10-03",
      "evidence": "데이터센터 건설 확인 · 현장 마이크로그리드 대기허가 절차와 분리 공개 근거 기준일: 2026-09-14. 원문 용량 공시(서로 합산하지 않음): 2450 MW — Oracle 발표의 최대 설치 연료전지 용량 · 수용가 신청 MW와 구별 / 2462 MW — NMED 수정 청문공고의 발전 허가신청 용량 · 2.45GW 회사 공시와 별도 표기. 출처: Oracle — Project Jupiter fuel cell technology (2026-04-27): https://www.oracle.com/news/announcement/oracle-borderplex-and-bloom-energy-to-power-project-jupiter-with-fuel-cell-technology-2026-04-27/ | NMED — YGI Microgrid 수정 청문공고, NSR10883·AQB26-57(P) (발행일 미공개): https://service.web.env.nm.gov/urls/JnpLqFJC | Oracle — Project Jupiter construction permitting statement (2026-09-14): https://www.oracle.com/news/announcement/project-jupiter-statement-on-construction-permitting-2026-09-14/ | Oracle — Project Jupiter 경제효과·전력계획의 승인 전제 (2026-07-28): https://www.oracle.com/news/announcement/project-jupiter-2026-07-28/",
      "caveats": [
        "표시 용량의 원문 기준: Oracle 발표의 최대 설치 연료전지 용량 · 수용가 신청 MW와 구별",
        "공식 계통 접속 ID·요청 MW 미확보; 발전설비 MW를 수용가 대기열로 전환 불가",
        "마이크로그리드 대기허가 최종명령·절차 재개 및 가스관 승인·준공 상태 미확보",
        "2,450MW 회사 발표와 2,462MW 허가신청의 설계·범위 차이 추가 대조 필요",
        "건물 착공과 전원 준공·실제 통전·클라우드 인도의 별도 추적 필요",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_ERCOT_STARGATE_ABILENE",
      "name": "Stargate Abilene / Lancium Clean Campus",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 1200,
      "capacityBasis": "site_power_mw",
      "sourceName": "Lancium Abilene campus — ERCOT Approved",
      "sourceUrl": "https://lancium.com/locations-abilene/",
      "sourceAsOf": "2026-06-12",
      "checkedAt": "2026-10-08T08:43:33.714660+00:00",
      "evidence": "일부 통전·AI 운영 확인, 캠퍼스 확장 진행 공개 근거 기준일: 2026-06-12. 원문 용량 공시(서로 합산하지 않음): 1200 MW — 캠퍼스 계통 interconnect 승인 용량 — Lancium 공시 기준 / 200 MW — 초기 2개동 명목 용량; 최초 통전 확인 범위. 출처: Lancium Abilene campus — ERCOT Approved (발행일 미공개): https://lancium.com/locations-abilene/ | Crusoe Microsoft Abilene announcement — existing campus progress (2026-03-27): https://www.crusoe.ai/resources/newsroom/crusoe-announces-new-900-mw-ai-factory-campus-in-abilene-texas-to-support-microsoft-ai-infrastructure | OpenAI five new Stargate sites (2025-09-23): https://openai.com/index/five-new-stargate-sites/ | Oracle Q4 delivery update (2026-06-12): https://blogs.oracle.com/ceo/from-the-q4-earnings-call | Mortenson Abilene AI Data Center & Power Delivery (발행일 미공개): https://www.mortenson.com/projects/abilene-data-center-development",
      "caveats": [
        "표시 용량의 원문 기준: 캠퍼스 계통 interconnect 승인 용량 — Lancium 공시 기준",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "ERCOT 공식 대기열 ID·Batch Zero 분류와 실명 연결",
        "최신 승인 램프업별 계통 인출 MW",
        "전체 캠퍼스 실측 부하와 잔여 접속 대기 MW",
        "2026-09-10 어닝콜의 6개동·618MW 고객 인도 보도 발견; 기업 원문 웹캐스트·발표자료와 직접 대조 전 최신 수치 대체 보류",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "2026-10-08 위 1차 출처의 해당 공시를 재확인했습니다. 다른 인용문서는 각 원래 공개일·이전 확인일 기준이며 이후 상태를 뜻하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_ERCOT_IREN_CHILDRESS_MICROSOFT",
      "name": "IREN Childress — Microsoft Horizon 1–4",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 200,
      "capacityBasis": "it_mw",
      "sourceName": "IREN Secures $9.7bn AI Cloud Contract with Microsoft",
      "sourceUrl": "https://iren.gcs-web.com/news-releases/news-release-details/iren-secures-97bn-ai-cloud-contract-microsoft",
      "sourceAsOf": "2026-08-27",
      "checkedAt": "2026-10-03",
      "evidence": "Horizon 1 고객 인도·검수, Horizon 2 시운전, Horizon 3–4 건설 공개 근거 기준일: 2026-08-27. 원문 용량 공시(서로 합산하지 않음): 200 MW — Microsoft용 Horizon 1–4 계약 critical IT load; 전체 Childress 계통 용량과 구분 / 750 MW — Childress 전체 확보 계통 전력용량 / 50 MW — Horizon 1 고객 인도 IT 용량; 200MW의 부분집합. 출처: IREN increases Childress power capacity from 600MW to 750MW (2024-07-24): https://irisenergy.gcs-web.com/news-releases/news-release-details/iren-increases-childress-power-capacity-600mw-750mw | IREN Secures $9.7bn AI Cloud Contract with Microsoft (2025-11-03): https://iren.gcs-web.com/news-releases/news-release-details/iren-secures-97bn-ai-cloud-contract-microsoft | IREN Reports FY26 Results (2026-08-27): https://iren.gcs-web.com/news-releases/news-release-details/iren-reports-fy26-results",
      "caveats": [
        "표시 용량의 원문 기준: Microsoft용 Horizon 1–4 계약 critical IT load; 전체 Childress 계통 용량과 구분",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "ERCOT 공식 원장 ID",
        "Horizon별 승인 인출 MW와 램프업 조건",
        "GPU 인도·시운전과 일치하는 시간별 실측 계통 부하",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_ERCOT_LANCIUM_CRUSOE_CHILDRESS",
      "name": "Crusoe–Lancium Childress Clean Campus",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "planned",
      "capacityMw": 1000,
      "capacityBasis": "site_power_mw",
      "sourceName": "Crusoe and Lancium announce 1GW Childress campus",
      "sourceUrl": "https://www.globenewswire.com/news-release/2026/07/15/3327869/0/en/Crusoe-and-Lancium-Announce-1-0-Gigawatt-AI-Data-Center-Campus-in-Childress-Texas.html",
      "sourceAsOf": "2026-07-15",
      "checkedAt": "2026-10-03",
      "evidence": "개발 발표·ERCOT 승인 공시; 실제 착공·최초 통전 미확인 공개 근거 기준일: 2026-07-15. 원문 용량 공시(서로 합산하지 않음): 1000 MW — 캠퍼스 grid-connected capacity / interconnect 용량. 출처: Crusoe and Lancium announce 1GW Childress campus (2026-07-15): https://www.globenewswire.com/news-release/2026/07/15/3327869/0/en/Crusoe-and-Lancium-Announce-1-0-Gigawatt-AI-Data-Center-Campus-in-Childress-Texas.html | Lancium Childress County campus — ERCOT Approved (발행일 미공개): https://lancium.com/locations-childress-county/",
      "caveats": [
        "표시 용량의 원문 기준: 캠퍼스 grid-connected capacity / interconnect 용량",
        "실명 최종 고객",
        "전력회사·송전사업자 명칭",
        "공식 원장 ID와 승인 세부조건",
        "실제 착공·통전일·단계별 인출 MW",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_TEXAS_CRUSOE_MICROSOFT_ABILENE",
      "name": "Crusoe Abilene — Microsoft 전용 캠퍼스",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "construction",
      "capacityMw": 672,
      "capacityBasis": "it_mw",
      "sourceName": "Crusoe announces 900MW Microsoft Abilene campus",
      "sourceUrl": "https://www.crusoe.ai/resources/newsroom/crusoe-announces-new-900-mw-ai-factory-campus-in-abilene-texas-to-support-microsoft-ai-infrastructure",
      "sourceAsOf": "2026-06-09",
      "checkedAt": "2026-10-08T08:43:33.720890+00:00",
      "evidence": "착공 확인·2027년 중반 첫 건물 통전 목표 공개 근거 기준일: 2026-06-09. 원문 용량 공시(서로 합산하지 않음): 672 MW — 2개동 × 각336MW critical IT load; 개발사 설계치 / 900 MW — 전용 onsite 발전소 명목 용량; headline 캠퍼스 용량. 출처: Crusoe announces 900MW Microsoft Abilene campus (2026-03-27): https://www.crusoe.ai/resources/newsroom/crusoe-announces-new-900-mw-ai-factory-campus-in-abilene-texas-to-support-microsoft-ai-infrastructure | Crusoe contracted capacity update (2026-06-09): https://www.crusoe.ai/resources/newsroom/crusoes-contracted-ai-infrastructure-capacity-approaches-5-gigawatts-across-data-centers-and-cloud",
      "caveats": [
        "표시 용량의 원문 기준: 2개동 × 각336MW critical IT load; 개발사 설계치",
        "계통 접속 유무·전력회사·신청 ID",
        "확정 계통 인출 한도",
        "발전소 인허가·통전 승인·실제 운영 MW",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "2026-10-08 위 1차 출처의 해당 공시를 재확인했습니다. 다른 인용문서는 각 원래 공개일·이전 확인일 기준이며 이후 상태를 뜻하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_TEXAS_STARGATE_FRONTIER",
      "name": "Stargate Shackelford / Vantage Frontier",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "construction",
      "capacityMw": 1400,
      "capacityBasis": "it_mw",
      "sourceName": "Vantage Frontier campus",
      "sourceUrl": "https://vantage-dc.com/data-center-locations/north-america/shackelford-county-tx",
      "sourceAsOf": "2026-06-12",
      "checkedAt": "2026-10-03",
      "evidence": "건설 진행·일부 전원 용량 확보 공시, 고객 인도 2027년 상반기 목표 공개 근거 기준일: 2026-06-12. 원문 용량 공시(서로 합산하지 않음): 1400 MW — 10개동 전체 critical IT load 설계용량 — Vantage 공식 현장 페이지 / 115 MW — 2026-06-12 Oracle 공시의 이용 가능 power capacity; IT·계통 인출 기준 미정의. 출처: Vantage Frontier campus (발행일 미공개): https://vantage-dc.com/data-center-locations/north-america/shackelford-county-tx | Oracle Shackelford County Data Center (발행일 미공개): https://www.oracle.com/data-centers/shackelford-county/ | Oracle Q4 delivery update (2026-06-12): https://blogs.oracle.com/ceo/from-the-q4-earnings-call | OpenAI five new Stargate sites (2025-09-23): https://openai.com/index/five-new-stargate-sites/ | Oracle Stargate fact sheet published by US House office (2025-09-23): https://arrington.house.gov/uploadedfiles/final_oracle_oai_data_center_fact_sheet_092225b.pdf",
      "caveats": [
        "표시 용량의 원문 기준: 10개동 전체 critical IT load 설계용량 — Vantage 공식 현장 페이지",
        "계통 접속 여부·신청 ID·전력회사",
        "전체 허용 계통 인출량",
        "115MW의 IT·발전·부지 전력 기준",
        "공식 계통 단계와 최초 고객 가동·실측 부하",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_ORACLE_SALINE_THE_BARN",
      "name": "Oracle·OpenAI Saline Stargate — The Barn",
      "region": "MISO",
      "state": "MI",
      "sector": "data_center",
      "classification": "contract",
      "status": "construction",
      "capacityMw": 1383,
      "capacityBasis": "contracted_grid_mw",
      "sourceName": "MPSC Saline 특별계약 조건부 승인",
      "sourceUrl": "https://www.michigan.gov/mpsc/commission/events/2025/12/18/~/link.aspx?_id=5F5E5CA34D71466696AB507F9571E9FC&_z=z",
      "sourceAsOf": "2026-09-28",
      "checkedAt": "2026-10-08T08:43:34.096926+00:00",
      "evidence": "2026-06-01 Oracle의 캠퍼스 건설 진행 확인; 2026-09-28 DTE의 승인·착공 재확인 공개 근거 기준일: 2026-09-28. 원문 용량 공시(서로 합산하지 않음): 1383 MW — MPSC 특별계약 공시상 계약 수요 1,383MW. 출처: MPSC Saline 특별계약 조건부 승인 (2025-12-18): https://www.michigan.gov/mpsc/commission/events/2025/12/18/~/link.aspx?_id=5F5E5CA34D71466696AB507F9571E9FC&_z=z | Oracle The Barn 건설 진행 발표 (2026-06-01): https://www.oracle.com/news/announcement/related-digital-oracle-openai-walbridge-and-governor-whitmer-celebrate-construction-of-stargate-campus-in-saline-township-2026-06-01/ | DTE 2026-09-28 Business Update (2026-09-28): https://www.sec.gov/Archives/edgar/data/936340/000093634026000159/dtebusinessupdate92826fi.htm | DTE Electric Choice — MISO 관계 (발행일 미공개): https://www.dteenergy.com/us/en/business/service-request/electric/electric-choice.html",
      "caveats": [
        "표시 용량의 원문 기준: MPSC 특별계약 공시상 계약 수요 1,383MW",
        "공식 수용가 접속 원장 ID",
        "통전 완료 MW",
        "단계별 실제 전력 인입 일정",
        "접속심사 원문·망 보강 준공 확인",
        "실명·위치·계약부하·유틸리티·건설상태 확인 가능. 전력 특별계약 승인과 공식 접속심사 단계의 일대일 대응 미확보",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "2026-10-08 위 1차 출처의 해당 공시를 재확인했습니다. 다른 인용문서는 각 원래 공개일·이전 확인일 기준이며 이후 상태를 뜻하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_GOOGLE_VAN_BUREN_CANNOLI",
      "name": "Google Van Buren — Project Cannoli",
      "region": "MISO",
      "state": "MI",
      "sector": "data_center",
      "classification": "contract",
      "status": "planned",
      "capacityMw": 1000,
      "capacityBasis": "contracted_grid_mw",
      "sourceName": "DTE SEC 2026-09-28 Business Update; MPSC 2026-10-01 조건부 승인",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/936340/000093634026000159/dtebusinessupdate92826fi.htm",
      "sourceAsOf": "2026-10-01",
      "checkedAt": "2026-10-08T08:43:34.354951+00:00",
      "evidence": "2026-10-01 MPSC PSA·CCAA 조건부 승인. 공급 개시 2027-12, 최대부하 2028-12 예상 공개 근거 기준일: 2026-10-01. 원문 용량 공시(서로 합산하지 않음): 1000 MW — DTE·Michigan AG 공시상 전력 계약 부하 1.0GW. 출처: MPSC Google 전력 계약 조건부 승인 (2026-10-01): https://www.michigan.gov/mpsc/commission/news-releases/2026/10/01/mpsc-approves-dte-electric-google-data-center-and-contracts-protects-customers-from-project-cost | DTE Data Centers and Customer Rate Protection (2026-10-01): https://dteenergy.com/us/en/quicklinks/data-center-facts.html | Panattoni Project Cannoli (발행일 미공개): https://www.panattoni.com/vanburen/ | DTE Electric Choice — MISO 관계 (발행일 미공개): https://www.dteenergy.com/us/en/business/service-request/electric/electric-choice.html 1,000 MW 계약 부하는 2026-09-28 DTE SEC 제출자료에서 새로 직접 확인. https://www.sec.gov/Archives/edgar/data/936340/000093634026000159/dtebusinessupdate92826fi.htm",
      "caveats": [
        "표시 용량의 원문 기준: DTE·Michigan AG 공시상 전력 계약 부하 1.0GW",
        "공식 수용가 접속 원장 ID",
        "통전 완료 MW",
        "최종 접속심사·망 보강 일정",
        "실제 공사 단계",
        "기존 2026-09-28 자료의 계약 심사중 상태를 2026-10-01 조건부 승인으로 갱신 필요. 승인 범위는 전력서비스 계약 조건이며 입지·건축 허가와 구분",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "DTE 자체 웹사이트 취득은 실패했지만 SEC 원문에서 1,000 MW를 확인했습니다. MPSC가 별도로 언급한 발전 1,600 MW·저장 480 MW를 고객 부하에 더하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_META_HYPERION_LOUISIANA",
      "name": "Meta Hyperion — Richland Parish",
      "region": "MISO",
      "state": "LA",
      "sector": "data_center",
      "classification": "announced",
      "status": "construction",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Meta Louisiana 5GW 확대",
      "sourceUrl": "https://about.fb.com/news/2026/07/teachers-local-businesses-win-as-meta-expands-louisiana-data-center/",
      "sourceAsOf": "2026-07-13",
      "checkedAt": "2026-10-08T08:43:35.672677+00:00",
      "evidence": "2024-12 착공, 2026-07-13 Meta의 5GW 확대 및 건설 진행 공시 공개 근거 기준일: 2026-07-13. 원문 용량 공시(서로 합산하지 않음): 5000 MW — Meta의 계획 compute capacity; 캠퍼스 전체 전력수요·접속 신청MW와 구분. 출처: Meta Louisiana 5GW 확대 (2026-07-13): https://about.fb.com/news/2026/07/teachers-local-businesses-win-as-meta-expands-louisiana-data-center/ | Meta·Blue Owl Hyperion 합작 (2025-10-21): https://about.fb.com/news/2025/10/meta-blue-owl-capital-develop-hyperion-data-center/ | Entergy Louisiana·Meta 전력 인프라 협약 (2026-03-27): https://www.entergy.com/news/entergy-louisiana-announces-a-new-agreement-with-meta-that-will-deliver-an-additional-2b-in-customer-savings | Entergy 송전망과 MISO (발행일 미공개): https://www.entergy.com/transmission",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "5,000 MW는 회사가 compute capacity로 발표한 규모입니다. 확인된 IT 전기부하나 전체 계통 요청 MW로 전환하지 않습니다.",
        "캠퍼스 전체 접속 신청·확정 MW",
        "공식 수용가 접속 원장 ID",
        "단계별 통전 완료 MW",
        "확대분 전력 인허가·망 보강 준공 상태",
        "실명 프로젝트 추적 가능. 5GW compute와 전원설비MW·유틸리티 전체 대기열의 합산 제외",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "2026-10-08 위 1차 출처의 해당 공시를 재확인했습니다. 다른 인용문서는 각 원래 공개일·이전 확인일 기준이며 이후 상태를 뜻하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_COREWEAVE_LANCASTER",
      "name": "CoreWeave Lancaster AI Campus",
      "region": "PJM",
      "state": "PA",
      "sector": "data_center",
      "classification": "announced",
      "status": "planned",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "CoreWeave Lancaster 투자 발표",
      "sourceUrl": "https://investors.coreweave.com/news/news-details/2025/CoreWeave-Announces-Multi-Billion-Dollar-Commitment-to-AI-Infrastructure-in-Pennsylvania/default.aspx",
      "sourceAsOf": "2025-08-25",
      "checkedAt": "2026-10-03",
      "evidence": "CoreWeave 2025-07-15 임차·투자 발표. 개발사 전체 Lancaster East LPE-01 건설중 표시 확인; CoreWeave 임차영역과 개별 동 대조 미확보 공개 근거 기준일: 2025-08-25. 원문 용량 공시(서로 합산하지 않음): 100 MW — CoreWeave 공식 초기 데이터센터 용량; 공식 발표상 IT/총전력 구분 미명시 / 300 MW — 확장 잠재용량 · 초기100MW 포함, 합산 제외. 출처: CoreWeave Lancaster 투자 발표 (2025-07-15): https://investors.coreweave.com/news/news-details/2025/CoreWeave-Announces-Multi-Billion-Dollar-Commitment-to-AI-Infrastructure-in-Pennsylvania/default.aspx | Chirisa Lancaster 합작·PPL 망 투자 (2025-08-25): https://chirisatechnologyparks.com/blue-owl-and-chirisa-technology-parks-close-4-billion-joint-venture-partnership-including-machine-investment-group-for-lancaster-campus/ | Chirisa 프로젝트 현황 (발행일 미공개): https://chirisatechnologyparks.com/ | PJM 공식 회원 목록 (2026-09-28): https://www.pjm.com/about-pjm/member-services/member-list | Lancaster시 데이터센터 안내 (발행일 미공개): https://www.cityoflancasterpa.gov/data-center/",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "CoreWeave 임차영역과 LPE·LPW 상세 대조",
        "공식 수용가 접속 원장 ID",
        "계약·통전 MW",
        "최종 AI 고객",
        "망 보강 준공일",
        "CoreWeave 실명 확인 가능. 회사 차원의 OpenAI 계약을 해당 캠퍼스 고객으로 임의 매칭 금지. 개발사 전력 가용성 문구를 통전 완료로 해석 금지",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_ORACLE_OPENAI_LIGHTHOUSE_WI",
      "name": "Oracle·OpenAI Stargate — Vantage Lighthouse",
      "region": "MISO",
      "state": "WI",
      "sector": "data_center",
      "classification": "announced",
      "status": "planned",
      "capacityMw": 902,
      "capacityBasis": "it_mw",
      "sourceName": "Vantage Lighthouse 공식 제원",
      "sourceUrl": "https://vantage-dc.com/data-center-locations/north-america/port-washington-wisconsin",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "4개 데이터센터 캠퍼스, 2028년 완공 계획; 현행 공식제원 확보, 최신 세부 공정 미확보 공개 근거 기준일: 미공개. 원문 용량 공시(서로 합산하지 않음): 902 MW — Vantage 현행 캠퍼스 제원상 critical IT load. 출처: Vantage Lighthouse 공식 제원 (발행일 미공개): https://vantage-dc.com/data-center-locations/north-america/port-washington-wisconsin | Vantage·Oracle·OpenAI Wisconsin 발표 (2025-10-22): https://vantage-dc.com/news/openai-oracle-and-vantage-data-centers-announce-stargate-data-center-site-in-wisconsin/ | Wisconsin Electric ancillary service tariff (발행일 미공개): https://www.we-energies.com/services/business/pdf/tas.pdf",
      "caveats": [
        "표시 용량의 원문 기준: Vantage 현행 캠퍼스 제원상 critical IT load",
        "캠퍼스 전체 전력 접속 요청·확정 MW",
        "공식 수용가 접속 원장 ID",
        "접속심사 단계",
        "통전 완료 MW",
        "전력 인입·망 보강 완료일",
        "실명·IT용량·유틸리티 연결 가능. IT부하를 공식 접속대기 MW로 자동 전환 불가. 현행 제원의 공시일 미확보로 확인일만 기록",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-riot-rockdale",
      "name": "Riot Rockdale / AMD conversion",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 700,
      "capacityBasis": "site_power_mw",
      "sourceName": "Riot Rockdale site",
      "sourceUrl": "https://www.riotplatforms.com/locations/rockdale/",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "Riot 공시상 700 MW 캠퍼스 운영 중; 기존 채굴 설비 일부를 HPC로 전환하는 AMD 임대계약 체결 공개 근거 기준일: 미공개. 원문 용량 공시(서로 합산하지 않음): 700 MW — 기존 개발 완료 용량·총 계통 접속 용량; 신규 증분 신청 용량 아님 / 25 MW — 기존 캠퍼스 전환에 포함된 초기 AMD 핵심 IT 임대 용량. 출처: Riot Rockdale site (발행일 미공개): https://www.riotplatforms.com/locations/rockdale/ | Riot Rockdale land acquisition and AMD lease (발행일 미공개): https://www.riotplatforms.com/riot-announces-fee-simple-acquisition-of-land-and-first-data-center-lease-with-amd-at-the-rockdale-site/",
      "caveats": [
        "표시 용량의 원문 기준: 기존 개발 완료 용량·총 계통 접속 용량; 신규 증분 신청 용량 아님",
        "선정 근거에서 현재 동시 계량수요와 준공 완료 AMD IT 용량 미확인",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-riot-corsicana",
      "name": "Riot Corsicana",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 1000,
      "capacityBasis": "site_power_mw",
      "sourceName": "Riot data centers",
      "sourceUrl": "https://www.riotplatforms.com/datacenters/",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "회사 공시상 Corsicana의 승인·통전 완료 전력 인프라 1 GW 공개 근거 기준일: 미공개. 원문 용량 공시(서로 합산하지 않음): 1000 MW — 회사 공시상 승인·통전 완료 부지 전력 용량; 관측된 1,000 MW 소비량 아님. 출처: Riot data centers (발행일 미공개): https://www.riotplatforms.com/datacenters/ | Riot Corsicana site (발행일 미공개): https://www.riotplatforms.com/locations/corsicana/",
      "caveats": [
        "표시 용량의 원문 기준: 회사 공시상 승인·통전 완료 부지 전력 용량; 관측된 1,000 MW 소비량 아님",
        "운영 중인 채굴 부하·준공 완료 IT 용량·향후 전환 단계를 부지 접속 용량과 구분 필요",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-mara-granbury",
      "name": "MARA Granbury",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 300,
      "capacityBasis": "site_power_mw",
      "sourceName": "MARA 2025 Form 10-K",
      "sourceUrl": "https://ir.mara.com/sec-filings/all-sec-filings/content/0001507605-26-000007/mara-20251231.htm",
      "sourceAsOf": "2025-12-31",
      "checkedAt": "2026-10-03",
      "evidence": "2025년 Form 10-K상 300 MW 부지 운영, 연말 통전 해시레이트 12.3 EH/s 및 추론 기능 통합 착수 공개 근거 기준일: 2025-12-31. 원문 용량 공시(서로 합산하지 않음): 300 MW — 회사 공시상 부지 총용량; 실제 부하 아님. 출처: MARA 2025 Form 10-K (2026-03-02): https://ir.mara.com/sec-filings/all-sec-filings/content/0001507605-26-000007/mara-20251231.htm | MARA 2024 Form 10-K (2025-03-03): https://ir.mara.com/sec-filings/all-sec-filings/content/0001507605-25-000003/mara-20241231.htm",
      "caveats": [
        "표시 용량의 원문 기준: 회사 공시상 부지 총용량; 실제 부하 아님",
        "동일 부지 발전과 계통 공급의 혼합 구조; 순 계통 인출량 미공개",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-mara-garden-city",
      "name": "MARA Garden City",
      "region": "ERCOT",
      "state": "TX",
      "sector": "crypto",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 200,
      "capacityBasis": "site_power_mw",
      "sourceName": "MARA acquisition of Garden City mining site",
      "sourceUrl": "https://ir.mara.com/news-events/press-releases/detail/1350/marathon-digital-holdings-announces-the-closing-of-its-acquisition-of-a-200-megawatt-bitcoin-mining-data-center-adjacent-to-a-wind-farm",
      "sourceAsOf": "2025-12-31",
      "checkedAt": "2026-10-03",
      "evidence": "2024년 인수한 채굴 시설 운영; 2025년 공시에 폭풍으로 인한 채굴 장비 손상 기재 공개 근거 기준일: 2025-12-31. 원문 용량 공시(서로 합산하지 않음): 200 MW — 인수한 캠퍼스 명판 용량; 전량 사용 중인 부하 아님 / 126 MW — 2024년 말 공시된 운영 용량의 과거 시점 수치. 출처: MARA 2025 Form 10-K (2026-03-02): https://ir.mara.com/sec-filings/all-sec-filings/content/0001507605-26-000007/mara-20251231.htm | MARA acquisition of Garden City mining site (2024-04-02): https://ir.mara.com/news-events/press-releases/detail/1350/marathon-digital-holdings-announces-the-closing-of-its-acquisition-of-a-200-megawatt-bitcoin-mining-data-center-adjacent-to-a-wind-farm | MARA 2024 Form 10-K (2025-03-03): https://ir.mara.com/sec-filings/all-sec-filings/content/0001507605-25-000003/mara-20241231.htm",
      "caveats": [
        "표시 용량의 원문 기준: 인수한 캠퍼스 명판 용량; 전량 사용 중인 부하 아님",
        "2026년 운영 MW 미확인; 명판 200 MW를 실제 인출량으로 계상 불가",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-mara-matagorda",
      "name": "MARA Matagorda / MAT 1177",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "planned",
      "capacityMw": 2000,
      "capacityBasis": "site_power_mw",
      "sourceName": "MARA Q2 2026 Form 10-Q",
      "sourceUrl": "https://ir.mara.com/sec-filings/all-sec-filings/content/0001507605-26-000022/mara-20260630.htm",
      "sourceAsOf": "2026-08-06",
      "checkedAt": "2026-10-03",
      "evidence": "MARA의 2026년 7월 HIF 보유 MAT 1177 인수; 유틸리티 서한상 최대 2 GW 권리 및 최초 대금 지급의 Batch Zero 승인 조건 공개 근거 기준일: 2026-08-06. 원문 용량 공시(서로 합산하지 않음): 2000 MW — SEC 공시상 유틸리티 서한 약정 용량; ERCOT 배정·Batch Zero 승인 조건부. 출처: MARA Q2 2026 Form 10-Q (2026-08-06): https://ir.mara.com/sec-filings/all-sec-filings/content/0001507605-26-000022/mara-20260630.htm",
      "caveats": [
        "표시 용량의 원문 기준: SEC 공시상 유틸리티 서한 약정 용량; ERCOT 배정·Batch Zero 승인 조건부",
        "Batch Zero 조건 충족을 입증하는 공개 근거 미확보",
        "과거 HIF e-fuels 계획은 선행 사업 이력; 별도 활성 수소 고객으로 추가 계상 불가",
        "ERCOT 전력 배정 미승인 시 인수 해지 가능 조항",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-hut-king-mountain",
      "name": "Hut 8 King Mountain",
      "region": "ERCOT",
      "state": "TX",
      "sector": "crypto",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 280,
      "capacityBasis": "site_power_mw",
      "sourceName": "Hut 8 platform",
      "sourceUrl": "https://www.hut8.com/our-platform",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "Hut 8 공시상 King Mountain의 계량기 후단 설비 운영; 2025년 실적에 코로케이션 합작사 이익 반영 공개 근거 기준일: 미공개. 원문 용량 공시(서로 합산하지 않음): 280 MW — 운영관리 대상 캠퍼스 용량; 계량기 후단 부지. 출처: Hut 8 platform (발행일 미공개): https://www.hut8.com/our-platform | Hut 8 Texas development statement (발행일 미공개): https://www.hut8.com/news-insights/press-releases/hut-8-affirms-commitment-to-responsible-data-center-development-following-directive-from-texas | Hut 8 2025 results (2026-02-25): https://www.hut8.com/news-insights/press-releases/hut-8-reports-fourth-quarter-and-full-year-2025-results",
      "caveats": [
        "표시 용량의 원문 기준: 운영관리 대상 캠퍼스 용량; 계량기 후단 부지",
        "동일 물리적 캠퍼스의 MARA McCamey 위탁 채굴 용량 중복 합산 금지",
        "유틸리티명과 실제 순 계통 수전량 미확인",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-hut-vega",
      "name": "Hut 8 Vega",
      "region": "ERCOT",
      "state": "TX",
      "sector": "crypto",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 205,
      "capacityBasis": "site_power_mw",
      "sourceName": "Hut 8 2025 results",
      "sourceUrl": "https://www.hut8.com/news-insights/press-releases/hut-8-reports-fourth-quarter-and-full-year-2025-results",
      "sourceAsOf": "2026-02-25",
      "checkedAt": "2026-10-03",
      "evidence": "2025년 6월 30일 최초 통전 발표; 2025년 실적에서 205 MW ASIC 시설 통전 확인 공개 근거 기준일: 2026-02-25. 원문 용량 공시(서로 합산하지 않음): 205 MW — 부지 ASIC 코로케이션 용량; 단계별 통전 기준으로 계량된 계통 수요 아님. 출처: Hut 8 energizes Vega (2025-06-30): https://www.hut8.com/news-insights/press-releases/hut-8-energizes-vega-data-center | Hut 8 2025 results (2026-02-25): https://www.hut8.com/news-insights/press-releases/hut-8-reports-fourth-quarter-and-full-year-2025-results | Hut 8 Texas development statement (발행일 미공개): https://www.hut8.com/news-insights/press-releases/hut-8-affirms-commitment-to-responsible-data-center-development-following-directive-from-texas",
      "caveats": [
        "표시 용량의 원문 기준: 부지 ASIC 코로케이션 용량; 단계별 통전 기준으로 계량된 계통 수요 아님",
        "계량기 후단 공급 구조; 순 ERCOT 인출량과 전면 가동 시 계량 MW 미공개",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-cipher-odessa",
      "name": "Cipher Odessa",
      "region": "ERCOT",
      "state": "TX",
      "sector": "crypto",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 207,
      "capacityBasis": "site_power_mw",
      "sourceName": "Cipher Digital infrastructure",
      "sourceUrl": "https://cipherdigital.com/infrastructure/",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "현재 회사 포트폴리오상 Odessa 운영 중, 해시레이트 약 11.6 EH/s 공개 근거 기준일: 미공개. 원문 용량 공시(서로 합산하지 않음): 207 MW — 회사 공시상 운영 전력 용량. 출처: Cipher Digital infrastructure (발행일 미공개): https://cipherdigital.com/infrastructure/",
      "caveats": [
        "표시 용량의 원문 기준: 회사 공시상 운영 전력 용량",
        "공식 큐 식별번호와 계량수요 미확보; 포트폴리오 페이지 발행일 미표시",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-cipher-black-pearl",
      "name": "Cipher Black Pearl / AWS",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 300,
      "capacityBasis": "site_power_mw",
      "sourceName": "Cipher Black Pearl project financing exhibit",
      "sourceUrl": "https://investors.cipherdigital.com/static-files/ea18cc35-53af-4e32-81a7-32a835429abf",
      "sourceAsOf": "2026-08-04",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 2월 채굴 설비 운영 종료; 8월 최초 HPC 용량 인도·임대료 발생 개시, 잔여 단계 공사 중 공개 근거 기준일: 2026-08-04. 원문 용량 공시(서로 합산하지 않음): 300 MW — 금융조달 첨부자료상 통전 완료 총 접속 용량 및 ERCOT 승인 용량 / 216 MW — 총 캠퍼스 용량에 포함된 계약상 핵심 IT 부하. 출처: Cipher Digital second quarter 2026 update (2026-08-04): https://investors.cipherdigital.com/news-releases/news-release-details/cipher-digital-provides-second-quarter-2026-business-update | Cipher Black Pearl project financing exhibit (발행일 미공개): https://investors.cipherdigital.com/static-files/ea18cc35-53af-4e32-81a7-32a835429abf | Cipher full year 2025 business update slides (2026-02-24): https://investors.cipherdigital.com/static-files/58e46e77-13f9-4514-8c2a-2c7695cf2b4a",
      "caveats": [
        "표시 용량의 원문 기준: 금융조달 첨부자료상 통전 완료 총 접속 용량 및 ERCOT 승인 용량",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "과거 채굴 용량과 HPC 전환 용량을 별도 신규 부하로 중복 계상 금지",
        "회사 공시상 ERCOT 승인 주장; 공개 LLI 식별번호와 실제 계량수요 미확보",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-cipher-barber-lake",
      "name": "Cipher Barber Lake / Fluidstack",
      "region": "ERCOT",
      "state": "TX",
      "sector": "data_center",
      "classification": "announced",
      "status": "construction",
      "capacityMw": 300,
      "capacityBasis": "site_power_mw",
      "sourceName": "Cipher Digital infrastructure",
      "sourceUrl": "https://cipherdigital.com/infrastructure/",
      "sourceAsOf": "2026-08-04",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 8월 공시상 공사 진행과 함께 임차인의 실사용 권한 행사·부분 입주·네트워크 랙 설치 개시 공개 근거 기준일: 2026-08-04. 원문 용량 공시(서로 합산하지 않음): 300 MW — 포트폴리오상 계약 캠퍼스 용량·통전 전력; 준공 완료 IT 부하 아님. 출처: Cipher Digital second quarter 2026 update (2026-08-04): https://investors.cipherdigital.com/news-releases/news-release-details/cipher-digital-provides-second-quarter-2026-business-update | Cipher Digital infrastructure (발행일 미공개): https://cipherdigital.com/infrastructure/",
      "caveats": [
        "표시 용량의 원문 기준: 포트폴리오상 계약 캠퍼스 용량·통전 전력; 준공 완료 IT 부하 아님",
        "향후 500 MW 증설 계획과 기존 300 MW 캠퍼스 구분 필요",
        "전 용량 최종 운영 확인과 공개 LLI 식별번호 미확보",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-freeport-lng",
      "name": "Freeport LNG trains 1–3",
      "region": "ERCOT",
      "state": "TX",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Freeport LNG overview",
      "sourceUrl": "https://freeportlng.com/about/about-overview",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "3개 트레인의 기존 전기 구동 LNG 플랜트 운영; 해당 부하 공급을 위한 Jones Creek 송전 사업의 2015년 ERCOT 승인 공개 근거 기준일: 미공개. 원문 용량 공시(서로 합산하지 않음): 690 MW — 2015년 ERCOT 계획상 전면 생산 시 전력 부하 추정치; 현재 계량수요가 아닌 과거 수치. 출처: Freeport LNG overview (발행일 미공개): https://freeportlng.com/about/about-overview | ERCOT 2015 Electric System Constraints and Needs (2015-12-31): https://www.ercot.com/files/docs/2015/12/31/2015ercotconstraintsandneedsreport.pdf",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "Train 4는 별도 향후 증설 계획으로 본 사례에서 제외",
        "현재 계량수요와 계약상 계통 수전 한도 미확보",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-samsung-taylor",
      "name": "Samsung Taylor semiconductor fab",
      "region": "ERCOT",
      "state": "TX",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "construction",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Samsung Taylor construction and operations update",
      "sourceUrl": "https://semiconductor.samsung.com/sas/local-news/samsung-austin-semiconductors-two-campuses-inject-10-9b-into-central-texas-economy-in-2025/",
      "sourceAsOf": "2026-10-07",
      "checkedAt": "2026-10-08T08:43:36.502369+00:00",
      "evidence": "Samsung의 현재 공식 본문(2026-10-07)은 Taylor 2nm 팹이 2026년 말 가동할 계획이라고 설명합니다. 시설 전체 전력수요 MW·고객 접속 신청 ID·미통전 잔여 MW는 미공개입니다. https://semiconductor.samsung.com/sas/local-news/samsung-austin-semiconductors-two-campuses-inject-10-9b-into-central-texas-economy-in-2025/",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "1차 자료에서 부지 부하 MW 미확인",
        "PUCT PDF 직접 다운로드 차단; 송전 공사 주장은 검색 색인에 수록된 1차 제출자료 발췌문만 확인",
        "Austin의 운영 팹과 Taylor의 건설 사업 구분 필요",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "2026-10-08 위 1차 출처의 해당 공시를 재확인했습니다. 다른 인용문서는 각 원래 공개일·이전 확인일 기준이며 이후 상태를 뜻하지 않습니다.",
        "이전 보관본의 2026-06-10 발행일은 현재 공식 본문의 2026-10-07로 정정했습니다. PUCT 문서 직접 취득은 403 실패하여 송전 공사 완료 주장을 새로 확인하지 않았습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-cmc-seguin",
      "name": "CMC Steel Texas / Seguin",
      "region": "ERCOT",
      "state": "TX",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "CMC steel mills compliance certificate",
      "sourceUrl": "https://www.cmc.com/getmedia/78fd6981-893e-47d7-add7-34b10f1968da/CMC-Steel-Mills-General-Compliance-Certificate.pdf",
      "sourceAsOf": "2026-01-20",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 CMC 제철소 인증서에 Seguin 포함; 과거 GVEC CCN 제출자료에서 CMC/SMI 변전소와 예상 산업 부하 확인 공개 근거 기준일: 2026-01-20. 원문 용량 공시(서로 합산하지 않음): 124.5 MW — GVEC의 과거 2016년 산업 부하 전망치; 2026년 실제 부하나 신규 신청량 아님. 출처: CMC steel mills compliance certificate (2026-01-20): https://www.cmc.com/getmedia/78fd6981-893e-47d7-add7-34b10f1968da/CMC-Steel-Mills-General-Compliance-Certificate.pdf | GVEC supplemental CCN response, PUCT 41967 item 7 (발행일 미공개): https://interchange.puc.texas.gov/Documents/41967_7_774212.PDF | CMC energy and climate (발행일 미공개): https://esg.cmc.com/environmental/environmental-stewardship/energy-and-climate/",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "현재 계량 부하와 증설 신청량 미공개",
        "PUCT PDF 직접 다운로드 차단; 과거 계통 근거는 검색 색인의 1차 제출자료 발췌문으로 확인",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "현재 전력 접속의 실제 통전일은 별도 미확보",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-cnp-baytown-hydrogen",
      "name": "CenterPoint Baytown blue-hydrogen customer — name undisclosed",
      "region": "ERCOT",
      "state": "TX",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "planned",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "CenterPoint Baytown Area Load Addition RPG presentation",
      "sourceUrl": "https://www.ercot.com/files/docs/2024/11/11/CNP_Baytown_Area_Load_Addition_project_20241112.pdf",
      "sourceAsOf": "2025-09-15",
      "checkedAt": "2026-10-03",
      "evidence": "2028년 1월 목표 청색수소 플랜트의 신규 고객 소유 138 kV 변전소 공급 요청; 2025년 ERCOT 독립 검토·TAC 승인 완료 공개 근거 기준일: 2025-09-15. 원문 용량 공시(서로 합산하지 않음): 475.475 MW — 계산 유효전력: 500.5 MVA × 공시 역률 0.95; 원문은 MVA 공시이며 해당 MW 수치 직접 공시 아님. 출처: CenterPoint Baytown Area Load Addition RPG presentation (2024-11-11): https://www.ercot.com/files/docs/2024/11/11/CNP_Baytown_Area_Load_Addition_project_20241112.pdf | ERCOT Baytown Independent Review and Board recommendation (2025-09-15): https://www.ercot.com/files/docs/2025/09/15/7.1-CNP-Baytown-Area-Load-Addition-Project.pdf",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "원문의 MVA·역률 계산으로 만든 475.475 MW는 직접 공시된 수용가 MW가 아니므로 용량 필드에서 제외했습니다.",
        "고객 실명 공개 확인 불가; 위치·변전소명만으로 Exxon으로 추정 금지",
        "이사회 자료는 결의안 초안 포함으로 실제 이사회 의결의 근거 아님",
        "시운전·현재 Batch Zero 배정 근거 미확보",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-canaan-bear",
      "name": "Canaan / WindHQ Bear",
      "region": "ERCOT",
      "state": "TX",
      "sector": "crypto",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 40,
      "capacityBasis": "site_power_mw",
      "sourceName": "Cipher portfolio presentation with ABC site capacities",
      "sourceUrl": "https://investors.cipherdigital.com/static-files/f00c5ff3-78e0-4cbd-b8e9-b9c32edb13c9",
      "sourceAsOf": "2026-08-31",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 2월 Canaan의 Cipher 보유 합작사 지분 49% 인수; 후속 공시에도 ABC 운영 사업 식별 유지 공개 근거 기준일: 2026-08-31. 원문 용량 공시(서로 합산하지 않음): 40 MW — 이전 소유사 포트폴리오상 부지 전력 용량; ABC 3개 부지 합계 120 MW를 각 부지에 부여 불가. 출처: Canaan acquires 49 percent interest in Alborz, Bear and Chief Mountain (2026-02-23): https://investor.canaan-creative.com/news-releases/news-release-details/canaan-inc-acquires-cipher-minings-interest-multiple-operational | Canaan August 2026 mining update (발행일 미공개): https://investor.canaan-creative.com/news-releases/news-release-details/canaan-inc-provides-august-2026-bitcoin-production-and-mining | Cipher portfolio presentation with ABC site capacities (발행일 미공개): https://investors.cipherdigital.com/static-files/f00c5ff3-78e0-4cbd-b8e9-b9c32edb13c9",
      "caveats": [
        "표시 용량의 원문 기준: 이전 소유사 포트폴리오상 부지 전력 용량; ABC 3개 부지 합계 120 MW를 각 부지에 부여 불가",
        "현재 부지별 실제 MW 미공개",
        "물리적 부지 용량에 지분율을 곱하여 산정 불가",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:ercot-canaan-chief-mountain",
      "name": "Canaan / WindHQ Chief Mountain",
      "region": "ERCOT",
      "state": "TX",
      "sector": "crypto",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 40,
      "capacityBasis": "site_power_mw",
      "sourceName": "Cipher portfolio presentation with ABC site capacities",
      "sourceUrl": "https://investors.cipherdigital.com/static-files/f00c5ff3-78e0-4cbd-b8e9-b9c32edb13c9",
      "sourceAsOf": "2026-08-31",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 2월 Canaan의 Cipher 보유 합작사 지분 49% 인수; 후속 공시에도 ABC 운영 사업 식별 유지 공개 근거 기준일: 2026-08-31. 원문 용량 공시(서로 합산하지 않음): 40 MW — 이전 소유사 포트폴리오상 부지 전력 용량; ABC 3개 부지 합계 120 MW를 각 부지에 부여 불가. 출처: Canaan acquires 49 percent interest in Alborz, Bear and Chief Mountain (2026-02-23): https://investor.canaan-creative.com/news-releases/news-release-details/canaan-inc-acquires-cipher-minings-interest-multiple-operational | Canaan August 2026 mining update (발행일 미공개): https://investor.canaan-creative.com/news-releases/news-release-details/canaan-inc-provides-august-2026-bitcoin-production-and-mining | Cipher portfolio presentation with ABC site capacities (발행일 미공개): https://investors.cipherdigital.com/static-files/f00c5ff3-78e0-4cbd-b8e9-b9c32edb13c9",
      "caveats": [
        "표시 용량의 원문 기준: 이전 소유사 포트폴리오상 부지 전력 용량; ABC 3개 부지 합계 120 MW를 각 부지에 부여 불가",
        "현재 부지별 실제 MW 미공개",
        "물리적 부지 용량에 지분율을 곱하여 산정 불가",
        "공개 ERCOT 고객별 큐 식별번호와 공식 접속신청 부하 연결 미확보; 사례별 MW를 큐 총량으로 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-toyota-nc",
      "name": "Toyota Battery Manufacturing North Carolina",
      "region": "Southeast",
      "state": "NC",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Stein 주지사, Toyota 배터리 공장 개장 발표",
      "sourceUrl": "https://governor.nc.gov/news/press-releases/2025/11/12/governor-stein-celebrates-grand-opening-toyota-battery-plant-randolph-county",
      "sourceAsOf": "2025-11-12",
      "checkedAt": "2026-10-08T08:43:36.711309+00:00",
      "evidence": "2025년 11월 12일 주정부 발표에서 공장 개장과 생산 확대 확인. 전력수요 MW와 최신 정상가동 도달 여부는 해당 자료에서 미공개. 공개 근거 기준일: 2025-11-12. 출처: Stein 주지사, Toyota 배터리 공장 개장 발표 (2025-11-12): https://governor.nc.gov/news/press-releases/2025/11/12/governor-stein-celebrates-grand-opening-toyota-battery-plant-randolph-county",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "2026-10-08 위 1차 출처의 해당 공시를 재확인했습니다. 다른 인용문서는 각 원래 공개일·이전 확인일 기준이며 이후 상태를 뜻하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-hyundai-metaplant",
      "name": "Hyundai Motor Group Metaplant America",
      "region": "Southeast",
      "state": "GA",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "HMGMA 준공 발표",
      "sourceUrl": "https://www.hyundaimotorgroup.com/en/amp/CONT0000000000173041",
      "sourceAsOf": "2025-03-26",
      "checkedAt": "2026-10-03",
      "evidence": "2025년 3월 26일 준공 발표에서 2024년 10월 3일 첫 차량 생산 및 IONIQ 5·IONIQ 9 생산 확인. 향후 차량 생산능력 확대 수치는 전력수요로 환산 불가. 공개 근거 기준일: 2025-03-26. 출처: HMGMA 준공 발표 (2025-03-26): https://www.hyundaimotorgroup.com/en/amp/CONT0000000000173041",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "발표의 주차장 태양광 5.2 MW는 발전용량이므로 전력부하 MW에서 제외.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-rivian-georgia",
      "name": "Rivian Stanton Springs North factory",
      "region": "Southeast",
      "state": "GA",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "construction",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Rivian 애틀랜타 동부 본사 개장 발표",
      "sourceUrl": "https://rivian.com/stories/atlanta-georgia-east-coast-headquarters-opening",
      "sourceAsOf": "2026-08-06",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 8월 6일 Rivian 발표에서 조지아 제조시설 공사 진행 확인. 운영 중인 애틀랜타 본사는 별도 시설. 공개 근거 기준일: 2026-08-06. 출처: Rivian 애틀랜타 동부 본사 개장 발표 (2026-08-06): https://rivian.com/stories/atlanta-georgia-east-coast-headquarters-opening",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-ford-tennessee",
      "name": "Ford Tennessee Truck Plant / BlueOval City",
      "region": "Southeast",
      "state": "TN",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "construction",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "BlueOval City FAQ — 2026년 10월 3일 확인",
      "sourceUrl": "https://corporate.ford.com/operations/blue-oval-city/faqs/",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "현재 Ford FAQ의 트럭 조립 개시 목표는 2029년. 2024년 4월 4일 발표의 목표는 2026년이며 당시 설비 설치 진행 명시. 일정 변경 확인, 실제 계통 접속 상태는 미공개. 공개 근거 기준일: 미공개. 출처: BlueOval City FAQ — 2026년 10월 3일 확인 (발행일 미공개): https://corporate.ford.com/operations/blue-oval-city/faqs/ | Ford 차세대 전기차 일정 변경 발표 (2024-04-04): https://www.fromtheroad.ford.com/us/en/articles/2024/ford-updates-timing-for-next-gen-evs--readies-manufacturing-plan",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "현재 FAQ의 게시일 미표기. 2029년은 회사 목표이며 실제 통전일은 미확인. 트럭 공장과 별도 배터리 공장의 소유권 변경·용도 전환은 구분 필요.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-vinfast-nc",
      "name": "VinFast North Carolina factory",
      "region": "Southeast",
      "state": "NC",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "unknown",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "노스캐롤라이나주, 제조 부지 회수를 위한 VinFast 소송 발표",
      "sourceUrl": "https://ncdoj.gov/north-carolina-sues-vinfast-to-acquire-shovel-ready-manufacturing-site/",
      "sourceAsOf": "2026-05-21",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 5월 21일 노스캐롤라이나주 법무부의 부지 회수를 위한 소송 발표. 계약상 2026년 7월 가동 목표 대비 최소 2028년까지 지연 및 계약 불이행 주장. 주정부의 주장과 지연 사실을 구분하며, 취소 확정 근거는 미확보. 공개 근거 기준일: 2026-05-21. 출처: 노스캐롤라이나주, 제조 부지 회수를 위한 VinFast 소송 발표 (2026-05-21): https://ncdoj.gov/north-carolina-sues-vinfast-to-acquire-shovel-ready-manufacturing-site/",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "인용한 주정부 발표만으로 회사 측 이의 제기와 후속 소송 결과 확인 불가. 취소·철회로 분류할 근거 미확보.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-novelis-bay-minette",
      "name": "Novelis Bay Minette recycling and rolling plant",
      "region": "Southeast",
      "state": "AL",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "construction",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Novelis 2027 회계연도 1분기 실적",
      "sourceUrl": "https://investors.novelis.com/news-events/press-releases/detail/1425/novelis-reports-first-quarter-fiscal-year-2027-results",
      "sourceAsOf": "2026-08-05",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 8월 5일 분기 발표에서 주요 설비의 초기 시운전 착수 확인. 공장 시운전과 전력망 접속 완료 여부는 별도 확인 필요. 공개 근거 기준일: 2026-08-05. 출처: Novelis 2027 회계연도 1분기 실적 (2026-08-05): https://investors.novelis.com/news-events/press-releases/detail/1425/novelis-reports-first-quarter-fiscal-year-2027-results | Novelis·Southern Company 협력 발표 (2023-10-09): https://investors.novelis.com/news-events/press-releases/detail/18/novelis-partners-with-southern-company-in-pursuit-of-decarbonization-goals",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "재생에너지 구독으로 지원하는 80 MW 태양광 발전소 2기는 발전자산. 이를 Novelis 전력수요 160 MW로 해석 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-wolfspeed-siler-city",
      "name": "Wolfspeed John Palmour Manufacturing Center",
      "region": "Southeast",
      "state": "NC",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Wolfspeed 2026 회계연도 Form 10-K",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/895419/000089541926000054/wolf-20260628.htm",
      "sourceAsOf": "2026-06-28",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 8월 20일 Form 10-K에서 Siler City의 생산 준비 완료와 낮은 가동률 확인. 최소 구매 의무가 있는 장기 전력공급계약도 공시되었으나 MW는 미공개. 공개 근거 기준일: 2026-06-28. 출처: Wolfspeed 2026 회계연도 Form 10-K (2026-08-20): https://www.sec.gov/Archives/edgar/data/895419/000089541926000054/wolf-20260628.htm",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-nucor-lexington",
      "name": "Nucor Steel Lexington rebar micro mill",
      "region": "Southeast",
      "state": "NC",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Nucor 2026년 2분기 실적 발표, 슬라이드 8",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/73309/000119312526318190/d468854dex992.htm",
      "sourceAsOf": "2026-07-28",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 7월 28일 발표에서 Lexington의 2분기 EBITDA 흑자 및 신규 사업의 생산 확대 진행 확인. 전력부하 MW는 미공개. 공개 근거 기준일: 2026-07-28. 출처: Nucor 2026년 2분기 실적 발표, 슬라이드 8 (2026-07-28): https://www.sec.gov/Archives/edgar/data/73309/000119312526318190/d468854dex992.htm",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-nucor-berkeley",
      "name": "Nucor Steel Berkeley second galvanizing line",
      "region": "Southeast",
      "state": "SC",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "construction",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Nucor 2026년 2분기 실적 발표, 슬라이드 8",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/73309/000119312526318190/d468854dex992.htm",
      "sourceAsOf": "2026-07-28",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 7월 28일 발표에서 설비 시운전 진행 및 2026년 가을 생산 개시 목표 확인. 생산 목표일에 대한 실제 통전 근거는 미확보. 공개 근거 기준일: 2026-07-28. 출처: Nucor 2026년 2분기 실적 발표, 슬라이드 8 (2026-07-28): https://www.sec.gov/Archives/edgar/data/73309/000119312526318190/d468854dex992.htm",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-century-mt-holly",
      "name": "Century Aluminum Mt. Holly potline restart",
      "region": "Southeast",
      "state": "SC",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Century Aluminum 2026년 2분기 실적",
      "sourceUrl": "https://investors.centuryaluminum.com/news-events/press-releases/press-release-details/2026/Century-Aluminum-Company-Reports-Second-Quarter-2026-Results/default.aspx",
      "sourceAsOf": "2026-08-06",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 8월 6일 사업자 발표에서 Mt. Holly의 잔여 전해조 90기 재가동 완료 확인. 2025년 10월 6일 Santee Cooper 발표에서 2031년까지 연장된 계약에 따른 추가 전력공급 확인. 공개 근거 기준일: 2026-08-06. 출처: Century Aluminum 2026년 2분기 실적 (2026-08-06): https://investors.centuryaluminum.com/news-events/press-releases/press-release-details/2026/Century-Aluminum-Company-Reports-Second-Quarter-2026-Results/default.aspx | Santee Cooper·Century 추가 전해조 전력공급계약 발표 (2025-10-06): https://newsroom.santeecooper.com/news/Santee-Cooper-Century-Sign-Agreement-to-Power-Additional-Potline-Create-Jobs-in-Mt.-Holly/",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-plug-woodbine",
      "name": "Plug Power Woodbine hydrogen plant",
      "region": "Southeast",
      "state": "GA",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Plug Power 2026년 9월 22일 운영시설 현황",
      "sourceUrl": "https://www.ir.plugpower.com/press-releases/news-details/2026/Plug-Power-Expands-Hydrogen-Footprint-Across-New-Zealand-and-Australia-with-GenEco-Electrolyzer-Delivery-to-HWR-Hydrogen/default.aspx",
      "sourceAsOf": "2026-09-22",
      "checkedAt": "2026-10-03",
      "evidence": "2024년 1월 23일 사업자 발표에서 생산 개시 및 5 MW PEM 수전해 설비 8기 확인. 2026년 9월 22일 발표에서 조지아 수소시설의 운영 지속 확인. 공개 근거 기준일: 2026-09-22. 원문 용량 공시(서로 합산하지 않음): 40 MW — 수전해 설비의 정격 전력: 5 MW PEM 설비 8기. 시설 전체 최대수요·접속 신청용량·미통전 잔여용량과 구분.. 출처: Plug Power 2026년 9월 22일 운영시설 현황 (2026-09-22): https://www.ir.plugpower.com/press-releases/news-details/2026/Plug-Power-Expands-Hydrogen-Footprint-Across-New-Zealand-and-Australia-with-GenEco-Electrolyzer-Delivery-to-HWR-Hydrogen/default.aspx | Plug 조지아 수소 생산 개시 발표 (2024-01-23): https://www.ir.plugpower.com/press-releases/news-details/2024/Plug-Power-Starts-Production-of-Liquid-Green-Hydrogen-at-its-Georgia-Plant/default.aspx",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-fpl-cavendish",
      "name": "FPL Cavendish NextGen Hydrogen Hub",
      "region": "Southeast",
      "state": "FL",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "FPL 청정수소 허브 준공 발표",
      "sourceUrl": "https://newsroom.fpl.com/Florida-Power-Light-Company-announces-completion-of-clean-hydrogen-hub",
      "sourceAsOf": "2024-02-08",
      "checkedAt": "2026-10-03",
      "evidence": "2024년 2월 8일 FPL 발표에서 태양광 기반 수소 실증시설 준공 확인. 2022년 2월 28일 공급업체 발표에 수전해 설비 5기, 합계 25 MW 명시. 공개 근거 기준일: 2024-02-08. 원문 용량 공시(서로 합산하지 않음): 25 MW — 수전해 시스템의 정격 전력. 인접 태양광으로 가동하는 전력회사 소유 실증시설이며, 고객 접속 신청용량과 구분.. 출처: FPL 청정수소 허브 준공 발표 (2024-02-08): https://newsroom.fpl.com/Florida-Power-Light-Company-announces-completion-of-clean-hydrogen-hub | Cummins의 FPL용 25 MW 수전해 설비 공급 발표 (2022-02-28): https://investor.cummins.com/news/detail/554/fpl-announces-cummins-to-supply-electrolyzer-for",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "산업용 전력수요 범위에 포함한 전력회사 소유 시설로, 별도 소매 고객에 해당하지 않음. 확보한 최근 구체적 운영 자료는 2024년 기준.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:southeast-industrial-aluminum-dynamics-columbus",
      "name": "Aluminum Dynamics Columbus rolling mill",
      "region": "Southeast",
      "state": "MS",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "operating",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Steel Dynamics 2026년 3분기 실적 전망",
      "sourceUrl": "https://ir.steeldynamics.com/steel-dynamics-provides-third-quarter-2026-earnings-guidance/",
      "sourceAsOf": "2026-09-17",
      "checkedAt": "2026-10-03",
      "evidence": "2026년 9월 17일 사업자 실적 전망에서 냉간압연기 3기 전체와 첫 연속 소둔·용체화 열처리 라인의 가동 확인. 출하량 확대 및 고객 승인 절차 진행. 공개 근거 기준일: 2026-09-17. 출처: Steel Dynamics 2026년 3분기 실적 전망 (2026-09-17): https://ir.steeldynamics.com/steel-dynamics-provides-third-quarter-2026-earnings-guidance/",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "인용한 1차 자료에서 시설 전체 전력수요 MW와 미통전 잔여 MW 미확보.",
        "Georgia·Duke·TVA·Southern 비공개 행과의 동일 사업 연결 근거 미확보. 해당 집계와 중복 합산 금지.",
        "공장 공사·생산 이력만으로 계통심사 완료 또는 특정 접속 단계 도달 여부 판정 불가.",
        "위치만으로 전력 공급사를 추정하지 않음. 별도로 발표된 신규 재활용 슬래브 시설은 이 압연공장 행에 통합하지 않음.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_AVH1_CA",
      "name": "Antelope Valley Hydrogen 1",
      "region": "West",
      "state": "CA",
      "sector": "manufacturing",
      "classification": "announced",
      "status": "planned",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "LA County — 2024-11-18~25 계획 신청 접수 목록, 17~22쪽",
      "sourceUrl": "https://planning.lacounty.gov/wp-content/uploads/2024/12/DRP_PlanningArea_Countywide_25-11-2024_06-00-14.pdf",
      "sourceAsOf": "2024-11-25",
      "checkedAt": "2026-10-03",
      "evidence": "토지이용 신청 접수 확인 · 전기분해 설계 162MW와 182MW가 상충하며 최신 승인 설계·계통접속 상태 미확인 공개 근거 기준일: 2024-11-25. 원문 용량 공시(서로 합산하지 않음): 162 MW — 2024-11-25 카운티 접수 목록의 전기분해 설비 최대 정격 · 계통 신청·확보 용량 아님 / 182 MW — 2024-08-06 개발사의 전기분해 설계 발표 · 후속 카운티 신청 162MW와 상충하며 합산 불가. 출처: LA County — 2024-11-18~25 계획 신청 접수 목록, 17~22쪽 (발행일 미공개): https://planning.lacounty.gov/wp-content/uploads/2024/12/DRP_PlanningArea_Countywide_25-11-2024_06-00-14.pdf | Novo Hydrogen — ARCHES 협력 사업과 AVH1 전기분해·태양광 계획 (2024-08-06): https://novohydrogen.com/news/california-arches-hub-secures-nations-first-federal-funding-for-renewable-clean-hydrogen/ | Novo Hydrogen — AVH1 프로젝트 페이지, 설계 문구 상충 (발행일 미공개): https://novohydrogen.com/antelope-valley-hydrogen-1/",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "카운티 자료는 최대 162MW, 앞선 개발사 발표는 182MW 전기분해 설계로 차이 존재 · 확정 현재 용량으로 단일화 불가",
        "현재 개발사 페이지에 182MW와 과거 300MW 문구가 함께 남아 있어 최신 설계 판단 근거로 단독 사용 불가",
        "공식 계통 신청 ID·계통 신청 MW·전력회사 및 계통 보완전력 규모 미확보",
        "인허가 단계의 기준일은 2024-11-25이며 2026-10-03 확인일이 최신 승인·진척을 뜻하지 않음",
        "카운티 신청의 태양광 약 240MW와 개발사 발표의 235MW는 발전계획 · 전기분해 부하와 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_POLA_ZEPEO_CA",
      "name": "Port of Los Angeles ZEPEO",
      "region": "West",
      "state": "CA",
      "sector": "other",
      "classification": "announced",
      "status": "planned",
      "capacityMw": null,
      "capacityBasis": "unknown",
      "sourceName": "Port of Los Angeles — 2026-05-28 항만위원회 안건 7, ZEPEO MOU",
      "sourceUrl": "https://portoflosangeles.org/commission/agenda-archive-and-videos/agendas/2026/05282026-regular-agenda",
      "sourceAsOf": "2026-05-28",
      "checkedAt": "2026-10-03",
      "evidence": "환경심사 채택 확인 · 2030년 추가 213MVA, 2035년 추가 306MVA 전력시설 MOU 계획이며 MW 환산·단일 수용가 집계 불가 공개 근거 기준일: 2026-05-28. 출처: Port of Los Angeles — 2026-05-28 항만위원회 안건 7, ZEPEO MOU (2026-05-28): https://portoflosangeles.org/commission/agenda-archive-and-videos/agendas/2026/05282026-regular-agenda | Port of Los Angeles — ZEPEO 환경문서 채택 이력 (발행일 미공개): https://portoflosangeles.org/environment/environmental-documents | Port of Los Angeles — LADWP 협력 개요, 추가 200MVA 표기 (발행일 미공개): https://portoflosangeles.org/environment/air-quality/cooperative-agreement",
      "caveats": [
        "비교 가능한 전체 수용가 전력용량이 미확인입니다. 개별 설비 정격·과거 전망·기준 불명 공시를 대신 넣지 않습니다.",
        "213MVA·306MVA는 피상전력 전력시설 규모 · 역률 근거가 없어 MW로 환산하지 않으며 capacities 배열은 비워 둠",
        "항만 전체 기반시설 사업으로 개별 터미널의 서비스 요청과 중복 가능 · 하나의 고객·공식 큐 항목으로 집계 불가",
        "2035년 306MVA와 2030년 213MVA의 중복 범위가 명확하지 않아 두 수치를 합산하지 않음",
        "안건에 예정된 2026-07-14 LADWP MOU 표결의 후속 승인 결과 미확보",
        "날짜 없는 사업 개요의 추가 200MVA와 2026-05-28 MOU 안건 수치는 범위·시점이 달라 별도 보존",
        "공식 수용가 큐 ID와 계통 신청 MW 미확보",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_APMT_PIER400_CA",
      "name": "APM Terminals Pier 400 전력 증설",
      "region": "West",
      "state": "CA",
      "sector": "other",
      "classification": "announced",
      "status": "operating",
      "capacityMw": 18,
      "capacityBasis": "site_power_mw",
      "sourceName": "ZEPA — Pier 400 running to net zero, 참여 기업과 공동 발행한 사례 자료",
      "sourceUrl": "https://portelectrification.com/case-studies/pier-400",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "evidence": "전기 화물취급장비 일부 운영 확인 · 계통 공급능력 7→18MW 증설을 설명하지만 18MW 전체 통전 완료는 미확인 공개 근거 기준일: 미공개. 원문 용량 공시(서로 합산하지 않음): 18 MW — 계통 공급능력 7→18MW 증설 목표의 최종 총량 · 18MW 신규 증분이나 완료 통전 MW 아님 / 7 MW — 같은 자료가 제시한 기존 계통 공급능력 · 목표 18MW와 합산 불가. 출처: ZEPA — Pier 400 running to net zero, 참여 기업과 공동 발행한 사례 자료 (발행일 미공개): https://portelectrification.com/case-studies/pier-400",
      "caveats": [
        "표시 용량의 원문 기준: 계통 공급능력 7→18MW 증설 목표의 최종 총량 · 18MW 신규 증분이나 완료 통전 MW 아님",
        "일부 운영·인도와 전체 개발계획이 공존합니다. 전 부지 완공·계약용량 전량 소비·대기 종료를 뜻하지 않습니다.",
        "출처 하단은 수치 기준을 2025년 중반으로 적지만 본문은 2025년 실적과 올해라는 표현을 포함 · 정확한 게시일·전체 수치 기준일 미확정",
        "기존 장비의 운영을 계통 공급능력 18MW 증설 완료로 해석하지 않음",
        "공식 접속 큐 ID·계통 신청 MW 미확보 · 18MW는 목표 총 공급능력",
        "ZEPEO 등 항만 전체 전력시설 계획과 중복 가능하여 합산 불가",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ],
      "linkedProjectId": null
    },
    {
      "id": "named:NAMED_GOOGLE_DISK_DRIVE_CA",
      "name": "Google 5079 Disk Drive — San Jose",
      "region": "CAISO",
      "state": "CA",
      "sector": "data_center",
      "classification": "application",
      "status": "planned",
      "capacityMw": 250,
      "capacityBasis": "requested_grid_mw",
      "sourceName": "CPUC — 결의안 E-5455 초안, PG&E·Google 250MW 예외 서비스 신청",
      "sourceUrl": "https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M607/K718/607718746.PDF",
      "sourceAsOf": "2026-10-02",
      "checkedAt": "2026-10-08T08:43:36.935871+00:00",
      "evidence": "PG&E의 250MW·230kV 서비스 신청과 예비 엔지니어링 완료 확인 · CPUC 승인안은 2026-10-08 회의로 보류되어 10월 8일 KST 확인 당시 최종 표결 전; 승인·통전으로 표시 불가 공개 근거 기준일: 2026-10-02. 원문 용량 공시(서로 합산하지 않음): 250 MW — CPUC 공식 자료의 전면 개발 시 예상 소매 전력수요 · 230kV 서비스 신청 250MW, 규제승인·통전 대기. 출처: CPUC — 결의안 E-5455 초안, PG&E·Google 250MW 예외 서비스 신청 (2026-07-16): https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M607/K718/607718746.PDF | CPUC — 2026-10-08 회의 안건, 10월 2일 발행, 3~4쪽 (2026-10-02): https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M622/K069/622069835.pdf | CPUC — 2026-09-17 회의 최종 보류 목록 (2026-09-15): https://docs.cpuc.ca.gov/PublishedDocs/Published/G000/M619/K318/619318894.PDF",
      "caveats": [
        "표시 용량의 원문 기준: CPUC 공식 자료의 전면 개발 시 예상 소매 전력수요 · 230kV 서비스 신청 250MW, 규제승인·통전 대기",
        "250MW는 공식 서비스 신청의 전면 개발 예상 부하로 확인되지만 공개된 개별 큐 ID는 미확보",
        "Advice Letter 7785-E와 결의안 E-5455는 공시·규제 문서 ID이며 수용가 큐 ID가 아님 · queueId와 gridRequestMW는 null, 확인된 250MW는 용량 근거에 보존",
        "결의안 초안의 승인한다는 문구는 제안 결과 · 2026-10-03 현재 실제 의결·최종승인으로 해석 불가",
        "2027년 1월 착공과 2028년 12월 운영은 신청인의 목표 일정 · 완료된 단계가 아님",
        "확정 공사비·최종 서비스 계약 조건·통전일 및 실제 인출량 미확보",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "2026-10-08 위 1차 출처의 해당 공시를 재확인했습니다. 다른 인용문서는 각 원래 공개일·이전 확인일 기준이며 이후 상태를 뜻하지 않습니다.",
        "2026-10-08 미국 태평양 11시 회의는 한국 10월 9일 03시입니다. 10월 8일 KST 확인 당시 최종 표결 전이며, 안건을 최종 승인으로 표시하지 않습니다.",
        "공식 자료에 서비스 신청이 명시되어 신청으로 분류합니다. 공개 큐 ID와 기존 원장 행 연결이 없으므로 기존 활성 신청 53건의 점수 분모에는 추가하지 않습니다. PG&E 집계와 중복 가능성이 있습니다."
      ],
      "linkedProjectId": null
    }
  ],
  "aggregates": [
    {
      "id": "disclosure:WEST-PGE-20260630-DC-PIPELINE",
      "region": "CAISO",
      "name": "Pacific Gas and Electric (PG&E) · 신규 20 MW 이상 데이터센터 단계별 파이프라인 합계",
      "capacityMw": 12710.0,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "exact",
      "sourceName": "PG&E Corporation Q2 2026 Earnings Presentation — slide 7 and slide 18 endnotes",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/75488/000100498026000047/q226earningspresentation.htm",
      "sourceAsOf": "2026-06-30",
      "checkedAt": "2026-10-03",
      "scope": "PG&E 서비스 구역의 20 MW 이상 신규 데이터센터. CAISO 전체 대기열이 아닌 일부 지역 집계이며, 개별 프로젝트명·위치 미공개. 총 12,710 MW: 신청·예비설계 8,200, 최종설계 3,880, 접속공사 계약 490, 공사 중 140 MW. 예비설계에는 50만 달러 연구비, 최종설계에는 WPA 체결과 설계·조달비 납부(추정 사업비 10%) 필요. 통전 후 공사 단계에서 제외. 2026년 3월 수치는 강화된 2분기 기준으로 재작성. 단계별 공시: 신청·예비설계: 8.2 GW (서명한 신청서 제출 및 예비설계 연구비 50만 달러 납부.) 최종설계: 3.88 GW (WPA 체결 및 추정 사업비 10%에 해당하는 설계·조달비 납부.) 접속공사 계약: 0.49 GW (접속공사 계약(Interconnection Construction Agreement) 체결.) 공사 중: 0.14 GW (고객 통전 전 공사 단계.)",
      "caveats": [
        "SCE·SDG&E 등 미포함. 프로젝트별 용량·일정·병목 원인 미공개. 2026-10-03에 검증한 6월 말 자료이며, 10월 현황 아님.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-23; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:ERCOT_LARGE_LOAD_REQUESTS_20260618",
      "region": "ERCOT",
      "name": "ERCOT · 공식 추적 중인 대규모 부하 접속 요청",
      "capacityMw": 438000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "greater_than",
      "sourceName": "PUCT Approves ERCOT's Batch Zero Process for Connecting Large Electricity Users While Protecting System Reliability for Texans",
      "sourceUrl": "https://www.ercot.com/news/release/06182026-puct-approves-ercots",
      "sourceAsOf": null,
      "checkedAt": "2026-10-08T08:43:33.498140+00:00",
      "scope": "ERCOT이 추적하는 대규모 부하 요청 전체 집계. 6월 발표치로 9월 Batch Zero 적격 집합과 기준일·대상 차이. Oncor 등 개별 유틸리티와 중복 가능. ERCOT은 438,000 MW 초과의 대규모 부하 요청을 추적 중이며 약89%는 데이터센터 수요로 공시. 발전설비 용량 및 확정 통전량과 다른 지표.",
      "caveats": [
        "고객별 ID·요청 MW·연구단계 전수 명부 미확보. NPRR1267은 고객 정보 기밀성에 따라 집계 공개 요구.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-06-18; 원자료 기준일과 구별합니다.",
        "2026-06-18 발표 당시 추적 중인 요청 · 정확 추출 기준일 미명시",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:ERCOT_CENTERPOINT_BATCHZERO_SUBMISSION_20260728",
      "region": "ERCOT",
      "name": "CenterPoint Houston Electric · Batch Zero 제출 용량 하한",
      "capacityMw": 17000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "greater_than",
      "sourceName": "CenterPoint Energy Reports Strong Q2 2026 Results",
      "sourceUrl": "https://investors.centerpointenergy.com/news-releases/news-release-details/centerpoint-energy-reports-strong-q2-2026-results-provides",
      "sourceAsOf": "2026-07-28",
      "checkedAt": "2026-10-08T08:43:31.388799+00:00",
      "scope": "CenterPoint Houston Electric 제출부분집합; ERCOT 중앙 큐와 중복 가능. 17 GW 초과 제출. 그중 약 14 GW가 Base/Studied 적격으로 예상되며 2031년까지 서비스 전망.",
      "caveats": [
        "7월 예상치이므로 9월 조건부 결과로 대체 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-28; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:ERCOT_LLWG_ALL_LOAD_STATUS_20260618",
      "region": "ERCOT",
      "name": "ERCOT · 대규모 부하 접속 절차 전체 추적량·단계별 구성",
      "capacityMw": 466500.0,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "approximate",
      "sourceName": "ERCOT 대규모 부하 접속 현황 — 2026년 6월 19일 LLWG 자료",
      "sourceUrl": "https://www.ercot.com/files/docs/2026/06/18/June-19-LLWG-Report.pptx",
      "sourceAsOf": "2026-06-18",
      "checkedAt": "2026-10-08T08:43:33.621871+00:00",
      "scope": "2022~2033년 접속·가동 연도별 누적 도표의 전체 대상: 운영 부하와 미가동·검토·연구 미제출 프로젝트가 함께 포함된 LLIS 집계. 6월 정리 과정에서 중복·취소 티켓 제거 및 동일 부하의 단계별 티켓 통합. 438 GW 초과 보도자료, Oncor·CenterPoint 집계 및 Batch Zero 집계와 중첩되므로 합산 불가. 공식 자료 4쪽의 전체 추적량 466.5 GW. 연구 미제출 257.6, ERCOT 검토 중 151.1, 9.4조 연구요건만 충족 11.8, 9.4·9.5조 연구·이행약정 요건 충족 37.1, 통전 승인 후 미가동 3.2, 관측 가동 5.7 GW. 5.7 GW는 개별 부하의 역대 비동시 최대 소비량 합계. 별도 8·9쪽의 6월 관측치는 비동시 3.900 GW, 동시 3.675 GW로 구별. 단계별 공시: 연구 미제출: 257.6 GW (Planning Guide 9.3.2조 연구 착수 절차 요건 미충족) ERCOT 검토 중: 151.1 GW (Planning Guide 9.3.3조에 따른 연구 절차 진행 중) 연구요건만 충족 — 9.4조: 11.8 GW (필수 LLIS 연구 완료, 9.5조 이행약정 요건 미충족; 중요 가정 변경 시 재연구 가능) 연구·이행약정 요건 충족 — 9.4·9.5조: 37.1 GW (필수 LLIS 연구와 9.5조 이행약정 요건 충족; 운영부서의 통전 승인과 구분) 통전 승인 후 미가동: 3.2 GW (ERCOT 운영부서 통전 승인 취득, 실제 운영은 아직 관측되지 않은 MW) 관측 가동 — 역대 비동시 최대치: 5.7 GW (통전 승인 및 실제 운영 관측; 각 부하의 역대 최대 소비량을 합산한 비동시 수치)",
      "caveats": [
        "운영·통전 용량을 포함한 혼합 집계이며 순수 미통전 잔여량이 아닙니다.",
        "공개 고객별 전수 명부와 LLI 매칭 부재. 466.5 GW는 확정 계약량·신규 미통전 대기량·동시 최대수요가 아님. 5.7 GW 관측 가동과 8.927 GW 통전 승인량도 서로 다른 기준. 같은 날 보도자료의 438 GW 초과 수치와 정확한 추출시점·범위 차이는 미해결.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-06-18; 원자료 기준일과 구별합니다.",
        "자료 2쪽의 기본 기준일 2026-06-18; 웹 게시일 2026-06-18, LLWG 발표일 2026-06-19. 별도 6월 2일 Batch Zero 도표는 본 수치에 미사용.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:ERCOT_ONCOR_BATCHZERO_EXPECTED_20260806",
      "region": "ERCOT",
      "name": "Oncor · 당시 예상 Batch Zero 적격 용량",
      "capacityMw": 44000,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "approximate",
      "sourceName": "Oncor Reports Second Quarter 2026 Results",
      "sourceUrl": "https://www.oncor.com/content/oncorwww/wire/en/home/newsroom/oncor-reports-second-quarter-2026-results.html",
      "sourceAsOf": "2026-08-06",
      "checkedAt": "2026-10-08T08:43:31.388093+00:00",
      "scope": "9월 ERCOT 조건부 분류보다 이전의 Oncor 예상치. 당시 예상 적격 약 44 GW = Base Load 27 GW + Studied Load 17 GW. 이 중 약 8 GW는 기존 연계되어 승인용량까지 램프 중인 부하.",
      "caveats": [
        "운영·통전 용량을 포함한 혼합 집계이며 순수 미통전 잔여량이 아닙니다.",
        "44 GW를 신규 미통전 대기량으로 간주 금지. 8 GW 차감은 미통전확정량을 보장하지 않음.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-06; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:ERCOT_ONCOR_DC_REQUESTS_2026Q2",
      "region": "ERCOT",
      "name": "Oncor · 송전 데이터센터 연계요청 용량",
      "capacityMw": 282000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "approximate",
      "sourceName": "Oncor Reports Second Quarter 2026 Results",
      "sourceUrl": "https://www.oncor.com/content/oncorwww/wire/en/home/newsroom/oncor-reports-second-quarter-2026-results.html",
      "sourceAsOf": "2026-06-30",
      "checkedAt": "2026-10-08T08:43:31.388093+00:00",
      "scope": "Oncor 서비스 구역의 활성 송전 LC&I 요청; ERCOT Batch Zero 적격 집합과 다른 모집단. 기타 산업 >16 GW는 282 GW에 미포함. 2026년 6월 말 활성 대규모 상업·산업 송전 연계요청 737건. 데이터센터 약 282 GW, 기타 산업 16 GW 초과로 구분 공시.",
      "caveats": [
        "고객별 익명 ID·단계·요청 MW 명부 없음. ERCOT 전체 요청 또는 신규 대기량으로 대체 금지.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-06; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:AWS_NIPSCO_NORTHERN_INDIANA",
      "region": "MISO",
      "name": "AWS Northern Indiana — NIPSCO 신규 캠퍼스 묶음",
      "capacityMw": 2400,
      "projectCount": null,
      "capacityBasis": "site_power_mw",
      "capacityQualifier": "exact",
      "sourceName": "Amazon Northern Indiana 신규캠퍼스 투자 발표",
      "sourceUrl": "https://www.aboutamazon.com/news/company-news/amazon-15-billion-indiana-data-centers",
      "sourceAsOf": "2025-11-24",
      "checkedAt": "2026-10-03",
      "scope": "복수 신규 캠퍼스의 계획 전력량입니다. 단일 사업이나 Project Rainier 전체로 치환하지 않습니다. 2025-11-24 신규캠퍼스 투자 계획 발표; 개별 사이트별 공사상태 미확보",
      "caveats": [
        "개별 캠퍼스 명칭·주소·용량 분해",
        "공식 수용가 접속 원장 ID",
        "통전 완료 MW",
        "개별 수요 램프 일정",
        "최종 클라우드 수용가",
        "AWS 투자·유틸리티 공급관계 확인 가능. 단일 부지 또는 Anthropic Project Rainier로 임의 치환 금지",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다."
      ]
    },
    {
      "id": "disclosure:MISO_AMEREN_CONSTRUCTION_AGREEMENTS_2026Q2",
      "region": "MISO",
      "name": "Ameren Missouri · 개발사와 체결한 건설계약 수요",
      "capacityMw": 3400.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Ameren Form 10-Q, quarter ended June 30, 2026",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/1002910/000100291026000023/aee-20260630.htm",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "scope": "Ameren Missouri 계약 부분집합. 건설계약은 공사 착수 증거가 아님. 개발사와 체결한 건설계약은 3.4 GW. 전력서비스계약 2.8 GW 포함으로 명시.",
      "caveats": [
        "3.4 + 2.8 합산 금지. 두 계약 집합 포함관계만 확인됨.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-03; 원자료 기준일과 구별합니다.",
        "정확 수치 기준일 미명시 · 보고기간 종료 2026-06-30 · 2026-08-03 공시"
      ]
    },
    {
      "id": "disclosure:MISO_AMEREN_ESA_2026Q2",
      "region": "MISO",
      "name": "Ameren Missouri · 체결 전력서비스계약 수요",
      "capacityMw": 2800.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Ameren Corporation / Union Electric Company Form 10-Q, quarter ended June 30, 2026",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/1002910/000100291026000023/aee-20260630.htm",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "scope": "Ameren Missouri 고객 계약 부분집합. asOf는 공시일이며 보고기간은 2026-06-30 종료. MISO 전체 요청·계약 총량이 아님. 2026년 대규모 부하 고객과 전력서비스계약 체결, 합계 2.8 GW. 수요는 2027년 하반기부터 발생하여 2029년 말 최대용량 도달 예정. 별도 건설계약 3.4 GW에 이 2.8 GW가 포함됨.",
      "caveats": [
        "개별 고객별 용량 분해 미공개. 3.4 GW 건설계약과 합산 금지.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-03; 원자료 기준일과 구별합니다.",
        "정확 수치 기준일 미명시 · 보고기간 종료 2026-06-30 · 2026-08-03 공시"
      ]
    },
    {
      "id": "disclosure:MISO_DTE_GOOGLE_20260928",
      "region": "MISO",
      "name": "DTE Electric · Google 전력계약 부하·MPSC 조건부 승인",
      "capacityMw": 1000,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "MPSC Google PSA·CCAA 승인(2026-10-01); 용량은 DTE 2026-09-28 Business Update 기준",
      "sourceUrl": "https://www.michigan.gov/mpsc/commission/news-releases/2026/10/01/mpsc-approves-dte-electric-google-data-center-and-contracts-protects-customers-from-project-cost",
      "sourceAsOf": "2026-10-01",
      "checkedAt": "2026-10-03",
      "scope": "DTE Electric의 특정 고객 계약. 실행 계약 합계 2.4 GW 중 Google분. 발표 내 재생에너지·저장·수요반응 MW는 부하 요청 용량으로 제외. DTE 9월28일 공시의 Google 계약부하1.0GW. 10월1일 MPSC의 PSA·CCAA 조건부 승인; 20년 계약·80% 최소요금, 공급개시2027년12월 및 최대부하2028년12월 예상.",
      "caveats": [
        "전력서비스 계약조건 승인과 입지·건축허가·접속심사·실제 통전의 구별. 최종 접속원장 ID·통전MW 미확보.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-10-01; 원자료 기준일과 구별합니다.",
        "1.0GW 용량은 DTE 2026-09-28 발표값 유지; 승인상태 2026-10-01 갱신"
      ]
    },
    {
      "id": "disclosure:MISO_DTE_ORACLE_20260928",
      "region": "MISO",
      "name": "DTE Electric · Oracle 계약 승인·공사 착수 부하",
      "capacityMw": 1400.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "DTE Energy Business Update September 28, 2026, slides 3, 6, 12",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/936340/000093634026000159/dtebusinessupdate92826fi.htm",
      "sourceAsOf": "2026-09-28",
      "checkedAt": "2026-10-03",
      "scope": "DTE Electric의 특정 고객 계약. 같은 발표의 실행 계약 합계 2.4 GW 중 Oracle분. Oracle 1.4 GW 계약은 MPSC 승인 완료, 공사 착수 상태. 수요는 2027~2028년 증가 예정.",
      "caveats": [
        "현장별 연계 ID와 송전보강 완료일 미확보. 2.4 GW 합계와 중복 집계 금지.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-28; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:MISO_MTEP26_EPR_LOAD_20260817",
      "region": "MISO",
      "name": "MISO · MTEP26 EPR 송전사업이 지원하는 대규모 부하",
      "capacityMw": 32600.0,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "exact",
      "sourceName": "MTEP26 Report Preview, Planning Advisory Committee August 26, 2026, updated Aug 26, slides 3–4",
      "sourceUrl": "https://cdn.misoenergy.org/20260826%20PAC%20Item%2005%20PAC%20MTEP26%20Preview%20Update776960.pdf",
      "sourceAsOf": "2026-08-17",
      "checkedAt": "2026-10-03",
      "scope": "MTEP26 송전계획에 포함된 지원 부하량. 119개 EPR과 562개 전체 송전사업으로 구성된 예비 포트폴리오 관련량이며 고객 요청 큐 전수 아님. EPR cycle은 2025년 9월 시작. EPR 송전사업이 지원하는 대규모 부하 32.6 GW: 이미 승인 20.3 GW + 추가 제안 12.3 GW. 4쪽 요약 33 GW는 반올림치. 권역 West 5.8 / East 2.4 / Central 16.7 / South 7.7 GW.",
      "caveats": [
        "승인 상태는 송전계획 승인이지 고객 계약·통전 승인과 동일하지 않음. 2026-10-03 현재 이 조사에서 확보한 수치 기준일은 8월 17일.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-26; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:pjm-dom-cloa-202607",
      "region": "PJM",
      "name": "Dominion Energy Virginia · CLOA 체결용량",
      "capacityMw": 9356.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Dominion Energy LSE 20-Year Data Center Forecast",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5ai---dominion_energy.pdf",
      "sourceAsOf": "2026-07",
      "checkedAt": "2026-10-08T08:43:31.386094+00:00",
      "scope": "Dominion LSE 데이터센터 공사승인 계약 p6: CLOA 9,356MW; p5: firm 분류",
      "caveats": [
        "공사승인 계약과 물리적 착공 별도; 인허가·망 보강 공정·목표통전일 미공개",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:pjm-dom-eloa-202607",
      "region": "PJM",
      "name": "Dominion Energy Virginia · ELOA 체결용량",
      "capacityMw": 32473.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Dominion Energy LSE 20-Year Data Center Forecast",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5ai---dominion_energy.pdf",
      "sourceAsOf": "2026-07",
      "checkedAt": "2026-10-08T08:43:31.386094+00:00",
      "scope": "Dominion LSE 데이터센터 계약; DOM transmission zone 전체와 구별 p6: July 2026 기준 ELOA 32,473MW; 엔지니어링 승인 계약",
      "caveats": [
        "개별 ID·중복·미통전 잔량 미공개; ELOA는 계통심사 완료나 착공 증거와 구별",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:pjm-dom-esa-202607",
      "region": "PJM",
      "name": "Dominion Energy Virginia · ESA 체결용량",
      "capacityMw": 11997.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Dominion Energy LSE 20-Year Data Center Forecast",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5ai---dominion_energy.pdf",
      "sourceAsOf": "2026-07",
      "checkedAt": "2026-10-08T08:43:31.386094+00:00",
      "scope": "Dominion LSE 데이터센터 서비스계약 p6: ESA 11,997MW; p5: firm 분류",
      "caveats": [
        "가동/미통전 계약용량 분리 불가; 청구피크 4.8GW와 단순 차감 금지",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:pjm-dom-eloa-excluded-202607",
      "region": "PJM",
      "name": "Dominion Energy Virginia · 전망 제외 ELOA 계약용량",
      "capacityMw": 19044.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Dominion Energy LSE 20-Year Data Center Forecast",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5ai---dominion_energy.pdf",
      "sourceAsOf": "2026-07",
      "checkedAt": "2026-10-08T08:43:31.386094+00:00",
      "scope": "ELOA 전체의 부분집합 p6: ELOA 32,473MW 중 19,044MW 전망 제외",
      "caveats": [
        "전망 제외는 취소·철회·병목해소 증거가 아닌 전망 처리",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:pjm-exelon-pipeline-20260929",
      "region": "PJM",
      "name": "Exelon (ComEd / PECO) · 총 데이터센터 파이프라인",
      "capacityMw": 37000,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "approximate",
      "sourceName": "Exelon 2027 PJM Large Load Submission",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5i---exelon.pdf",
      "sourceAsOf": "2026-09-29",
      "checkedAt": "2026-10-08T08:43:31.387544+00:00",
      "scope": "ComEd 및 PECO 데이터센터; 기존 가동 포함 p3: total pipeline 37GW, 포함 약12GW·제외25GW",
      "caveats": [
        "운영·통전 용량을 포함한 혼합 집계이며 순수 미통전 잔여량이 아닙니다.",
        "접속대기열 단독합계 아님; 반올림·개별ID·미통전 잔량 미공개",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:pjm-fe-oe-contract-20260929",
      "region": "PJM",
      "name": "FirstEnergy Ohio Edison · Under contract 프로젝트용량",
      "capacityMw": 1628.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "FirstEnergy Large Load Adjustment Presentation",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5h---firstenergy.pdf",
      "sourceAsOf": "2026-09-29",
      "checkedAt": "2026-10-03",
      "scope": "FirstEnergy ATSI 하위 OE 구역 p12: OE 9개 under contract 프로젝트, 1,628MW",
      "caveats": [
        "다단계 프로젝트 수 중복 가능; 가동·대기 구분 비공개",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:pjm-fe-pe-contract-20260929",
      "region": "PJM",
      "name": "FirstEnergy Potomac Edison · Under contract 프로젝트용량",
      "capacityMw": 2496.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "FirstEnergy Large Load Adjustment Presentation",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5h---firstenergy.pdf",
      "sourceAsOf": "2026-09-29",
      "checkedAt": "2026-10-03",
      "scope": "FirstEnergy APS 하위 PE 구역 p10: PE 6개 under contract 프로젝트, 2,496MW",
      "caveats": [
        "다단계 프로젝트 수 중복 가능; 가동·대기 구분 비공개",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:pjm-fe-growth-2035",
      "region": "PJM",
      "name": "FirstEnergy · 2035년까지 신규 계약·파이프라인",
      "capacityMw": 22000,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "approximate",
      "sourceName": "FirstEnergy Large Load Adjustment Presentation",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5h---firstenergy.pdf",
      "sourceAsOf": "2026-09-29",
      "checkedAt": "2026-10-03",
      "scope": "FirstEnergy; ATSI·APS 중심 p3: Growth Contract & Pipeline 약22GW, 기존 contracted/active 약2GW 제외",
      "caveats": [
        "약값; 계약/미계약 분할 및 개별 위치·단계 미공개; 102GW 연구요청의 부분집합 가능성",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:pjm-fe-study-20260929",
      "region": "PJM",
      "name": "FirstEnergy · 연구 요청 총용량",
      "capacityMw": 102000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "FirstEnergy Large Load Adjustment Presentation",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5h---firstenergy.pdf",
      "sourceAsOf": "2026-09-29",
      "checkedAt": "2026-10-08T08:43:31.387101+00:00",
      "scope": "FirstEnergy PJM 서비스구역; 신청 연구대상 총량 p3: Total FE study requested 102GW",
      "caveats": [
        "현재 유효·취소·중복 제거 범위 미공개",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:pjm-ppl-requests-20260929",
      "region": "PJM",
      "name": "PPL Electric Utilities · 2024년9월 이후 누적 대규모 부하 요청",
      "capacityMw": 240000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "greater_than",
      "sourceName": "PPL Service Territory 2027 Large Load Forecast Adjustment",
      "sourceUrl": "https://www.pjm.com/-/media/DotCom/committees-groups/subcommittees/las/2026/20260929/20260929-item-5e---ppl.pdf",
      "sourceAsOf": "2026-09-29",
      "checkedAt": "2026-10-08T08:43:31.386701+00:00",
      "scope": "PPL Pennsylvania; initial inquiry/high-level assessment 포함 p3: 2024년9월 이후 요청 240GW 초과",
      "caveats": [
        "누적접수량이므로 현재 유효큐·중복제거·취소차감 불명; 발전큐와 단순비교 금지",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-29; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:SPP-EVERGY-ESA-10Q-20260630",
      "region": "SPP",
      "name": "Evergy · 2026 체결 데이터센터 ESA의 예상 정상상태 최대부하",
      "capacityMw": 2600.0,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "approximate",
      "sourceName": "Evergy 2026 Q2 Form 10-Q, Large Load Customers",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/1711269/000171126926000100/evrg-20260630.htm",
      "sourceAsOf": "2026-06-30",
      "checkedAt": "2026-10-03",
      "scope": "체결 ESA 포트폴리오의 예상 최종 부하. 일부 운영 포함; 비LLPS 고객 및 Evergy 전체 요청 파이프라인과 범위 차이. 10-Q는 3개 신규 및 2개 기존 프로젝트 확장 ESA에 약 2,600 MW 명시. 서비스는 2026~2028년 개시 또는 예정이며 일부 고객의 2026년 서비스 개시도 보고. 8월 발표자료의 약 2.5 GW와 반올림·정의 차이 해소 전 독립 지표로 보존.",
      "caveats": [
        "운영·통전 용량을 포함한 혼합 집계이며 순수 미통전 잔여량이 아닙니다.",
        "프로젝트별 MW·부분 통전량·동일 ESA 변경이력 미공개. 전체를 미통전 큐로 처리 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-06; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SPP-EVERGY-ADDITIONAL-ESA-20260806",
      "region": "SPP",
      "name": "Evergy · 추가 발표 프로젝트 중 체결 ESA 정상상태 최대부하",
      "capacityMw": 1700.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "approximate",
      "sourceName": "Evergy Second Quarter 2026 Earnings Presentation, slide 7",
      "sourceUrl": "https://investors.evergy.com/static-files/73352465-a5e0-4dbf-ac4b-98692902443f",
      "sourceAsOf": "2026-08-06",
      "checkedAt": "2026-10-03",
      "scope": "Evergy Kansas/Missouri 서비스 권역의 추가 체결 프로젝트. SPP 전체 큐 아님. Tier 1 약 3 GW는 운영 개시 프로젝트의 최종 램프 약 1.3 GW와 추가 발표·ESA 체결 약 1.7 GW로 구분. 추가 계약에는 16~17년 최소요금 의무. 1.3 GW는 현재 실제 사용량이 아님.",
      "caveats": [
        "1.7 GW의 프로젝트별 분할 및 남은 망보강 단계 미공개; 원장·DPNS 중복 가능.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-06; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SPP-OGE-GOOGLE-3SITES-20260430",
      "region": "SPP",
      "name": "OG&E · Google 신규 데이터센터 3개 부지 전력서비스 계약; MW 미공개",
      "capacityMw": null,
      "projectCount": null,
      "capacityBasis": "unknown",
      "capacityQualifier": "exact",
      "sourceName": "OGE Energy 2026 Q2 Form 10-Q, Oklahoma Google Special Contract",
      "sourceUrl": "https://ogeenergy.gcs-web.com/static-files/98fd12b7-a142-42e5-b6b4-91a0476ea50b",
      "sourceAsOf": "2026-07-29",
      "checkedAt": "2026-10-03",
      "scope": "Google 3개 부지 계약. 관련 태양광 2개 발전소 용량은 수용가 용량 아님. 4월 30일 회사 발표는 Muskogee·Stillwater 3개 신규 데이터센터 계약 확인. 7월 29일 10-Q는 5월 OCC 승인 신청 및 9월 9일 예정 심리 명시. 확인된 출처에는 수용가 MW 없음; 심리 일정 경과를 승인·통전으로 간주하지 않음.",
      "caveats": [
        "계약 MW 및 2026-10-03 현재 승인·통전 상태 미확보. 수량 3건만 확인.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-29; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SE_APC_CONTRACT_20260730",
      "region": "Southeast",
      "name": "Alabama Power · 대규모 부하 고객 계약상 최종 수요",
      "capacityMw": 4000,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Southern Company Second Quarter 2026 Earnings Conference Call, slide 11",
      "sourceUrl": "https://s27.q4cdn.com/273397814/files/doc_financials/2026/q2/SO-2026-Q2-Earnings-Call-Final.pdf",
      "sourceAsOf": "2026-07-30",
      "checkedAt": "2026-10-03",
      "scope": "Alabama Power 서비스구역. Alabama 주 전체·TVA·PowerSouth 제외. 신규 계약 추가량이 아닌 계약 포트폴리오 최종 ramp. 공식 전력회사별 계약 수요 도표: Alabama Power 4GW. 회사 계약 범주는 서명 완료 또는 고객 합의 완료·규제검토 대기를 포함.",
      "caveats": [
        "개별 프로젝트ID/명칭/MW/규제승인/통전분/남은 ramp 미공개. 해당 GW를 순수 미통전 queue로 간주할 수 없음.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-30; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SE_DUKE_CAROLINAS_GAP",
      "region": "Southeast",
      "name": "Duke Energy Carolinas / Duke Energy Progress · Carolinas만의 공개 대규모 부하 대기열·계약 총계",
      "capacityMw": null,
      "projectCount": null,
      "capacityBasis": "unknown",
      "capacityQualifier": "exact",
      "sourceName": "Duke Energy Q1 2026 Earnings Presentation; current IR quarterly-results portal",
      "sourceUrl": "https://s201.q4cdn.com/583395453/files/doc_financials/2026/q1/Q1-2026-Earnings-Presentation-w-Reg-G.pdf",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "scope": "Duke 기업 전체 값을 Southeast로 배정하지 않음. 확인된 기업 전체 ESA 공시는 Carolinas/Florida/PJM/MISO를 분리하지 않음. 이번 조사에서는 Carolinas 전용 수치를 검증하지 못함.",
      "caveats": [
        "기업 전체 계약의 Carolinas 분해 및 프로젝트 원장 미확보",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-05-05; 원자료 기준일과 구별합니다.",
        "Carolinas 전용 수치 미확보"
      ]
    },
    {
      "id": "disclosure:southeast-duke-developing-2026irp",
      "region": "Southeast",
      "name": "Duke Energy Carolinas / Duke Energy Progress · 개발 검토 프로젝트(6 GW에 근접)",
      "capacityMw": 6000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "approximate",
      "sourceName": "Phillip O. Stillman 직접 증언서, SCPSC 사건 2026-8-E / 2026-10-E, 10쪽 표 1",
      "sourceUrl": "https://dms.psc.sc.gov/Attachments/Matter/4975de54-4beb-444e-9ca1-0f0ee7016b3b",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "scope": "DEC·DEP 개발 검토 목록의 부지 확정 상업·산업 사업. 표시한 최종 부하에는 전망 산정용 50% 할인 미적용. Stillman 증언서 9·11쪽: 추가 최종 부하 약 6,000 MW. 부지가 정해지고 계통 검토가 시작된 50 MW 초과 개별 사업으로, 부지 권리 확인서·용도지역 확인서·고객 정보서 제출 요구. 개발 진척 프로젝트 43건과 별도 집계.",
      "caveats": [
        "사업 수·명칭·개별 MW·정확한 기준일 미공개. 약 6,000 MW는 원문의 6,000 MW에 근접하되 그보다 작은 규모를 근사치로 표시한 값. 전체 초기 문의를 포괄하는 목록은 아님.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-25; 원자료 기준일과 구별합니다.",
        "2026년 IRP의 개발 검토 사업 집계. 정확한 기준 월은 미공개. 9월 25일 증언서에 6,000 MW에 근접한 규모로 재인용."
      ]
    },
    {
      "id": "disclosure:southeast-duke-advanced-202602",
      "region": "Southeast",
      "name": "Duke Energy Carolinas / Duke Energy Progress · 개발 진척 프로젝트",
      "capacityMw": 7941.0,
      "projectCount": null,
      "capacityBasis": "mixed_mw",
      "capacityQualifier": "exact",
      "sourceName": "Phillip O. Stillman 직접 증언서, SCPSC 사건 2026-8-E / 2026-10-E, 10쪽 표 1",
      "sourceUrl": "https://dms.psc.sc.gov/Attachments/Matter/4975de54-4beb-444e-9ca1-0f0ee7016b3b",
      "sourceAsOf": "2026-02",
      "checkedAt": "2026-10-03",
      "scope": "노스캐롤라이나·사우스캐롤라이나의 DEC·DEP 소매 상업·산업 고객 개발사업. 도매 고객 사업은 별도 집계. 2026년 봄 표 1: 개발 진척 프로젝트 43건, 7,941 MW. 부하 전망 할인 적용 전 최종 부하용량. 단계별 공시: 전력서비스계약(ESA): 4.332 GW (원문 정의에 따른 개발 진척 단계 구분. 통전 여부는 이 분류만으로 확인 불가.) 서한합의(Letter Agreement): 3.259 GW (원문 정의에 따른 개발 진척 단계 구분. 통전 여부는 이 분류만으로 확인 불가.) 협의 후기 프로젝트: 0.35 GW (원문 정의에 따른 개발 진척 단계 구분. 통전 여부는 이 분류만으로 확인 불가.)",
      "caveats": [
        "개별 사업 ID·명칭·업종별 배분·DEC/DEP 구분·부하 증가 일정·미통전 잔여 MW 미공개. 4월 표의 ESA 4,337 MW·총계 7,946 MW와 같은 보고서 본문 및 9월 표의 4,332 MW·7,941 MW 사이에 5 MW 차이.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-25; 원자료 기준일과 구별합니다.",
        "2026년 봄 자료 기준. 4월 17일 반기 보고서 2쪽에 2026년 2월 기준으로 명시. 9월 25일 증언서는 봄 집계표를 재인용한 것으로, 9월 신규 현황이 아님."
      ]
    },
    {
      "id": "disclosure:southeast-duke-letter-202602",
      "region": "Southeast",
      "name": "Duke Energy Carolinas / Duke Energy Progress · 서한합의(Letter Agreement)",
      "capacityMw": 3259.0,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Phillip O. Stillman 직접 증언서, SCPSC 사건 2026-8-E / 2026-10-E, 10쪽 표 1",
      "sourceUrl": "https://dms.psc.sc.gov/Attachments/Matter/4975de54-4beb-444e-9ca1-0f0ee7016b3b",
      "sourceAsOf": "2026-02",
      "checkedAt": "2026-10-03",
      "scope": "노스캐롤라이나·사우스캐롤라이나의 DEC·DEP 소매 상업·산업 고객 개발사업. 도매 고객 사업은 별도 집계. 2026년 봄 표 1: 서한합의(Letter Agreement) 24건, 3,259 MW. 부하 전망 할인 적용 전 최종 부하용량.",
      "caveats": [
        "개별 사업 ID·명칭·업종별 배분·DEC/DEP 구분·부하 증가 일정·미통전 잔여 MW 미공개. 4월 표의 ESA 4,337 MW·총계 7,946 MW와 같은 보고서 본문 및 9월 표의 4,332 MW·7,941 MW 사이에 5 MW 차이.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-25; 원자료 기준일과 구별합니다.",
        "2026년 봄 자료 기준. 4월 17일 반기 보고서 2쪽에 2026년 2월 기준으로 명시. 9월 25일 증언서는 봄 집계표를 재인용한 것으로, 9월 신규 현황이 아님."
      ]
    },
    {
      "id": "disclosure:southeast-duke-esa-202602",
      "region": "Southeast",
      "name": "Duke Energy Carolinas / Duke Energy Progress · 전력서비스계약(ESA)",
      "capacityMw": 4332.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Phillip O. Stillman 직접 증언서, SCPSC 사건 2026-8-E / 2026-10-E, 10쪽 표 1",
      "sourceUrl": "https://dms.psc.sc.gov/Attachments/Matter/4975de54-4beb-444e-9ca1-0f0ee7016b3b",
      "sourceAsOf": "2026-02",
      "checkedAt": "2026-10-03",
      "scope": "노스캐롤라이나·사우스캐롤라이나의 DEC·DEP 소매 상업·산업 고객 개발사업. 도매 고객 사업은 별도 집계. 2026년 봄 표 1: 전력서비스계약(ESA) 16건, 4,332 MW. 부하 전망 할인 적용 전 최종 부하용량.",
      "caveats": [
        "개별 사업 ID·명칭·업종별 배분·DEC/DEP 구분·부하 증가 일정·미통전 잔여 MW 미공개. 4월 표의 ESA 4,337 MW·총계 7,946 MW와 같은 보고서 본문 및 9월 표의 4,332 MW·7,941 MW 사이에 5 MW 차이.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-25; 원자료 기준일과 구별합니다.",
        "2026년 봄 자료 기준. 4월 17일 반기 보고서 2쪽에 2026년 2월 기준으로 명시. 9월 25일 증언서는 봄 집계표를 재인용한 것으로, 9월 신규 현황이 아님."
      ]
    },
    {
      "id": "disclosure:southeast-duke-late-202602",
      "region": "Southeast",
      "name": "Duke Energy Carolinas / Duke Energy Progress · 협의 후기 프로젝트",
      "capacityMw": 350.0,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Phillip O. Stillman 직접 증언서, SCPSC 사건 2026-8-E / 2026-10-E, 10쪽 표 1",
      "sourceUrl": "https://dms.psc.sc.gov/Attachments/Matter/4975de54-4beb-444e-9ca1-0f0ee7016b3b",
      "sourceAsOf": "2026-02",
      "checkedAt": "2026-10-03",
      "scope": "노스캐롤라이나·사우스캐롤라이나의 DEC·DEP 소매 상업·산업 고객 개발사업. 도매 고객 사업은 별도 집계. 2026년 봄 표 1: 협의 후기 프로젝트 3건, 350 MW. 부하 전망 할인 적용 전 최종 부하용량.",
      "caveats": [
        "개별 사업 ID·명칭·업종별 배분·DEC/DEP 구분·부하 증가 일정·미통전 잔여 MW 미공개. 4월 표의 ESA 4,337 MW·총계 7,946 MW와 같은 보고서 본문 및 9월 표의 4,332 MW·7,941 MW 사이에 5 MW 차이.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-09-25; 원자료 기준일과 구별합니다.",
        "2026년 봄 자료 기준. 4월 17일 반기 보고서 2쪽에 2026년 2월 기준으로 명시. 9월 25일 증언서는 봄 집계표를 재인용한 것으로, 9월 신규 현황이 아님."
      ]
    },
    {
      "id": "disclosure:SE_FPL_INTEREST_20260724",
      "region": "Southeast",
      "name": "Florida Power & Light · 대규모 부하 관심·서비스 협의 파이프라인",
      "capacityMw": 21000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "approximate",
      "sourceName": "NextEra Energy Q2 2026 financial results, SEC Exhibit99, FPL section",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/753308/000075330826000058/neeq22026exhibit99.htm",
      "sourceAsOf": "2026-07-24",
      "checkedAt": "2026-10-03",
      "scope": "FPL 전력 서비스구역만 포함; NextEra Energy Resources 발전계약 및 Dominion 제외. FPL은 약21GW의 대규모 부하 관심 수요를 공시. 이 가운데12GW는 협의 후반 단계이며 일부는2028년부터 공급 가능하다고 전망.",
      "caveats": [
        "관심 표명은 접속대기열 접수 또는 계약 확정과 다름. 프로젝트ID/용량/신청일/연구단계/보증금 미공개.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-24; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SE_FPL_ADVANCED_20260724",
      "region": "Southeast",
      "name": "Florida Power & Light · 대규모 부하 협의 후반 단계",
      "capacityMw": 12000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "NextEra Energy Q2 2026 financial results, SEC Exhibit99, FPL section",
      "sourceUrl": "https://www.sec.gov/Archives/edgar/data/753308/000075330826000058/neeq22026exhibit99.htm",
      "sourceAsOf": "2026-07-24",
      "checkedAt": "2026-10-03",
      "scope": "앞 행21GW의 부분집합. 기술 study 완료·공급계약 체결이 확인된 수치는 아님. 21GW 중12GW에 대해 advanced discussions 진행. 연말까지 적어도 한 건의 신규 tariff 거래 발표를 예상한다고 공시.",
      "caveats": [
        "협의 단계의 표준화된 기술심사 상태와 최종 계약MW가 부재.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-24; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SE_GPC_CONTRACT_20260730",
      "region": "Southeast",
      "name": "Georgia Power · 대규모 부하 고객 계약상 최종 수요",
      "capacityMw": 12500.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Southern Company Second Quarter 2026 Earnings Conference Call, slides 10–11",
      "sourceUrl": "https://s27.q4cdn.com/273397814/files/doc_financials/2026/q2/SO-2026-Q2-Earnings-Call-Final.pdf",
      "sourceAsOf": "2026-07-30",
      "checkedAt": "2026-10-03",
      "scope": "Georgia Power 서비스구역; 2026Q2 PSC 프로젝트 명세의 6월30일 CES9.572GW와 기준일·범주가 다름. Southern 총계와 중복. 동일 공식 도표의 Georgia Power 값은 12.5GW. 합계는 31개 프로젝트 17GW이며, Georgia RFS는 회사 분류상 late-stage 또는 finalizing에 해당.",
      "caveats": [
        "12.5GW에서 이미 통전된 부분과 순수 미통전 부하를 분리할 수 없음. PSC 개별행과 회사 집계 범위 연결 미확정.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-30; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SE_MPC_CONTRACT_20260730",
      "region": "Southeast",
      "name": "Mississippi Power · 대규모 부하 고객 계약상 최종 수요",
      "capacityMw": 500.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Southern Company Second Quarter 2026 Earnings Conference Call, slide 11",
      "sourceUrl": "https://s27.q4cdn.com/273397814/files/doc_financials/2026/q2/SO-2026-Q2-Earnings-Call-Final.pdf",
      "sourceAsOf": "2026-07-30",
      "checkedAt": "2026-10-03",
      "scope": "Mississippi Power 서비스구역. Mississippi 주 전체 및 Entergy Mississippi(MISO)·TVA 부하 제외. 동일 공식 도표의 Mississippi Power 값은 0.5GW.",
      "caveats": [
        "개별 고객 명단과 계약별 MW/통전일 미공개. Southern 총계에 이미 포함.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-30; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:SE_TVA_20260820_ANON_APPROVAL",
      "region": "Southeast",
      "name": "Tennessee Valley Authority · 익명 신규 직접공급 고객의 조건부 firm-power 승인",
      "capacityMw": null,
      "projectCount": null,
      "capacityBasis": "unknown",
      "capacityQualifier": "exact",
      "sourceName": "TVA Approved Resolutions — August20,2026 Power Availability",
      "sourceUrl": "https://tva-azr-eastus-cdn-ep-tvawcm-prd.azureedge.net/cdn-tvawcma/docs/default-source/about-tva/board-of-directors/august-20--2026/resolutions/board-resolution---power-availability-august-2026-v2.pdf?sfvrsn=ed264403_1",
      "sourceAsOf": "2026-08-20",
      "checkedAt": "2026-10-03",
      "scope": "단일 익명 고객. 공개 임계값은 >0.1GW이나 정확한MW가 비공개이므로 valueGW=null. SpaceXAI와 임의로 연결하지 않음. 승인목록에 등재된 결의는 신규 직접공급 고객의 필요부하가100MW 초과이며2026년11월부터 초기 공급을 요청했다고 명시. 계약·재무·운영 조건 충족을 전제로 승인.",
      "caveats": [
        "고객명·정확MW·최종 계약·실제통전일은 비공개 메모에 수록. 전국 대기열 합계에 더하지 않음.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-20; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:WEST-POR-20260131-DC-CONTRACTS",
      "region": "West",
      "name": "Portland General Electric (PGE) · 2025~2026 YTD 체결 데이터센터 5개 고객 계약용량",
      "capacityMw": 430.0,
      "projectCount": null,
      "capacityBasis": "contracted_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Portland General Electric July 31, 2026 Investor Presentation — slide 8",
      "sourceUrl": "https://investors.portlandgeneral.com/static-files/326e18d0-0240-4c90-81d9-78da69552f4c",
      "sourceAsOf": "2026-01-31",
      "checkedAt": "2026-10-03",
      "scope": "오리건 Portland General Electric 서비스 구역. PG&E(캘리포니아)와 별개이며, 오리건 전체·BPA 전체 집계 아님. 공개 고객명별 용량 배분 미제공. 2025~2026년 체결한 데이터센터 5개 고객 계약 430 MW. 용량 예치금·담보·해지 수수료 적용. 계약용량 도표에 포함되며 도표 각주의 기준일은 2026-01-31.",
      "caveats": [
        "전체 계약 도표는 운영·공사 용량을 함께 제시. 430 MW 중 이미 통전한 비중은 미공개이므로 순수 미통전 대기열로 사용 불가.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-31; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:WEST-POR-20260731-LARGELOAD-REQUESTS",
      "region": "West",
      "name": "Portland General Electric (PGE) · 2028년 이후 통전 목표의 추가 대규모 부하 요청",
      "capacityMw": 1700.0,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "Portland General Electric July 31, 2026 Investor Presentation — slide 8",
      "sourceUrl": "https://investors.portlandgeneral.com/static-files/326e18d0-0240-4c90-81d9-78da69552f4c",
      "sourceAsOf": null,
      "checkedAt": "2026-10-03",
      "scope": "Portland General Electric 서비스 구역의 추가 요청. 계약 집계와 구분해 제시했으나 프로젝트 ID가 없어 BPA 송전 요청과 중복 대조 불가. 2028년 이후 통전 목표의 추가 대규모 부하 요청 1.7 GW를 별도 제시. 체결 계약으로 분류하지 않음.",
      "caveats": [
        "프로젝트명·개별 용량·검토 완료·계약 전환 여부 미공개. 1월 각주는 계약용량 도표에 적용되며, 인접한 1.7 GW 문구의 정확한 기준일은 미명시.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-07-31; 원자료 기준일과 구별합니다.",
        "정확 기준일 미공개 · 2026-07-31 발표"
      ]
    },
    {
      "id": "disclosure:WEST-SRP-20250925-LBC-REQUESTS",
      "region": "West",
      "name": "Salt River Project (SRP) · 10 MW 초과 대규모 고객 80개 프로젝트 송전용량 요청 합계",
      "capacityMw": 15308.0,
      "projectCount": 80,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "SRP January 13, 2026 Work Study Session packet — PDF page 22 / slide 20",
      "sourceUrl": "https://www.srpnet.com/assets/srpnet/pdf/about/governance-leadership/district-meetings/20260113_WSS_packet.pdf",
      "sourceAsOf": "2025-09-25",
      "checkedAt": "2026-10-03",
      "scope": "SRP 대규모 고객의 용량 요청. 피닉스 전체·APS 구역·계약 확정 수요 아님. 현재 운영 고객 부하와 별도 집계. 10 MW 초과 80개 프로젝트의 송전용량 요청 15,308 MW. 데이터센터 14,140, 첨단제조 841, 경공업 231, 중공업 30, 기타 65 MW. 부문 합계 15,307 MW와 공시 총계 간 1 MW 차이는 반올림 범위. 기준일 2025-09-25.",
      "caveats": [
        "80개 프로젝트의 이름·개별 용량·현재 상태 미공개. 후속 6,000 MW 사례는 설명용 가정이므로 집계 금지. 2026-10-03까지의 제한 검색에서 더 최신인 동등 집계 미확인.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-01-13; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:WEST-SRP-20250925-DC-REQUESTS",
      "region": "West",
      "name": "Salt River Project (SRP) · SRP 송전용량 요청 중 데이터센터 부분집합",
      "capacityMw": 14140.0,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "SRP January 13, 2026 Work Study Session packet — PDF page 22 / slide 20",
      "sourceUrl": "https://www.srpnet.com/assets/srpnet/pdf/about/governance-leadership/district-meetings/20260113_WSS_packet.pdf",
      "sourceAsOf": "2025-09-25",
      "checkedAt": "2026-10-03",
      "scope": "WEST-SRP-20250925-LBC-REQUESTS의 부분집합. 데이터센터만의 프로젝트 수 미공개. 총 요청 15,308 MW 중 데이터센터는 14,140 MW. 별도 추가 용량이 아닌 부분집합.",
      "caveats": [
        "공개 도표에 프로젝트별 목록·절차 단계별 용량 없음.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-01-13; 원자료 기준일과 구별합니다."
      ]
    },
    {
      "id": "disclosure:ERCOT_ONCOR_OTHER_INDUSTRIAL_2026Q2",
      "region": "ERCOT",
      "name": "Oncor · 데이터센터 외 산업 송전 접속 요청",
      "capacityMw": 16000,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "greater_than",
      "sourceName": "Oncor Reports Second Quarter 2026 Results",
      "sourceUrl": "https://www.oncor.com/content/oncorwww/wire/en/home/newsroom/oncor-reports-second-quarter-2026-results.html",
      "sourceAsOf": "2026-06-30",
      "checkedAt": "2026-10-08T08:43:31.388093+00:00",
      "scope": "2026년 6월 말 Oncor 활성 대규모 상업·산업 송전 요청 737건 중 데이터센터 외 산업 용량 >16 GW. 데이터센터 약282 GW와 구분한 공시. ERCOT 전체 요청과 겹치므로 전국 합산 제외.",
      "caveats": [
        "고객별 익명 ID·단계·요청 MW 명부 없음. ERCOT 전체 요청 또는 신규 대기량으로 대체 금지.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-06; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:ERCOT_ONCOR_REQUEST_COUNT_2026Q2",
      "region": "ERCOT",
      "name": "Oncor · 전체 대규모 상업·산업 송전 요청 건수",
      "capacityMw": null,
      "projectCount": 737,
      "capacityBasis": "unknown",
      "capacityQualifier": "approximate",
      "sourceName": "Oncor Reports Second Quarter 2026 Results",
      "sourceUrl": "https://www.oncor.com/content/oncorwww/wire/en/home/newsroom/oncor-reports-second-quarter-2026-results.html",
      "sourceAsOf": "2026-06-30",
      "checkedAt": "2026-10-08T08:43:31.388093+00:00",
      "scope": "2026년 6월 말 전체 LC&I 송전 요청 건수 737. 데이터센터 737개라는 뜻이 아니며 같은 물리 사업의 복수 요청 가능성도 미확인. 고객별 명부는 확보되지 않았으므로 익명 737행을 생성하지 않습니다.",
      "caveats": [
        "고객별 익명 ID·단계·요청 MW 명부 없음. ERCOT 전체 요청 또는 신규 대기량으로 대체 금지.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-08-06; 원자료 기준일과 구별합니다.",
        "2026-10-08 원문 재확인; 원자료 기준일을 현재 날짜로 변경하지 않았습니다."
      ]
    },
    {
      "id": "disclosure:WEST_SRP_ADVANCED_MANUFACTURING_20250925",
      "region": "West",
      "name": "SRP · 첨단제조 송전용량 요청 부분집합",
      "capacityMw": 841,
      "projectCount": null,
      "capacityBasis": "requested_grid_mw",
      "capacityQualifier": "exact",
      "sourceName": "SRP January 13, 2026 Work Study Session packet — PDF page 22 / slide 20",
      "sourceUrl": "https://www.srpnet.com/assets/srpnet/pdf/about/governance-leadership/district-meetings/20260113_WSS_packet.pdf",
      "sourceAsOf": "2025-09-25",
      "checkedAt": "2026-10-03",
      "scope": "2025-09-25 기준 SRP 10 MW 초과 고객 요청 15,308 MW의 첨단제조 부분집합 841 MW. 공개 이사회 자료가 제시한 산업 분류이며 전체 요청·데이터센터 부분집합과 중복 합산하지 않습니다.",
      "caveats": [
        "80개 프로젝트의 이름·개별 용량·현재 상태 미공개. 후속 6,000 MW 사례는 설명용 가정이므로 집계 금지. 2026-10-03까지의 제한 검색에서 더 최신인 동등 집계 미확인.",
        "원장·계약·공시·유틸리티 집계 간 동일 사업 연결이 미완료이므로 다른 행·집계와 용량을 합산하지 않습니다.",
        "발표일: 2026-01-13; 원자료 기준일과 구별합니다."
      ]
    }
  ]
}''')

if __name__ == '__main__':
    main()
