#!/usr/bin/env python3
"""Reproduce six annual LBNL snapshots, never backdate the current queue.

No network is used: put each official workbook at RAW_DIR/YYYY.xlsx and its
acquisition receipt (url, sha256, retrievedAt) at RAW_DIR/YYYY.json. The pinned
official releases below were discovered on the publisher's publication pages.
The pre-2025 aliases are reviewed labels, not fuzzy status matching. Raw files
remain local; only bounded summaries and provenance are published.
"""
import argparse
from collections import Counter, defaultdict
import datetime as dt
import hashlib
import json
import math
from pathlib import Path

from lbnl import _Workbook, _capacity, parse_lbnl, STATES, REGIONS, RESOURCE_TYPES

APP = Path(__file__).resolve().parents[1]
MODEL = 'stage-proxy-v1'
RELEASES = {
    2020: ('https://eta-publications.lbl.gov/sites/default/files/queues_2020_clean_data.xlsx', '986afec8e0a78ac82706cb9edb1578dc747682e8450ed3c9deb706d4a267129b', '2021-05', 'May 2021', 'queued-characteristics-power-plants'),
    2021: ('https://eta-publications.lbl.gov/sites/default/files/queues_2021_clean_data.xlsx', '6096f046b97c0e2a112fcd60fbe0f5fb76c63af45ab8bd5300116c344a2580e5', '2022-04', 'April 2022', 'queued-characteristics-power-plants-0'),
    2022: ('https://eta-publications.lbl.gov/sites/default/files/queues_2022_clean_data_0.xlsx', '3994d6dc50b37c86594b9a13de81ee60ea4f4d8175341a878ea5ee6bae12d9ed', '2023-04', 'April 2023', 'queued-characteristics-power-plants-1'),
    2023: ('https://eta-publications.lbl.gov/sites/default/files/queues_2023_clean_data_r1.xlsx', '832f21cf62a3c333b1834455deecbcbc99b80cb65e43855b7a48355fec838a39', '2024-04', 'April 2024', 'queued-2024-edition-characteristics'),
    2024: ('https://eta-publications.lbl.gov/sites/default/files/2025-08/lbnl_ix_queue_data_file_thru2024_v2.xlsx', 'd816467f629a13ef4013dee000129d61f8e4d7fcd8ba514c404a4e140dfec991', '2025-08', 'August 2025', 'queued-2025-edition-characteristics'),
    2025: ('https://emp.lbl.gov/sites/default/files/2026-05/LBNL_Ix_Queue_Data_File_thru2025.xlsx', '794582d3281c6a305e9615fcfec3fae9dc85be2165216d33760b677e976a08b6', '2026-05', 'May 2026', 'queued-2026-edition-characteristics'),
}

# Identical point parameters to shared/stage-estimate.ts; a test compares every
# canonical status with the actual TypeScript model. No unspecified status gets
# a maximum (or zero) by default.
POINTS = {'Not Started': 100, 'Feasibility Study': 90, 'Cluster Study': 80,
          'System Impact Study': 80, 'Facility Study': 70, 'IA Pending': 55,
          'IA Executed': 50, 'Construction': 25}
STAGE_ALIASES = {'Facilities Study': 'Facility Study', 'Facility study': 'Facility Study',
                 'Feasability Study': 'Feasibility Study', 'IA Draft': 'IA Pending',
                 'IA in Progress': 'IA Pending'}
TYPE_ALIASES = {'Pumped Storage': 'Other Storage', 'Pump Storage': 'Other Storage',
                'Storage': 'Other Storage', 'CAES': 'Other Storage',
                'Gravity Rail': 'Other Storage', 'Batteries': 'Battery',
                'Natural Gas': 'Gas', 'Methane': 'Gas', 'CSP': 'Solar',
                'Waste Heat': 'Other', 'Biogas': 'Other', 'Biomass': 'Other',
                'Biofuel': 'Other', 'Steam Turbine': 'Other', 'Fuel Cell': 'Other',
                'Waste': 'Other', 'Wave': 'Other'}
