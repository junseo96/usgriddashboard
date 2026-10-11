#!/usr/bin/env python3
"""Assemble reviewed source coverage; no network, DB writes or fuzzy entity matches.

python3 scripts/build-load-coverage.py --universe /path/utility-universe.json \
  --fragment /path/pjm-coverage-fragment.json --fragment /path/other-fragment.json
Raw research inputs stay outside Git. Published normalized data and reviewed links
are versioned. Source paths are provided by the caller; none are machine-specific.
Use --check with the same inputs to verify deterministic reproduction.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import subprocess
from pathlib import Path
from collections import defaultdict

APP = Path(__file__).resolve().parents[1]
REGIONS = ['CAISO', 'ERCOT', 'ISO-NE', 'MISO', 'NYISO', 'PJM', 'SPP', 'Non-ISO', 'Unassigned']
UNKNOWN_BA = {'NA', 'N/A', 'UNKNOWN', 'UNASSIGNED', 'NONE', ''}

def utc(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def unique(items):
    return list(dict.fromkeys(items))

def compact_proofs(proofs, source_map):
    groups = defaultdict(set)
    for p in proofs:
        if 'row' in p:
            groups[(source_map[p['sourceId']], p['sheet'])].add(p['row'])
        else:
            groups[(source_map[p['sourceId']], p['sheet'])].update(range(p['firstRow'], p['lastRow'] + 1))
    result = []
    for (source_id, sheet), rows in sorted(groups.items()):
        blocks = []
        start = end = None
        for row in sorted(rows):
            if end is not None and row == end + 1:
                end = row
            else:
                if start is not None:
                    blocks.append(str(start) if start == end else f'{start}-{end}')
                start = end = row
        if start is not None:
            blocks.append(str(start) if start == end else f'{start}-{end}')
        result.append({'sourceId': source_id, 'locator': f'{sheet}; Excel rows {",".join(blocks)}'})
    return result

def normalize_universe(raw):
    year = raw['dataYear']
    archive = next(s for s in raw['sources'] if s['id'] == 'eia861-archive')
    source_map = {s['id']: (f'eia861-{year}-' + s['id'] if not s['id'].startswith('eia861-') else s['id']) for s in raw['sources']}
    sources = []
    for s in raw['sources']:
        is_member = 'archiveMember' in s
        sources.append({
            'id': source_map[s['id']],
            'name': (f'EIA-861 {year} ZIP / ' + s['archiveMember']) if is_member else s.get('name', 'EIA-861 공식 연간 자료 색인'),
            'url': (archive['url'] + '#' + s['archiveMember']) if is_member else s['url'],
            'retrievedAt': utc(archive['retrievedAt'] if is_member else s['retrievedAt']),
            'sha256': s['sha256'],
            'sourceAsOf': str(raw['dataYear']) if s['id'] != 'eia861-index' else None,
            'publishedAt': raw['publishedAt'] if s['id'] != 'eia861-index' else None,
            'notes': ([f"ZIP 내 실제 {s['archiveMember']} 바이트의 SHA-256. 상위 ZIP SHA-256: {archive['sha256']}. URL fragment는 다운로드 원본 ZIP의 해당 멤버를 지정합니다."] if is_member else [])
                + [f'{year}년 연간 보고기간 자료. 현재 고객 접속신청 또는 최신 ISO 회원 전수 원장이 아닙니다.']
        })
    bas = {b['code']: b for b in raw['balancingAuthorities']}
    mapping = raw['baRegionMapping']
    utilities = []
    for u in raw['utilities']:
        associations = []
        for a in u['balancingAuthorityAssociations']:
            code = a['code']
            # Only a real BA present in the authoritative BA sheet can establish Non-ISO.
            ba = bas.get(code)
            region = mapping.get(code) if ba else None
            if ba and code not in mapping and code.upper() not in UNKNOWN_BA:
                region = 'Non-ISO'
            for proof in compact_proofs(a['evidence'], source_map):
                associations.append({'kind': 'balancing_authority', 'code': code,
                    'name': ba['name'] if ba else None, 'region': region,
                    'sourceId': proof['sourceId'], 'locator': proof['locator'] + '; reported states=' + ','.join(a['states'])})
        for a in u['regionAssociations']:
            if 'rto_checkbox' in a['bases']:
                checkbox_proofs = [p for p in a['evidence'] if p['sourceId'] == 'utility_data']
                if not checkbox_proofs:
                    raise ValueError(f"ISO checkbox missing Utility Data proof: {u['id']}")
                for proof in compact_proofs(checkbox_proofs, source_map):
                    associations.append({'kind': 'iso_membership', 'code': a['region'],
                        'name': a['region'] + ' · EIA 보고 ISO/RTO 참여 체크박스', 'region': a['region'],
                        'sourceId': proof['sourceId'], 'locator': proof['locator'] + '; RTO/ISO participation checkbox; not a service-area boundary'})
        proven = {a['region'] for a in associations if a['region'] is not None}
        regions = [r for r in REGIONS if r in proven] or ['Unassigned']
        proofs = u['sourceEvidence'] + u.get('serviceTerritoryEvidence', [])
        all_geo_proofs = [p for a in u['balancingAuthorityAssociations'] for p in a['evidence']]
        proofs += all_geo_proofs
        notes = ['EIA 연간 보고기관 ID이며 접속신청 ID가 아닙니다. 명단 포함·출처 연결은 전체 고객 원장 확보를 뜻하지 않습니다.',
            '소유형태: ' + u['ownership'] + '; 지리 범위 근거: ' + u['mainlandScopeEvidence'] + '.']
        if any(a['kind'] == 'iso_membership' for a in associations):
            notes.append('ISO/RTO 참여 체크박스는 해당 회사의 모든 소매 서비스지역이 그 권역에 있다는 뜻이 아닙니다. BA 보고 근거와 구분합니다.')
        if 'Unassigned' in regions:
            notes.append('유효 BA/ISO 연결 근거가 없어 권역 미확정으로 보존합니다. 소재 주로 권역을 추정하지 않습니다.')
        if u.get('unresolvedBaEvidence'):
            notes.append('BA 미공개/미확인 보고 행 존재: ' + json.dumps(u['unresolvedBaEvidence'], ensure_ascii=False, separators=(',', ':')))
        if u['geographicScope'] in ['nonmainland', 'mixed', 'unresolved']:
            notes.append('본토48주/DC 범위: ' + u['geographicScope'] + '; 비본토와 위치 미확인은 별도로 조회합니다.')
        utilities.append({'id': u['id'], 'name': u['name'], 'states': u['states'], 'forms': [u['form']],
            'roles': u['roles'], 'geographicScope': u['geographicScope'], 'mainlandStates': u['mainlandStates'],
            'serviceTypes': u['serviceTypes'], 'sourceEvidence': compact_proofs(proofs, source_map),
            'regions': regions, 'associations': associations, 'notes': notes})
    assert len(utilities) == raw['summary']['frameRespondents']
    return sources, {'year': raw['dataYear'], 'sourceIds': [s['id'] for s in sources],
        'scope': f'EIA-861/861S {year}년 최종 연간 보고기관 명단 전체. 공식 Frame의 {len(utilities):,}개 기관 ID를 보존하며 본토·비본토·미확정 위치, 실제 BA 보고와 ISO/RTO 참여를 구분합니다.',
        'limitations': raw['limitations'] + ['이 분모는 고객 프로젝트 전수가 아니라 조사 대상 전력회사·보고기관 명단입니다.',
            '연간 EIA 보고 이후 신설·폐업·가입 변경은 현재 명단과 다를 수 있습니다. 모든 신청·계약·프로젝트 진행의 실시간 전수를 뜻하지 않습니다.',
            '회사의 복수 권역 참여·BA 보고는 복수 연결로 보존하며, 각 권역의 업체 수를 더해 전국 고유 기관 수로 사용하지 않습니다.'],
        'utilities': utilities}

def stage_references(dataset):
    sources = {}; evidence = []
    providers = {
        'load-pge-original': 'Pacific Gas & Electric Co.', 'load-pge-paid-study': 'Pacific Gas & Electric Co.',
        'ercot-load-stages': 'ERCOT', 'isone-selected-load-studies': 'ISO New England',
        'miso-dte-selected-load-projects': 'DTE Electric Company', 'nyiso-load-register': 'NYISO',
        'nyiso-load-fixed-cohort': 'NYISO', 'pjm-aes-ohio-selected-loads': 'AES Ohio',
        'spp-evergy-advanced-development-stages': 'Evergy', 'spp-evergy-additional-esa-subset': 'Evergy',
        'miso-ameren-electric-service-contract-subset': 'Ameren Missouri', 'bpa-explicit-mainland-loads': 'Bonneville Power Administration',
        'gpc-large-load-stage-pool': 'Georgia Power Co', 'pjm-duquesne-selected-load-studies': 'Duquesne Light Company',
    }
    for series in dataset['series']:
        if series['id'] not in providers:
            raise ValueError('Unreviewed stage provider mapping: ' + series['id'])
        point = max(series['points'], key=lambda p: p['date'])
        point_sources = [point['source']] + [b['source'] for b in point['bins'] if 'source' in b]
        source_ids = []
        for s in point_sources:
            sid = 'load-stage-source-' + s['sha256'][:20]
            source_ids.append(sid)
            normalized = {'id': sid, 'name': s['name'], 'url': s['url'], 'retrievedAt': utc(s['retrievedAt']), 'sha256': s['sha256'],
                'sourceAsOf': point['sourceAsOf'] if s == point['source'] else None,
                'publishedAt': point['publishedAt'] if s == point['source'] else None,
                'notes': ['검토된 기존 수용가 단계 계열의 실제 원문 출처. 출처별 일부 고객 범위이며 권역 전수로 확대하지 않습니다.']}
            if 'originalUrl' in s:
                normalized['notes'].append('공식 원본 URL: ' + s['originalUrl'])
            # A same-byte source reused by series is one source; dates may differ by point scope.
            if sid not in sources:
                sources[sid] = normalized
        region = 'Non-ISO' if series['region'] in ['West', 'Southeast'] else series['region']
        evidence.append({'id': 'stage-coverage-' + series['id'], 'region': region, 'provider': providers[series['id']],
            'name': series['name'] + ' · 기존 단계 근거', 'sourceIds': unique(source_ids), 'coverageKind': 'stage_distribution',
            'scope': series['scope'] + ' ' + series['comparability'],
            'metrics': [{'label': '해당 공개집단의 최신 분모 (' + point['date'] + '; 전체 권역 분모 아님)', 'value': point['totalWeight'],
                'unit': 'projects' if series['weightBasis'] == 'project_count' else 'MW', 'asOf': point['sourceAsOf'], 'qualifier': 'exact',
                'notes': ['가중 기준: ' + series['weightBasis'] + '; 집단: ' + series['population'] + '; 날짜 근거: ' + point['dateBasis'] + '.']
                    + point['notes']}],
            'utilityIds': [], 'rosterEntryIds': [], 'scoreSeriesIds': [series['id']],
            'gaps': ['원문에 공개된 해당 회사·선별집단의 분모이며 권역 전체 접속신청 점수가 아닙니다.',
                '다른 계약·전망·요청 집계와 합산하지 않으며 공개 원장 밖의 미확인은 별도로 남깁니다.']})
    return list(sources.values()), evidence

def assemble(raw, fragments, stage_data, links, generated_at):
    sources, universe = normalize_universe(raw)
    rosters = []; evidence = []; summaries = {}
    for fragment in fragments:
        sources.extend(fragment['sources']); rosters.extend(fragment['rosters']); evidence.extend(fragment['evidence'])
        rows = fragment.get('regionSummaries', [])
        if 'regionSummary' in fragment:
            row = dict(fragment['regionSummary'])
            if 'region' not in row:
                candidates = unique(e['region'] for e in fragment['evidence'])
                if len(candidates) != 1:
                    raise ValueError('Explicit region required for mixed fragment summary')
                row['region'] = candidates[0]
            rows = rows + [row]
        for row in rows:
            if row['region'] in summaries:
                raise ValueError('Duplicate regional summary: ' + row['region'])
            summaries[row['region']] = row
    stage_sources, stage_evidence = stage_references(stage_data)
    sources.extend(stage_sources); evidence.extend(stage_evidence)
    utilities = {u['id']: u for u in universe['utilities']}
    evidence_by_id = {e['id']: e for e in evidence}
    source_ids = {s['id'] for s in sources}
    for link in links['links']:
        eid = link['evidenceId']
        if eid not in evidence_by_id:
            # Allows one reviewed crosswalk across a smaller explicitly requested research build.
            continue
        e = evidence_by_id[eid]
        if not link['rationale'].strip() or not link['sourceIds'] or any(s not in source_ids for s in link['sourceIds']):
            raise ValueError('Crosswalk has no verified source: ' + eid)
        for target in link['utilities']:
            u = utilities[target['id']]
            if u['name'] != target['expectedName']:
                raise ValueError('EIA entity name changed; reviewed crosswalk needs review: ' + target['id'])
            if e['region'] not in u['regions']:
                raise ValueError('Crosswalk cannot invent utility region: ' + target['id'] + '/' + e['region'])
        e['utilityIds'] = unique(e['utilityIds'] + [u['id'] for u in link['utilities']])
        e['gaps'].append('전력회사 ID 연결 근거: ' + link['rationale'] + ' 출처: ' + ', '.join(link['sourceIds']) + '. 기관 연결은 전체 고객원장 확보율이 아닙니다.')
    for region in REGIONS:
        if region not in summaries:
            summaries[region] = {'region': region, 'sourceIds': [],
                'overview': '공식 EIA 연간 보고기관 모집단과 확인된 BA/ISO 연결을 보존합니다. 해당 범위의 고객 신청 전수 원장은 미확보입니다.',
                'gaps': ['개별 수용가의 전체 신청·진행상태·미통전 잔여용량 공백은 미확인으로 남깁니다.']}
        if region == 'Non-ISO':
            summaries[region] = {'region': region, 'sourceIds': unique(e['sourceIds'][0] for e in evidence if e['region'] == region),
                'overview': '7개 ISO/RTO 밖의 실제 BA에 연결된 EIA 기관을 별도 조사 대상에 포함합니다. BPA·Georgia Power의 검토된 일부 단계 근거를 연결하며 다른 비ISO 사업자를 누락으로 숨기지 않습니다.',
                'gaps': ['비ISO는 단일 시장·공통 접속대기열이 아닙니다. 회사별·BA별 범위와 중복을 해소하지 않고 합산하지 않습니다.',
                    '캘리포니아 주 전체를 CAISO로 분류하지 않으며 본토와 비본토는 별도 지리 필터로 구분합니다.']}
        elif region == 'Unassigned':
            summaries[region] = {'region': region, 'sourceIds': universe['sourceIds'],
                'overview': '실제 BA 보고나 ISO/RTO 연결이 없는 EIA 보고기관을 권역 미확정으로 보존합니다. 회사 소재 주만으로 권역을 배정하지 않습니다.',
                'gaps': ['권역 미확정은 비ISO와 다릅니다. 원자료의 추가 연결 근거가 확인될 때 갱신합니다.']}
    # Duplicate IDs are errors; only identical stage documents were collapsed earlier.
    for key, rows in [('sources', sources), ('rosters', rosters), ('evidence', evidence)]:
        ids = [x['id'] for x in rows]
        if len(ids) != len(set(ids)):
            raise ValueError('Duplicate ' + key + ' ID')
    return {'schemaVersion': 1, 'generatedAt': utc(generated_at), 'sources': sources, 'universe': universe,
        'rosters': rosters, 'evidence': evidence, 'regions': [summaries[r] for r in REGIONS],
        'limitations': ['공식 사업자 명단과 자료 조사 범위를 보여주는 목록이며 미국 전체 고객 프로젝트 전수 확보율이 아닙니다.',
            '기관별 자료 연결, 원장 수집, 개별 프로젝트 식별, 단계 평가 완료를 서로 구분합니다. 미공개·미확인은0 또는100점으로 채우지 않습니다.',
            '공식 명단의 complete는 해당 출처에 정의된 역할·구역 모집단의 전수입니다. 소매전력회사·고객 신청 전수와는 다릅니다.',
            '신청, 누적문의, 계약, 가동 포함 집단, 송전 지원, 미래 전망은 서로 다른 분모이므로 합산하지 않습니다.',
            '전망표의 대상연도는 과거 관측일이 아닙니다. 공식0 및 피크저감의 음수를 원문대로 보존합니다.',
            'EIA 기관 ID와 출처 회사의 연결은 검토한 명시적 교차표만 사용합니다. 송전회사와 그 지역 소매전력회사를 동일기관으로 자동 매핑하지 않습니다.',
            'EIA는 연간 발행이므로 주간 또는 월간 프로젝트 상태를 제공하지 않습니다. 원문 갱신 빈도와 앱 자료 확인 시각을 구분합니다.']}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--universe', type=Path, required=True)
    parser.add_argument('--fragment', action='append', type=Path, default=[])
    parser.add_argument('--stage-data', type=Path, default=APP / 'data/load-bottleneck.json')
    parser.add_argument('--links', type=Path, default=APP / 'data/load-coverage-links.json')
    parser.add_argument('--output', type=Path, default=APP / 'data/load-coverage.json')
    parser.add_argument('--generated-at')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    read = lambda p: json.loads(p.read_text())
    generated_at = args.generated_at or (read(args.output)['generatedAt'] if args.check else dt.datetime.now(dt.timezone.utc).isoformat())
    result = assemble(read(args.universe), [read(f) for f in args.fragment], read(args.stage_data), read(args.links), generated_at)
    rendered = json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n'
    # Validate the real shared contract before either publishing or accepting a check.
    validator = "import fs from 'node:fs'; import { validateLoadCoverageDataset } from './shared/load-coverage.ts'; const data=JSON.parse(fs.readFileSync(0, 'utf8')); const stages=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); validateLoadCoverageDataset(data, new Date(), new Set(stages.series.map(s=>s.id)));"
    subprocess.run(['node', '--input-type=module', '-e', validator, str(args.stage_data.resolve())], input=rendered, text=True, cwd=APP, check=True)
    if args.check:
        if read(args.output) != result:
            raise SystemExit('Published coverage differs from reviewed inputs')
    else:
        args.output.write_text(rendered)
    print(json.dumps({'utilities':len(result['universe']['utilities']),'sources':len(result['sources']),'rosters':len(result['rosters']),
        'evidence':len(result['evidence']),'linkedUtilities':len({u for e in result['evidence'] for u in e['utilityIds']})}))

if __name__ == '__main__':
    main()
