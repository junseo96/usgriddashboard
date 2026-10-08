#!/usr/bin/env python3
"""Re-express archived official-source records in Grid Atlas' independent schema.
No prior scoring logic, assessments or inferred gate progress is imported.
"""
import argparse
import collections
import hashlib
import datetime as dt
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATES = set('AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())
GEN_SOURCE = 'lbnl-generation-storage-queues'


def capacity(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 else None


def source_for(row, sources):
    if row['kind'] == 'generation':
        return GEN_SOURCE
    op = row['operator']
    fixed = {'NYISO': 'nyiso-load-register', 'PJM M-3': 'pjm-m3-support', 'BPA': 'bpa-ll-register',
             'PG&E': 'california-pge-industrial-register', 'SDG&E': 'california-sdge-register',
             'ISO-NE': 'isone-selected-forecast', 'AES Ohio': 'pjm-aes-contract-table',
             'Idaho Power': 'west-idaho-contracts', 'PacifiCorp / Rocky Mountain Power': 'west-pacificorp-contract',
             'Black Hills Power': 'west-blackhills', 'Black Hills Wyoming Electric': 'west-blackhills-wyoming-case',
             'LG&E': 'southeast-lge-case'}
    if op in fixed:
        return fixed[op]
    if op == 'SPP':
        return 'spp-dpa-history' if row.get('recordType') == 'historical_delivery_point_assessment' or row.get('queueId', '').startswith('DPA-') else 'spp-dpns-reports'
    if op.startswith('NV Energy'):
        return 'west-nv-llesa'
    if op == 'Georgia Power':
        return {'removed_from_reporting_screen': 'gpc-removed-screen', 'company_project_announcement': 'gpc-named-openai'}.get(row.get('recordType'), 'gpc-main-register')
    matches = [s['id'] for s in sources if s['url'] == row['source']]
    if len(matches) == 1:
        return matches[0]
    raise ValueError('No unambiguous source mapping: ' + row['id'])


def normalize(row, sources, missing_ids):
    source_id = source_for(row, sources)
    source = next(s for s in sources if s['id'] == source_id)
    is_load = row['kind'] == 'load'
    components = row.get('fuel', '').split('+')
    has_storage = any(c in ('Battery', 'Other Storage') for c in components)
    has_gen = not is_load and ((capacity(row.get('mw')) or 0) > 0 or ((capacity(row.get('storageMw')) or 0) == 0 and any(c not in ('Battery', 'Other Storage', '') for c in components)))
    types = ['load'] if is_load else (['generation'] if has_gen else []) + (['storage'] if has_storage else [])
    generation = capacity(row.get('mw')) if has_gen else None
    storage = capacity(row.get('storageMw')) if has_storage else None
    if row.get('storageMissing') and not storage:
        storage = None
    partial = bool(row.get('storageMissing') or row['id'] in missing_ids)
    if row['id'] in missing_ids and not generation:
        generation = None
    load = capacity(row.get('mw')) if is_load else None
    raw_status = row.get('status', '')
    status = {'active': 'active', 'withdrawn': 'withdrawn', 'operating': 'operational', 'energized': 'operational'}.get(raw_status, 'reference' if is_load else 'unknown')
    reason = None
    state = {'New York': 'NY'}.get(row.get('state'), row.get('state')) or None
    if state not in STATES:
        reason = '미국 본토 48주/DC 위치 미확인 또는 범위 밖'
    elif status != 'active':
        reason = '활성 신청 상태 미확인 또는 종료·참고 기록'
    elif is_load and not (source_id == 'nyiso-load-register' and row.get('recordType') == 'project'):
        reason = '현재 개별 수용가 접속 신청으로 검증되지 않은 참고 기록'
    elif not is_load and not row.get('include'):
        reason = '원자료의 신청 집계 대상에서 제외'
    relevant = [v for t, v in [('generation', generation), ('storage', storage), ('load', load)] if t in types]
    cap_status = 'unknown' if all(v is None for v in relevant) else 'partial' if partial or any(v is None for v in relevant) else 'known'
    return dict(id=row['id'], sourceId=source_id, sourceRecordId=str(row.get('queueId') or row['id']) if source_id == 'nyiso-load-register' else row['id'], name=row['name'],
                types=types, region=row['region'], state=state, status=status, generationMw=generation,
                storageMw=storage, loadMw=load, capacityStatus=cap_status, eligible=reason is None,
                exclusionReason=reason, sourceUrl=row['source'], sourceAsOf=None if source_id == 'nyiso-load-register' or row.get('recordType') == 'historical_delivery_point_assessment' else row.get('asof'),
                rawStatus=str(row.get('rawStage') or raw_status), identityScope='source_record')


def build(reference):
    original_sources = json.loads((reference / 'load-sources.json').read_text())
    sources = [dict(id=s['id'], name=s['title'], region=s['region'], types=['load'], url=s['url'],
                    coverage=s['coverage'].replace('-', '_'), sourceAsOf=s['sourceDate'], lastCheckedAt=s['checkedAt'],
                    refreshCadence='weekly' if s['id'] == 'nyiso-load-register' else 'monthly',
                    recordCount=s.get('loadedRows'), gaps=s['gaps'] + [s['universe'], s['sourceDateMeaning']],
                    adapter='nyiso_xlsx_v1' if s['id'] == 'nyiso-load-register' else None) for s in original_sources]
    sources.append(dict(id=GEN_SOURCE, name='LBNL 발전·저장 접속 대기열', region='US', types=['generation', 'storage'],
                        url='https://emp.lbl.gov/queues', coverage='filtered_register', sourceAsOf='2025-12-31',
                        lastCheckedAt=None, refreshCadence='annual', recordCount=8513, adapter='lbnl_active_xlsx_v1',
                        gaps=['보관된 2025년 말 활성 신청 목록. 배전·소규모 신청 및 모든 사업자 포괄 미보장.',
                              '개별 MW 누락과 복합 발전·저장 구성 일부 미공개. 물리 프로젝트 중복 제거 미완료.',
                              '공식 연간 원장 사이의 개별 신청 변화는 미확인. 매주/매월 검사해도 원자료 기준일은 발행된 연간 기준일을 유지.']))
    sources.append(dict(id='southeast-lge-case', name='LG&E 공개 고객 계약 사례', region='Southeast', types=['load'],
                        url='https://lge-ku.com/newsroom/press-releases/2025/01/16/lge-announces-first-major-data-center-electric-customer',
                        coverage='case', sourceAsOf='2025-01-16', lastCheckedAt=None, refreshCadence='monthly', recordCount=1, adapter=None,
                        gaps=['단일 공개 사례이며 현재 개별 접속 신청 원장 전체를 대체하지 않음.']))
    sources.append(dict(id='west-blackhills-wyoming-case', name='Black Hills Wyoming 공개 사업 발표', region='West', types=['load'],
                        url='https://www.sec.gov/Archives/edgar/data/1130464/000119312526335259/bkh-ex99.htm',
                        coverage='case', sourceAsOf='2026-08-05', lastCheckedAt=None, refreshCadence='monthly', recordCount=1, adapter=None,
                        gaps=['Wyoming 개별 공개 발표. South Dakota EL26-008 계약 사건과 별도. 현재 전체 접속 신청 원장 미확보.']))
    rows = json.loads((reference / 'projects.json').read_text())
    missing_ids = {x['id'] for x in json.loads((reference / 'generation-missing-components.json').read_text())}
    projects = [normalize(row, sources, missing_ids) for row in rows]
    primary_counts = collections.Counter(p['sourceId'] for p in projects)
    for source in sources:
        if source['recordCount'] is not None and source['recordCount'] != primary_counts[source['id']]:
            source['gaps'].append('recordCount는 이 앱에서 해당 출처를 주 출처로 지정한 고유 레코드 수. 원문 전체 행 수·중복 원장 연결 수와 다를 수 있음.')
        source['recordCount'] = primary_counts[source['id']] if source['recordCount'] is not None else None
    if len({p['id'] for p in projects}) != len(projects):
        raise ValueError('Duplicate stable source ID')
    hashes = {name: hashlib.sha256((reference / name).read_bytes()).hexdigest() for name in ('projects.json', 'load-sources.json', 'generation-missing-components.json')}
    eligible = [p for p in projects if p['eligible']]
    summary = {'records': len(projects), 'eligible': len(eligible), 'eligibleByType': dict(collections.Counter(t for p in eligible for t in p['types'])),
               'capacityUnknownOrPartial': sum(p['capacityStatus'] != 'known' for p in eligible), 'gateAssessments': 0,
               'coverageSources': dict(collections.Counter(s['coverage'] for s in sources)),
               'knownCapacityMw': {t: round(sum(p[t + 'Mw'] or 0 for p in eligible), 6) for t in ('generation', 'storage', 'load')}}
    return {'projects': projects, 'sources': sources, 'assessments': [], 'provenance': {
        'origin': 'Official-source records from the supplied archive, independently normalized; not newly reacquired nationwide.',
        'referenceSha256': hashes, 'sourceRecordIdentityOnly': True, 'nationalComplete': False,
        'historicalBackfill': False, 'summary': summary}}


def refresh_from_report(bootstrap, report_path):
    """Verify raw bytes and independently regenerate candidate rows before merging.

    Only the two implemented official adapters are accepted. A collection report
    is provenance, not permission to trust its row data or to infer fresh dates.
    """
    from collect import encode, parse_nyiso, discover_lbnl_workbook, parse_lbnl, workbook_source_as_of
    report_path = report_path.resolve()
    root = report_path.parent.parent.parent
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    if report_path.parent.name != report['id'] or report_path.parent.parent.name != 'runs':
        raise ValueError('Report must be inside its collector runs/<id> directory')
    if report['status'] not in ('success', 'partial'):
        raise ValueError('A failed collection cannot refresh bootstrap')
    sources = {source['id']: source for source in bootstrap['sources']}
    replacements, refreshes = {}, []

    def artifact(relative_path, manifest):
        path = (root / relative_path).resolve()
        if not path.is_relative_to(root.resolve()) or path.parent != (root / 'raw').resolve():
            raise ValueError('Raw artifact path escapes collection archive')
        raw = path.read_bytes()
        if len(raw) != manifest['bytes'] or hashlib.sha256(raw).hexdigest() != manifest['sha256']:
            raise ValueError('Raw artifact checksum/size mismatch')
        when = dt.datetime.fromisoformat(manifest['retrievedAt'].replace('Z', '+00:00'))
        if when.tzinfo is None or when > dt.datetime.now(dt.timezone.utc):
            raise ValueError('Invalid acquisition timestamp')
        if not report['startedAt'] <= manifest['retrievedAt'] <= report['finishedAt']:
            raise ValueError('Acquisition is outside recorded collection run')
        return raw

    for result in report['results']:
        if result['status'] not in ('normalized', 'imported'):
            continue
        source_id = result['sourceId']
        if source_id not in ('nyiso-load-register', GEN_SOURCE) or source_id not in sources or source_id in replacements:
            raise ValueError('Unknown, unsupported or duplicate complete source scope')
        source = sources[source_id]
        manifest = result['manifest']
        raw = artifact(result['rawPath'], manifest)
        if source_id == 'nyiso-load-register':
            if manifest['url'] != source['url'] or manifest['finalUrl'] != source['url']:
                raise ValueError('NYISO acquisition source mismatch')
            projects, _ = parse_nyiso(raw, source)
            cutoff = None
        else:
            index_manifest = result['indexManifest']
            index = artifact(result['indexRawPath'], index_manifest)
            if index_manifest['url'] != source['url'] or index_manifest['finalUrl'] != source['url']:
                raise ValueError('LBNL index source mismatch')
            workbook_url = discover_lbnl_workbook(index, source['url'])
            if manifest['url'] != workbook_url or manifest['finalUrl'] != workbook_url:
                raise ValueError('LBNL workbook is not the verified index target')
            projects, _ = parse_lbnl(raw, {**source, 'workbookUrl': workbook_url})
            cutoff = workbook_source_as_of(raw, workbook_url)
        normalized_hash = hashlib.sha256(encode(projects)).hexdigest()
        if normalized_hash != result['normalizedSha256'] or len(projects) != result['projectCount']:
            raise ValueError('Regenerated source rows do not match recorded normalized checksum')
        candidate_bytes = (report_path.parent / (source_id + '-import.json')).read_bytes()
        candidate = json.loads(candidate_bytes)
        expected_source = {**source, 'sourceAsOf': cutoff, 'lastCheckedAt': manifest['retrievedAt'], 'recordCount': len(projects)}
        expected = {'sourceId': source_id, 'projects': projects, 'source': expected_source, 'completeScope': True,
                    'retrievedAt': manifest['retrievedAt'], 'sourceSha256': manifest['sha256']}
        if candidate != expected:
            raise ValueError('Candidate checksum/content differs from independently verified complete source')
        replacements[source_id] = expected
        refreshes.append({'sourceId': source_id, 'runId': report['id'], 'retrievedAt': manifest['retrievedAt'],
                          'sourceAsOf': cutoff, 'sourceUrl': manifest['url'], 'sourceSha256': manifest['sha256'],
                          'normalizedSha256': normalized_hash, 'candidateSha256': hashlib.sha256(candidate_bytes).hexdigest(),
                          'reportSha256': hashlib.sha256(report_bytes).hexdigest(),
                          **({'indexSha256': result['indexManifest']['sha256']} if source_id == GEN_SOURCE else {})})
    if not replacements:
        raise ValueError('No validated complete sources in report')
    output = copy.deepcopy(bootstrap)
    output['projects'] = [p for p in output['projects'] if p['sourceId'] not in replacements]
    for replacement in replacements.values():
        output['projects'].extend(replacement['projects'])
    output['sources'] = [replacements[s['id']]['source'] if s['id'] in replacements else s for s in output['sources']]
    if len({p['id'] for p in output['projects']}) != len(output['projects']) or len({(p['sourceId'], p['sourceRecordId']) for p in output['projects']}) != len(output['projects']):
        raise ValueError('Refresh collides with another source identity')
    output['provenance'].setdefault('sourceRefreshes', []).extend(refreshes)
    eligible = [p for p in output['projects'] if p['eligible']]
    output['provenance']['summary'].update(records=len(output['projects']), eligible=len(eligible),
        eligibleByType=dict(collections.Counter(t for p in eligible for t in p['types'])),
        capacityUnknownOrPartial=sum(p['capacityStatus'] != 'known' for p in eligible),
        knownCapacityMw={t: round(sum(p[t + 'Mw'] or 0 for p in eligible), 6) for t in ('generation', 'storage', 'load')})
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reference-dir', type=Path, default=ROOT.parents[1] / 'data')
    parser.add_argument('--refresh-report', action='append', type=Path, default=[], help='Verify raw artifacts and import candidates from a completed collector report before merging')
    args = parser.parse_args()
    payload = build(args.reference_dir)
    for report_path in args.refresh_report:
        payload = refresh_from_report(payload, report_path)
    (ROOT / 'data').mkdir(exist_ok=True)
    (ROOT / 'data' / 'bootstrap.json').write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n')
    (ROOT / 'data' / 'source-registry.json').write_text(json.dumps(payload['sources'], ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(payload['provenance']['summary'], ensure_ascii=False, indent=2))