UNKNOWN_TYPES = {'Unknown', 'unknown', 'Hybrid', 'HYBRID', 'n/a'}
REGION_ALIASES = {'West (non-ISO)': 'West', 'Southeast (non-ISO)': 'Southeast'}


def stage_point(raw, year):
    return POINTS.get(STAGE_ALIASES.get(raw, raw) if year < 2025 else raw)


def clean(value):
    if isinstance(value, str):
        value = value.strip()
        return None if value in ('', 'NA') else value
    return value


def read_rows(book, year):
    sheet = 'active' if year == 2020 else 'data' if year <= 2023 else '03. Complete Queue Data'
    rows = book.sheet(sheet)
    indices = [i for i, row in enumerate(rows) if row.get('A') == 'q_id']
    if len(indices) != 1:
        raise ValueError('Unique annual data header required')
    start = indices[0]
    columns = rows[start]
    required = {'q_id', 'q_status', 'entity', 'state', 'region', 'type_clean',
                *(['type1', 'type2', 'type3', 'mw1', 'mw2', 'mw3'] if year < 2025 else
                  ['type_1', 'type_2', 'type_3', 'mw_1', 'mw_2', 'mw_3'])}
    if not required <= set(columns.values()):
        raise ValueError('Annual component schema changed')
    return [{field: clean(row.get(column)) for column, field in columns.items()}
            for row in rows[start + 1:]]


def normalize_legacy(rows, year):
    """Exclude ambiguous identifiers or resource class; report every exclusion.

    The older workbooks contain rounded scientific-notation IDs shared by many
    real requests. Neither selecting an arbitrary row nor summing those requests
    would preserve the source-identity denominator. All rows in those groups are
    excluded, including identical repeated rows, and their number is disclosed.
    """
    active = [r for r in rows if r['q_status'] == 'active']
    groups = defaultdict(list)
    for row in active:
        groups[(row['entity'], str(row['q_id']))].append(row)
    stats = Counter()
    projects = []
    for (entity, qid), group in groups.items():
        if len(group) > 1:
            stats['ambiguousIdentityRows'] += len(group)
            stats['ambiguousIdentityGroups'] += 1
            continue
        row = group[0]
        if not entity or row['q_id'] is None:
            stats['missingIdentityRows'] += 1
            continue
        if row['state'] not in STATES:
            stats['outsideOrUnknownMainlandRows'] += 1
            continue
        region = REGION_ALIASES.get(row['region'], row['region'])
        if region not in REGIONS:
            raise ValueError('Unreviewed historical region')
        parts = {'generation': [], 'storage': []}
        ambiguous = False
        for i in (1, 2, 3):
            kind, raw = row[f'type{i}'], row[f'mw{i}']
            if kind is None:
                if raw is not None:
                    # Some early workbooks contain an untyped MW component.
                    # Its allocation cannot be inferred from another component.
                    ambiguous = True
                continue
            if kind in UNKNOWN_TYPES:
                ambiguous = True
                continue
            kind = TYPE_ALIASES.get(kind, kind)
            if kind not in RESOURCE_TYPES:
                raise ValueError('Unreviewed historic resource class: ' + str(kind))
            parts['storage' if kind in ('Battery', 'Other Storage') else 'generation'].append(_capacity(raw))
        if ambiguous or not any(parts.values()):
            stats['unclassifiedResourceRows'] += 1
            continue
        raw_status = row.get('ia_status_clean') or row.get('IA_status_clean') or 'active'
        known_sum = lambda values: sum(v for v in values if v is not None) if any(v is not None for v in values) else None
        projects.append({'id': f'{entity}::{qid}', 'region': region, 'types': [k for k, v in parts.items() if v],
                         'generationMw': known_sum(parts['generation']), 'storageMw': known_sum(parts['storage']),
                         'capacityStatus': 'partial' if any(v is None for values in parts.values() for v in values) else 'known',
                         'rawStatus': raw_status})
    return projects, dict(stats), len(active)


