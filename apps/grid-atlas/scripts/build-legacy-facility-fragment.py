#!/usr/bin/env python3
"""Preserve reviewed, named census facilities; never import anonymous or grouped requests.

Only explicit site/code crosswalks and exact linked core IDs are identity matches.
The original artifact hash, retrieval timestamp and capacity measure remain intact.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIRECT = {
    'site:google-van-buren': 'LLF-HS-google-van-buren-township-michigan',
    'site:xcel-google-pine-island': 'LLF-HS-google-pine-island-minnesota',
    'site:google-stillwater': 'LLF-HS-google-stillwater-oklahoma',
    'site:google-west-memphis': 'LLF-HS-google-west-memphis-arkansas',
    'site:meta-beaver-dam': 'LLF-HS-meta-beaver-dam-wi',
    'site:meta-hyperion-richland': 'LLF-HS-meta-richland-parish-la',
    'site:xcel-meta-rosemount': 'LLF-HS-meta-rosemount-mn',
    'site:oracle-port-washington': 'LLF-HS-oracle-port-washington',
    'site:oracle-saline': 'LLF-HS-oracle-saline-township',
    'site:pjm-cipher-ulysses': 'LLF-HS-cipher-ulysses',
    'site:pjm-coreweave-lancaster': 'LLF-HS-coreweave-lancaster',
    'site:alliant-google-cedar-rapids': 'LLF-HS-google-cedar-rapids-iowa',
    'site:google-midlothian': 'LLF-HS-google-midlothian-texas',
    'site:google-red-oak': 'LLF-HS-google-red-oak-texas',
    'site:pjm-google-columbus-oh': 'LLF-HS-google-columbus-ohio',
    'site:pjm-google-lancaster-oh': 'LLF-HS-google-lancaster-ohio',
    'site:pjm-google-new-albany-oh': 'LLF-HS-google-new-albany-ohio',
    'site:meta-stanton-springs': 'LLF-HS-meta-stanton-springs-ga',
    'site:microsoft-mount-pleasant-campus': 'LLF-HS-microsoft-mount-pleasant',
    'site:samsung-taylor': 'LLF-ind-sia-samsung-taylor-tx-new-facility',
    'site:ti-sherman': 'LLF-ind-sia-texas-instruments-sherman-tx-new-facility',
    'site:electric-hydrogen-devens': 'LLF-ind-doe-electric-hydrogen-devens-ma-94ba2d53',
}
for name in ('apollo', 'barber-lake', 'barber-lake-expansion', 'black-pearl', 'colchis', 'mclennan', 'mikeska', 'odessa', 'reveille', 'stingray', 'stingray-expansion'):
    DIRECT['site:cipher-' + name] = 'LLF-HS-cipher-' + name
for code in ('dfw1', 'dfw2', 'dfw4', 'dfw5', 'dfw6', 'dfw7'):
    DIRECT['site:databank-' + code] = 'LLF-databank-' + code
for code, remote_id in {'dfw10': '2297', 'dfw11': '2298', 'dfw12': '2299', 'dfw26': '2305', 'dfw36': '2309'}.items():
    DIRECT['site:digital-realty-' + code] = 'LLF-digitalrealty-' + remote_id

EXCLUDE = {
    'request:amazon-madison-two-complexes': '두 독립 complex의 묶음; 단일 시설로 만들지 않음',
    'request:amazon-nipsco-multiple-sites': '공식 복수 위치 계약이며 개별 부지 미식별',
    'request:miso-blue-earth': '데이터센터·암모니아 공장 복수 개발 묶음',
    'request:miso-cedar-crossing': '카지노로 이번 데이터센터·대형 산업시설 범위 밖',
    'request:PUCN::26-05026': '회사 계약 사건만 확인; 물리 부지와 시설 수 미공개',
    'request:PUCN::26-05028': '회사 계약 사건만 확인; NV11의 물리 부지 미확인',
    'request:UTAHPSC::26-035-05': '고객 실명·물리 부지 비공개',
    'site:pjm-ferc-er25-3492-peco-amazon': '회사 송전 담보계약이며 개별 부지 미확인',
    'request:pjm-m3-aep-2018-ap009-r35': '회사 설비보강 요청이며 부지·주 미확인',
}
SECTORS = {
    'site:cmc-seguin': 'steel', 'site:freeport-lng': 'other_industrial',
    'site:samsung-austin': 'semiconductor', 'site:samsung-taylor': 'semiconductor', 'site:ti-sherman': 'semiconductor',
    'site:gf-burlington-sige': 'semiconductor', 'site:electric-hydrogen-devens': 'hydrogen',
    'site:cfs-sparc-devens': 'other_industrial', 'site:sublime-holyoke': 'manufacturing',
    'request:miso-lilly-lebanon': 'manufacturing', 'request:miso-enbridge-cambridge': 'other_industrial',
    'request:miso-wieland-metals': 'manufacturing', 'request:pjm-m3-aep-2019-ap041-r152': 'manufacturing',
    'request:pjm-m3-atsi-2019-082-r1195': 'steel', 'request:pjm-m3-dom-2025-0080-r2150': 'manufacturing',
    'site:pjm-wvpsc-23-0865-e-pc-nucor-apple-grove': 'steel', 'site:pjm-wvpsc-24-0552-e-pc-timet-millwood': 'manufacturing',
}
# Source explicitly names these building codes as constituents, not merely the same city/operator.
CAMPUS_CHILDREN = {
    'site:databank-plano': ['LLF-databank-dfw3', 'LLF-databank-dfw8'],
    'site:databank-red-oak': ['LLF-databank-dfw9', 'LLF-databank-dfw10', 'LLF-databank-dfw11', 'LLF-databank-dfw12'],
    'site:digital-realty-digital-dallas': ['LLF-digitalrealty-' + i for i in ('2301', '2302', '2303', '2304', '2306', '2307', '2308')],
}
LIFECYCLE = {'announced': 'planned', 'application': 'planned', 'study': 'planned', 'contracted': 'planned', 'construction': 'construction', 'operating': 'operating', 'withdrawn': 'cancelled', 'unknown': 'unknown'}
MEASURES = {'requested_grid': 'requested_grid', 'contracted_grid': 'contracted_grid', 'site_power': 'facility_power', 'it_power': 'it_power', 'generation': 'onsite_generation', 'unknown': 'unknown'}

def unique(items):
    return list(dict.fromkeys(items))

def valid_day(value):
    return value if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value) else None

def build(root=ROOT):
    data = root / 'data'
    census = json.loads((data / 'load-project-census.json').read_text())
    evidence = {e['id']: e for e in census['evidence']}
    existing, original_sources, generated = {}, {}, [census['generatedAt']]
    for path in sorted((data / 'large-load-facility-fragments').glob('*.json')):
        if path.name == 'legacy-sites.json':
            continue
        fragment = json.loads(path.read_text())
        generated.append(fragment['generatedAt'])
        original_sources.update({s['id']: s for s in fragment['sources']})
        for f in fragment['facilities']:
            if f['id'] in existing:
                old = existing[f['id']]
                for field in ('sourceIds', 'aliases', 'legacyProjectIds', 'notes'):
                    f[field] = unique(old[field] + f[field])
                for field in ('capacityFacts', 'events', 'gridEvidence'):
                    f[field] = list({v['id']: v for v in old[field] + f[field]}.values())
            existing[f['id']] = f
    core_links = {}
    for f in existing.values():
        for pid in f['legacyProjectIds']:
            core_links.setdefault(pid, []).append(f['id'])
    sources, records, skipped, identity = {}, {}, {}, {}

    def add_evidence(eid):
        e = evidence.get(eid)
        if not e or not e.get('retrievedAt') or not re.fullmatch('[a-f0-9]{64}', e.get('sha256') or ''):
            return None
        sid = 'legacy-facility:' + hashlib.sha256(eid.encode()).hexdigest()[:20]
        sources[sid] = {key: e[key] for key in ('name', 'url', 'retrievedAt', 'sha256', 'publishedAt', 'sourceAsOf', 'excerpt')}
        sources[sid]['id'] = sid
        return sid

    def retain_sources(f):
        ids = f['sourceIds'] + [sid for field in ('capacityFacts', 'events', 'gridEvidence') for v in f[field] for sid in v['sourceIds']]
        for sid in ids:
            if sid not in sources:
                if sid not in original_sources:
                    raise ValueError('Missing existing source ' + sid)
                sources[sid] = copy.deepcopy(original_sources[sid])

    candidates = [e for e in census['entities'] if e['kind'] in ('site', 'campus', 'unresolved_named_development')]
    for e in candidates:
        cid = e['id']
        if cid in EXCLUDE:
            skipped[cid] = EXCLUDE[cid]
            continue
        refs = unique([sid for eid in e['evidenceIds'] if (sid := add_evidence(eid))])
        if not refs:
            skipped[cid] = '원문 SHA 또는 실제 취득시각 미확보'
            continue
        fid = DIRECT.get(cid)
        if fid and fid not in existing:
            raise ValueError('Stale reviewed identity crosswalk ' + cid + ' -> ' + fid)
        exact_core = core_links.get(e.get('scoreProjectId'), [])
        if not fid and len(exact_core) == 1:
            fid = exact_core[0]
        if not fid:
            fid = 'LLF-legacy-' + re.sub(r'[^a-z0-9]+', '-', cid.lower()).strip('-')
        identity[cid] = fid
        if fid in existing:
            f = copy.deepcopy(existing[fid])
            retain_sources(f)
            # Existing fresh facility observation wins; older census facts supplement, not overwrite it.
            f['notes'].append('정확한 사업자·부지/사이트 코드 또는 동일 개별 원장 ID로 기존 조사 ' + cid + ' 연결. 주·회사명만으로 합치지 않았습니다.')
        else:
            f = {'id': fid, 'name': e['name'], 'operator': e['customer'], 'sector': SECTORS.get(cid, 'data_center'),
                 'region': e['region'], 'regionBasis': 'reported', 'state': e['state'], 'county': None, 'city': None, 'lat': None, 'lon': None,
                 'identityKind': 'campus' if e['kind'] == 'campus' else 'facility', 'parentId': None,
                 'lifecycle': LIFECYCLE[e['status']], 'asOf': valid_day(e['asOf']), 'sourceIds': [], 'capacityFacts': [], 'events': [], 'gridEvidence': [],
                 'aliases': [], 'legacyProjectIds': [], 'notes': []}
        f['sourceIds'] = unique(f['sourceIds'] + refs)
        f['aliases'] = unique(f['aliases'] + e['aliases'] + [cid, e['name']])
        f['legacyProjectIds'] = unique(f['legacyProjectIds'] + ([e['scoreProjectId']] if e['scoreProjectId'] else []))
        f['notes'] = unique(f['notes'] + e['limitations'] + [
            '기존 조사 관측: ' + e['status'] + '; 기준일 ' + str(e['asOf'] or '미공개') + '. 이번 정규화는 새로운 원문 취득이 아닙니다.',
            '기존 권역·주 표기를 보존했습니다. 지리 또는 전력회사 관련 한계는 원문 주석을 따릅니다.',
            '부분 운영과 향후 증설이 함께 있으면 현재 운영부문이 전체 캠퍼스·모든 단계의 완공을 뜻하지 않습니다.',
        ] + (['원문 위치: ' + e['location']] if e['location'] else []))
        if cid == 'site:iren-childress':
            f['lifecycle'] = 'construction'
            f['notes'].append('Horizon 1 운영·2 시운전·3–4 공사가 공존하므로 전체 캠퍼스 0점 완료로 표시하지 않습니다. 개발 단계 모형은 남은 공사 범위의 보수적 표현입니다.')
        if cid == 'site:ti-sherman':
            f['lifecycle'] = 'unknown'
            f['notes'].append('SM1 운영만 확인되며 SM1–SM4 전체 캠퍼스의 동일 진행단계는 미확인입니다. 부분 운영을 전체 완료로 바꾸지 않습니다.')
        for cf in e['capacityFacts']:
            cr = unique([sid for eid in cf['evidenceIds'] if (sid := add_evidence(eid))])
            if not cr or cf['scope'] in ('company', 'multi_site'):
                continue
            f['capacityFacts'].append({'id': fid + ':legacy-capacity:' + hashlib.sha256(cf['id'].encode()).hexdigest()[:12],
                'value': cf['value'], 'unit': cf['unit'], 'measure': MEASURES[cf['basis']],
                'scope': ('campus' if f['identityKind'] == 'campus' else 'facility') if cf['scope'] == 'entity' else cf['scope'],
                'asOf': valid_day(cf['asOf']), 'sourceIds': cr, 'note': cf['note'] + ' 원 조사 수치와 측정 의미를 그대로 보존; 계통 MW로 전환하지 않음.'})
        kind = 'contract' if e['connectionBasis'] == 'confirmed_contract' else 'study' if e['status'] == 'study' and e['connectionBasis'] == 'confirmed_request' else 'application' if e['connectionBasis'] == 'confirmed_request' else None
        if kind:
            f['gridEvidence'].append({'id': fid + ':legacy-grid:' + hashlib.sha256(cid.encode()).hexdigest()[:12], 'kind': kind, 'date': valid_day(e['asOf']), 'sourceIds': refs,
                'note': '기존 개별 조사 ' + cid + '의 ' + e['connectionBasis'] + ' 근거. 신규 ISO 큐 확인·전량 통전 완료를 뜻하지 않습니다.'})
        for field in ('capacityFacts', 'gridEvidence', 'events'):
            f[field] = list({v['id']: v for v in f[field]}.values())
        records[fid] = f

    def patch(fid):
        if fid not in records:
            records[fid] = copy.deepcopy(existing[fid])
            retain_sources(records[fid])
        return records[fid]

    for cid, children in CAMPUS_CHILDREN.items():
        if cid not in identity:
            continue
        parent = identity[cid]
        for fid in children:
            if fid in existing:
                f = patch(fid)
                f['parentId'] = parent
                f['sourceIds'] = unique(f['sourceIds'] + records[parent]['sourceIds'])
                f['notes'] = unique(f['notes'] + ['공식 캠퍼스 자료가 이 건물 코드를 포함합니다. 상위 ' + parent + '와 용량·개발평균을 중복 합산하지 않습니다.'])
    for e in candidates:
        if e['id'] not in identity:
            continue
        f = records[identity[e['id']]]
        parent = identity.get(e.get('parentEntityId'))
        if parent and parent != f['id']:
            f['parentId'] = parent
        for duplicate in e['possibleDuplicateIds']:
            other = identity.get(duplicate)
            if other and other != f['id']:
                f['possibleDuplicateIds'] = unique(f.get('possibleDuplicateIds', []) + [other])
                records[other]['possibleDuplicateIds'] = unique(records[other].get('possibleDuplicateIds', []) + [f['id']])
    # A county-wide Google listing cannot be identified with either of its two named sites.
    broad = 'LLF-HS-google-muskogee-county-oklahoma'
    narrow = [identity.get(cid) for cid in ('site:google-muskogee-council-hill', 'site:google-muskogee-summit')]
    if broad in existing:
        for fid in filter(None, narrow):
            for left, right in ((broad, fid), (fid, broad)):
                f = patch(left)
                f['possibleDuplicateIds'] = unique(f.get('possibleDuplicateIds', []) + [right])
                f['notes'] = unique(f['notes'] + ['Muskogee County 포괄 목록과 Summit·Council Hill의 개별 부지는 범위가 겹칠 수 있습니다. 두 개별 부지를 서로 합치지 않고 포괄 목록과의 중복 가능성을 별도 표시합니다.'])
    # Austin operating campus vs an expansion entry have overlapping scope, not identical completion status.
    austin = identity.get('site:samsung-austin')
    expansion = 'LLF-ind-sia-samsung-austin-tx-expansion'
    if austin and expansion in existing:
        child = patch(expansion)
        child['parentId'] = austin
        child['notes'] = unique(child['notes'] + ['동일 Samsung Austin 부지의 증설 범위. 운영 캠퍼스 전체와 증설 신청을 한 완료 상태로 합치지 않습니다.'])
        child['sourceIds'] = unique(child['sourceIds'] + records[austin]['sourceIds'])
    out = {'schemaVersion': 1, 'id': 'legacy-sites', 'generatedAt': max(generated), 'enrichmentOnlyFacilityIds': sorted(fid for fid in records if fid in existing), 'sources': sorted(sources.values(), key=lambda s: s['id']),
        'facilities': sorted(records.values(), key=lambda f: f['id']), 'limitations': [
            '기존 조사 원장의 실명 site/campus만 정규화한 보존 자료입니다. 익명 요청·송전 지원 그룹·다중 부지 계약을 개별 시설로 늘리지 않습니다.',
            '원문 SHA와 실제 취득시각이 있는 근거만 사용하며, generatedAt은 입력 산출물의 최신 기준 시각입니다. 새로운 원문 취득을 뜻하지 않습니다.',
            '정확한 시설·사이트 코드 및 검토된 개별 원장 연결만 합칩니다. 사업자나 주가 같다는 이유로 합치지 않습니다.',
            '날짜가 있는 실제 사건을 새로 확보한 것이 아니므로 census.asOf를 생애주기 event로 만들지 않습니다.',
            'enrichmentOnlyFacilityIds에 표시된 기존 시설 보강은 현재 상태·신원 관측이 아닙니다. 원문 연결·용량·개별 접속 근거만 추가하며 최신 원본 수집기의 상태를 덮지 않습니다.',
        ] + ['제외 ' + key + ': ' + value for key, value in sorted(skipped.items())]}
    return out, {'considered': len(candidates), 'includedCensusSites': len(identity), 'newFacilities': sum(fid not in existing for fid in identity.values()),
        'matchedExisting': sum(fid in existing for fid in identity.values()), 'outputRowsIncludingParentPatches': len(records), 'sources': len(sources), 'excluded': skipped}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, default=ROOT / 'data/large-load-facility-fragments/legacy-sites.json')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    fragment, report = build()
    if args.check:
        if not args.output.exists() or json.loads(args.output.read_text()) != fragment:
            raise SystemExit('Legacy facility fragment differs from reviewed census and exact site links')
    else:
        args.output.write_text(json.dumps(fragment, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))

if __name__ == '__main__':
    main()