def summaries(projects, year):
    result = []
    for region in ['all', *sorted(REGIONS)]:
        for kind in ('all', 'generation', 'storage'):
            selected = [p for p in projects if (region == 'all' or p['region'] == region)
                        and (kind == 'all' or kind in p['types'])]
            scores = [v for p in selected if (v := stage_point(p['rawStatus'], year)) is not None]
            capacities = {key: [p[key] for p in selected if p[key] is not None]
                          for key in ('generationMw', 'storageMw')}
            result.append({'region': region, 'type': kind, 'eligibleCount': len(selected),
                           'ratedCount': len(scores), 'unknownCount': len(selected) - len(scores),
                           'ratingMean': sum(scores) / len(scores) if scores else None,
                           'generationMw': round(sum(capacities['generationMw']), 6) if capacities['generationMw'] else None,
                           'storageMw': round(sum(capacities['storageMw']), 6) if capacities['storageMw'] else None,
                           'knownGenerationCapacityCount': len(capacities['generationMw']),
                           'knownStorageCapacityCount': len(capacities['storageMw']),
                           'capacityUnknownCount': sum(p['capacityStatus'] != 'known' for p in selected)})
    return result


def build_vintage(raw_dir, year):
    url, expected_sha, publication_month, publication_text, publication_page = RELEASES[year]
    raw = (raw_dir / f'{year}.xlsx').read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    receipt = json.loads((raw_dir / f'{year}.json').read_text())
    if sha != expected_sha or receipt.get('sha256') != sha or receipt.get('url') != url:
        raise ValueError('Reviewed official release and receipt must match actual bytes')
    retrieved = dt.datetime.fromisoformat(receipt['retrievedAt'].replace('Z', '+00:00'))
    if retrieved.tzinfo is None or retrieved > dt.datetime.now(dt.timezone.utc):
        raise ValueError('Actual acquisition timestamp required')
    book = _Workbook(raw)
    try:
        intro = [v for row in book.sheet('introduction' if year <= 2023 else 'Introduction') for v in row.values()]
        if publication_text not in intro:
            raise ValueError('Workbook publication month changed')
        if year > 2020 and not any(str(v).endswith(f'through {year}') for v in intro):
            raise ValueError('Workbook annual cutoff mismatch')
        rows = read_rows(book, year)
    finally:
        book.close()
    if year == 2025:
        parsed, _ = parse_lbnl(raw, {'id': 'lbnl-generation-storage-queues', 'url': url})
        projects = [p for p in parsed if p['eligible']]
        exclusions = {'outsideOrUnknownMainlandRows': len(parsed) - len(projects)}
        raw_count = len(parsed)
    else:
        projects, exclusions, raw_count = normalize_legacy(rows, year)
    summary = summaries(projects, year)
    return {'year': year, 'sourceAsOf': f'{year}-12-31', 'publishedAt': publication_month,
            'source': {'name': f'LBNL Queued Up — {year}년 말 원장', 'url': url,
                       'retrievedAt': receipt['retrievedAt'], 'sha256': sha},
            'notes': [
                '각 연도 공식 배포본의 당시 활성 원장 상태를 현재 stage-proxy-v1로 재평가한 연말 값입니다. 당시 게시된 공식 점수가 아닙니다.',
                '본토 48주/DC의 활성 송전 접속 신청 기준이며 완료·철회 사업을 포함하는 생애주기 평균이나 전국 물리 사업 전수가 아닙니다.',
                '연도별 조사 범위·진행단계 공개율·식별자 품질이 달라집니다. 특히 2020–2021 In Progress는 단계 불명으로 미산출이며 직접적인 점수 추세 비교에 주의해야 합니다.',
                '월간·주간 중간 값은 보간하지 않습니다. 발전·저장 복합 신청은 전체 한 번, 유형별 보기에는 겹쳐 집계합니다.',
                '미공개·음수 MW는 용량 합계에 넣지 않습니다. 모호한 중복 ID 그룹과 발전/저장 유형을 구별할 수 없는 행은 별도 제외합니다.',
            ], 'summaries': summary,
            'rawStatusCounts': dict(sorted(Counter(p['rawStatus'] for p in projects).items())),
            'provenance': {'publicationUrl': 'https://emp.lbl.gov/publications/' + publication_page,
                           'cutoffBasis': 'official annual publication and workbook scope, through year-end',
                           'rawBytes': len(raw), 'rawActiveRowCount': raw_count,
                           'excludedRowCount': raw_count - len(projects), 'exclusionsStats': exclusions,
                           'identityScope': 'source_record', 'nationalComplete': False,
                           'assessmentBasis': 'contemporary_annual_register_reassessed_with_current_model',
                           'stageAliases': STAGE_ALIASES if year < 2025 else {},
                           'resourceAliases': TYPE_ALIASES if year < 2025 else {},
                           'ratingCoverage': summary[0]['ratedCount'] / summary[0]['eligibleCount']}}


def validate_artifact(value):
    if value.get('schemaVersion') != 1 or value.get('modelVersion') != MODEL:
        raise ValueError('Historical artifact model/schema mismatch')
    vintages = value['vintages']
    if [v['year'] for v in vintages] != list(RELEASES):
        raise ValueError('Annual vintage set mismatch')
    for vintage in vintages:
        year = vintage['year']
        if vintage['source']['url'] != RELEASES[year][0] or vintage['source']['sha256'] != RELEASES[year][1]:
            raise ValueError('Unreviewed historical source')
        if vintage['sourceAsOf'] != f'{year}-12-31' or vintage['publishedAt'] != RELEASES[year][2]:
            raise ValueError('Historical dates changed')
        for row in vintage['summaries']:
            if row['ratedCount'] + row['unknownCount'] != row['eligibleCount']:
                raise ValueError('Historical denominator mismatch')
            if (row['ratingMean'] is None) != (row['ratedCount'] == 0):
                raise ValueError('Historical null score mismatch')
            if row['ratingMean'] is not None and not 0 <= row['ratingMean'] <= 100:
                raise ValueError('Historical score outside range')
            for key in ('generationMw', 'storageMw'):
                if row[key] is not None and (not math.isfinite(row[key]) or row[key] < 0):
                    raise ValueError('Invalid historical capacity')
        if len(vintage['summaries']) != 30:
            raise ValueError('Incomplete region/type summary set')
        overall = vintage['summaries'][0]
        if sum(vintage['rawStatusCounts'].values()) != overall['eligibleCount']:
            raise ValueError('Raw status coverage mismatch')
        if vintage['provenance']['rawActiveRowCount'] != overall['eligibleCount'] + vintage['provenance']['excludedRowCount']:
            raise ValueError('Source row reconciliation mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--raw-dir', type=Path)
    parser.add_argument('--output', type=Path, default=APP / 'data/history-generation.json')
    parser.add_argument('--check', action='store_true', help='Validate the checked-in artifact without fetching raw data')
    args = parser.parse_args()
    if args.check:
        validate_artifact(json.loads(args.output.read_text()))
        print('Six annual generation/storage vintages validated')
        return
    if args.raw_dir is None:
        parser.error('--raw-dir is required to build from official XLSX releases and acquisition receipts')
    value = {'schemaVersion': 1, 'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
             'modelVersion': MODEL, 'vintages': [build_vintage(args.raw_dir, year) for year in RELEASES]}
    validate_artifact(value)
    args.output.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print('Wrote six annual generation/storage vintages: ' + str(args.output))


if __name__ == '__main__':
    main()
