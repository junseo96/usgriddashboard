#!/usr/bin/env python3
"""Collect public operational records, preserve observations, publish derived metrics.

Daily UTC aggregates are derived from interval evidence, not annual report values.
Failures retain previous verified observations with an explicit failed attempt.
"""
from __future__ import annotations
import argparse
import copy
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
import importlib
import json
import math
import os
from pathlib import Path
import tempfile

from transmission_common import empty_fragment, iso, number, stamp
from transmission_storage import load_group, store_group, gather_fragments as stored_fragments

APP = Path(__file__).resolve().parents[1]
FRAGMENTS = APP / 'data/transmission-fragments'
OUTPUT = APP / 'data/transmission-observations.json'
REGIONS = ['CAISO', 'ERCOT', 'PJM', 'MISO', 'SPP', 'NYISO', 'ISO-NE']
METRICS = ['price_spread', 'binding_duration', 'utilization', 'curtailment', 'load']
MODULES = {'northeast': 'transmission_northeast', 'midwest': 'transmission_midwest',
           'west': 'transmission_west', 'spp': 'transmission_spp', 'load': 'transmission_load',
           'pjm-snapshot': 'transmission_pjm_snapshot'}
OWNER_REGIONS = {'northeast': ['NYISO', 'ISO-NE'], 'midwest': ['PJM', 'MISO'], 'west': ['CAISO', 'ERCOT'],
                 'spp': ['SPP'], 'load': REGIONS, 'pjm-snapshot': ['PJM']}
ARRAYS = ['priceIntervals', 'priceSnapshots', 'constraintIntervals', 'constraintWindows',
          'loadIntervals', 'utilizationIntervals', 'curtailmentIntervals']


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name+'.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as handle:
            json.dump(data, handle, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            handle.write('\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


def rows_list(document):
    return document if isinstance(document, list) else [document]


def validate_group_scope(group, fragments):
    """A replacement group must account for every owned region, including failures."""
    expected = OWNER_REGIONS[group]
    regions = [row.get('region') if isinstance(row, dict) else None for row in fragments]
    if (len(regions) != len(expected) or any(not isinstance(region, str) for region in regions)
            or len(set(regions)) != len(regions) or set(regions) != set(expected)):
        raise ValueError(f'Collector group {group} must return each expected region exactly once: '
                         f'expected {expected}, received {regions}')


def union_seconds(intervals):
    intervals = sorted((stamp(start), stamp(end)) for start, end in intervals)
    total, right = 0.0, None
    for start, end in intervals:
        if end <= start: raise ValueError('Nonpositive operational interval')
        left = max(start, right) if right else start
        if end > left: total += (end-left).total_seconds()
        right = max(right, end) if right else end
    return total


def intersections(start, end, windows):
    """Return nonoverlapping intersections with the union of verified windows."""
    start, end = stamp(start), stamp(end)
    merged = []
    for left, right in sorted((stamp(a), stamp(b)) for a, b in windows):
        left, right = max(left, start), min(right, end)
        if right <= left: continue
        if merged and left <= merged[-1][1]: merged[-1] = (merged[-1][0], max(merged[-1][1], right))
        else: merged.append((left, right))
    return merged


def day_pieces(start, end):
    cursor, finish = stamp(start), stamp(end)
    if finish <= cursor: raise ValueError('Invalid interval order')
    while cursor < finish:
        boundary = datetime.combine(cursor.date()+timedelta(days=1), time(), timezone.utc)
        piece_end = min(finish, boundary)
        yield cursor.date().isoformat(), cursor, piece_end
        cursor = piece_end


def record_key(kind, row):
    if kind == 'priceSnapshots': return (row['region'], row.get('market'), row.get('population'), row['capturedAt'])
    return (row['region'], row.get('market') if kind == 'priceIntervals' else None,
            row.get('population') if kind == 'priceIntervals' else None,
            row.get('assetId'), row.get('contingency') or '', row.get('reason') if kind == 'curtailmentIntervals' else None,
            row['start'], row['end'])


def version_fragment_sources(fragment):
    """A revised URL/report must not relabel old observations with new evidence."""
    result = copy.deepcopy(fragment)
    mapping = {}
    for source in result.get('sources', []):
        suffix = '@'+source['sha256'][:16]
        identifier = source['id'] if source['id'].endswith(suffix) else source['id']+suffix
        mapping[source['id']] = identifier
        source['id'] = identifier
    for kind in ARRAYS:
        for row in result.get(kind, []):
            row['sourceIds'] = [mapping.get(ref,ref) for ref in row['sourceIds']]
    return result


def merge_fragment(old, fresh):
    old, fresh = version_fragment_sources(old), version_fragment_sources(fresh)
    result = dict(fresh)
    source_map = {row['id']: row for row in old.get('sources', [])}
    source_map.update({row['id']: row for row in fresh.get('sources', [])})
    result['sources'] = list(source_map.values())
    for kind in ARRAYS:
        previous = old.get(kind, [])
        # A complete new event report supersedes ALL old events in its time window,
        # including a constraint that disappeared from the corrected report.
        if kind == 'constraintIntervals' and fresh.get('constraintWindows'):
            windows = [(stamp(row['start']), stamp(row['end'])) for row in fresh['constraintWindows']]
            previous = [row for row in previous if not any(stamp(row['start']) < end and stamp(row['end']) > start for start, end in windows)]
        merged = {record_key(kind, row): row for row in previous}
        merged.update({record_key(kind, row): row for row in fresh.get(kind, [])})
        result[kind] = sorted(merged.values(), key=lambda row: json.dumps(record_key(kind, row)))
    result['notes'] = list(dict.fromkeys(old.get('notes', []) + fresh.get('notes', [])))
    return result


def gather_fragments(directory=FRAGMENTS):
    return stored_fragments(Path(directory))


def validate_sources(fragments):
    import re
    sources = {}
    for fragment in fragments:
        if fragment['region'] not in REGIONS: raise ValueError('Unexpected operational region')
        for source in fragment.get('sources', []):
            if not re.fullmatch('[a-f0-9]{64}', source['sha256']) or not source['url'].startswith('https://'):
                raise ValueError('Missing public source provenance')
            stamp(source['retrievedAt'])
            previous = sources.get(source['id'])
            if previous and previous['sha256'] != source['sha256']: raise ValueError('Conflicting source identities')
            sources[source['id']] = source
    for fragment in fragments:
        for kind in ARRAYS:
            for row in fragment.get(kind, []):
                if row['region'] != fragment['region']: raise ValueError('Cross-region fragment observation')
                if not row.get('sourceIds') or any(source not in sources for source in row['sourceIds']):
                    raise ValueError('Operational observation missing source')
                if kind != 'priceSnapshots' and stamp(row['end']) <= stamp(row['start']):
                    raise ValueError('Invalid observation interval')
    return sources


def hourly_load(fragments):
    """Prefer direct ISO observations; EIA fills unobserved hours only."""
    groups = defaultdict(lambda: defaultdict(list))
    for fragment in fragments:
        for row in fragment.get('loadIntervals', []):
            value = number(row['mw'])
            if value < 0: raise ValueError('Negative actual system demand')
            start, end = stamp(row['start']), stamp(row['end'])
            if end-start > timedelta(hours=1): raise ValueError('Load is not an hourly/subhourly actual')
            cursor = start
            while cursor < end:
                hour = cursor.replace(minute=0, second=0, microsecond=0)
                finish = min(end, hour+timedelta(hours=1))
                groups[(row['region'], iso(hour))][row.get('priority', 2)].append((cursor, finish, value, row['sourceIds']))
                cursor = finish
    result = {}
    for key, priorities in groups.items():
        for priority in sorted(priorities, reverse=True):
            unique = {}
            for start, end, value, refs in priorities[priority]:
                pair = (start, end)
                if pair in unique and abs(unique[pair][0]-value) > 1e-6: raise ValueError('Conflicting actual load intervals')
                unique[pair] = (value, refs)
            intervals = sorted((start, end, value, refs) for (start, end), (value, refs) in unique.items())
            hour = stamp(key[1]); cursor = hour; mwh = 0; sources = set(); valid = True
            for start, end, value, refs in intervals:
                if start != cursor: valid = False; break
                mwh += value*(end-start).total_seconds()/3600
                sources.update(refs); cursor = end
            if valid and cursor == hour+timedelta(hours=1):
                result[key] = dict(mwh=mwh, sourceIds=sorted(sources)); break
    return result


def price_aggregates(fragments, loads):
    hours = {}
    for fragment in fragments:
        for original in fragment.get('priceIntervals', []):
            row = dict(original)
            row['market'] = {'real_time': 'RT', 'day_ahead': 'DA'}.get(row['market'], row['market'])
            if row['resolutionMinutes'] != 60 or stamp(row['end'])-stamp(row['start']) != timedelta(hours=1):
                raise ValueError('Price composite requires full common hourly intervals')
            if stamp(row['start']).minute or stamp(row['start']).second: raise ValueError('Unaligned price hour')
            if row['nodeCount'] < 2 or row['nodeCount'] > row['candidateNodeCount']: raise ValueError('Invalid price node support')
            if abs(number(row['p90'])-number(row['p10'])-number(row['value'])) > 1e-7 or row['value'] < 0:
                raise ValueError('Incorrect congestion spread')
            key = (row['region'], row['market'], row['population'], row['start'])
            if key in hours and hours[key] != row: raise ValueError('Conflicting price hour')
            hours[key] = row
    days = defaultdict(list)
    for row in hours.values(): days[(row['region'], row['market'], row['population'], row['start'][:10])].append(row)
    result = []
    for (region, market, population, day), rows in sorted(days.items()):
        matched = [loads[(region, row['start'])] for row in rows if (region, row['start']) in loads]
        refs = set(source for row in rows for source in row['sourceIds'])
        refs.update(source for row in matched for source in row['sourceIds'])
        result.append(dict(id='|'.join([region, market, population, day]), region=region, date=day, market=market,
                           population=population, populationLabel=rows[0]['populationLabel'], value=sum(row['value'] for row in rows)/len(rows),
                           observedHours=len(rows), expectedHours=24, nodeCountMin=min(row['nodeCount'] for row in rows),
                           nodeCountMax=max(row['nodeCount'] for row in rows), candidateNodeCountMax=max(row['candidateNodeCount'] for row in rows),
                           loadMwh=sum(row['mwh'] for row in matched) if matched else None, matchedLoadHours=len(matched), sourceIds=sorted(refs)))
    national_groups = defaultdict(list)
    for row in result:
        if row['observedHours'] == row['matchedLoadHours'] == 24 and row['loadMwh'] and row['loadMwh'] > 0:
            national_groups[(row['market'], row['population'], row['date'])].append(row)
    national = []
    for (market, population, day), rows in sorted(national_groups.items()):
        if len(rows) < 2: continue
        mw = sum(row['loadMwh'] for row in rows)
        regions = sorted(row['region'] for row in rows)
        national.append(dict(id='|'.join([market,population,day]), date=day, market=market, population=population,
                             value=sum(row['value']*row['loadMwh'] for row in rows)/mw, loadMwh=mw, regions=regions,
                             excludedRegions=[region for region in REGIONS if region not in regions], nationalComplete=len(regions)==len(REGIONS),
                             sourceIds=sorted(set(source for row in rows for source in row['sourceIds']))))
    return sorted(hours.values(), key=lambda row: (row['start'],row['region'],row['population'])), result, national


def constraint_aggregates(fragments):
    windows = defaultdict(list); window_sources = defaultdict(set)
    for fragment in fragments:
        for row in fragment.get('constraintWindows', []):
            for day, start, end in day_pieces(row['start'], row['end']):
                key = (row['region'], day); windows[key].append((start, end)); window_sources[key].update(row['sourceIds'])
    assets = defaultdict(list); refs = defaultdict(set); any_binding = defaultdict(list); binding_sources = defaultdict(set)
    for fragment in fragments:
        for row in fragment.get('constraintIntervals', []):
            if row.get('binding') is not True: continue
            for day, start, end in day_pieces(row['start'], row['end']):
                regional_key = (row['region'], day)
                for left, right in intersections(start, end, windows.get(regional_key, [])):
                    key = (row['region'], day, row['assetId'], row.get('contingency') or '')
                    assets[key].append((left,right)); refs[key].update(row['sourceIds']); any_binding[regional_key].append((left,right)); binding_sources[regional_key].update(row['sourceIds'])
    coverage = []
    for (region, day), intervals in sorted(windows.items()):
        minutes = union_seconds(intervals)/60; binding = union_seconds(any_binding.get((region,day), []))/60
        coverage.append(dict(region=region, date=day, observedMinutes=minutes, expectedMinutes=1440,
                             anyBindingMinutes=binding, value=100*binding/minutes,
                             sourceIds=sorted(window_sources[(region,day)] | binding_sources[(region,day)])))
    result = []
    for (region, day, asset, contingency), intervals in sorted(assets.items()):
        minutes = union_seconds(windows[(region,day)])/60; binding = union_seconds(intervals)/60
        result.append(dict(id='|'.join([region,day,asset,contingency]), region=region, date=day, assetId=asset, contingency=contingency,
                           bindingMinutes=binding, observedMinutes=minutes, expectedMinutes=1440, value=100*binding/minutes,
                           sourceIds=sorted(refs[(region,day,asset,contingency)] | window_sources[(region,day)])))
    return result, coverage


def other_aggregates(fragments):
    utilization = defaultdict(list); curtailment = defaultdict(list)
    for fragment in fragments:
        for row in fragment.get('utilizationIntervals', []):
            value = number(row['value'])
            if value < 0 or not row.get('directionalBasis'): raise ValueError('Unproven utilization direction/ratio')
            if number(row['limitMw']) <= 0 or abs(value-abs(number(row['flowMw']))/number(row['limitMw'])*100) > 1e-6:
                raise ValueError('Utilization must be flow / matched directional limit times 100 percent')
            for day, start, end in day_pieces(row['start'],row['end']):
                basis = 'instantaneous_samples' if row.get('intervalNature') == 'instantaneous' else 'dispatch_duration'
                utilization[(row['region'],day,row['assetId'],row.get('contingency') or '',basis,row.get('sourceUnit','MW / MW'))].append((start,end,value,row['sourceIds']))
        for row in fragment.get('curtailmentIntervals', []):
            mwh = number(row['mwh'])
            if mwh < 0 or not row.get('reason'): raise ValueError('Unclassified curtailment')
            total_seconds = (stamp(row['end'])-stamp(row['start'])).total_seconds()
            for day, start, end in day_pieces(row['start'],row['end']):
                curtailment[(row['region'],day,row['reason'])].append((start,end,mwh*(end-start).total_seconds()/total_seconds,row['sourceIds']))
    util_rows, curtail_rows = [], []
    for (region,day,asset,contingency,basis,source_unit), rows in sorted(utilization.items()):
        unique = {}
        for start,end,value,refs in rows:
            if (start,end) in unique and unique[(start,end)][0] != value: raise ValueError('Conflicting flow/limit interval')
            unique[(start,end)] = (value,refs)
        seconds = sum((end-start).total_seconds() for start,end in unique)
        if abs(seconds-union_seconds(unique.keys())) > .01: raise ValueError('Overlapping utilization intervals')
        mean = sum(value for value,refs in unique.values())/len(unique) if basis=='instantaneous_samples' else sum(value*(end-start).total_seconds() for (start,end),(value,refs) in unique.items())/seconds
        util_rows.append(dict(id='|'.join([region,day,asset,contingency,basis]),region=region,date=day,assetId=asset,contingency=contingency,
                              value=mean, maximum=max(value for value,refs in unique.values()), observedHours=0 if basis=='instantaneous_samples' else seconds/3600,
                              sampleCount=len(unique),aggregationBasis=basis,sourceUnit=source_unit,
                              sourceIds=sorted(set(ref for value,refs in unique.values() for ref in refs))))
    for (region,day,reason), rows in sorted(curtailment.items()):
        unique = {}
        for start,end,value,refs in rows:
            if (start,end) in unique and unique[(start,end)][0] != value: raise ValueError('Conflicting curtailment interval')
            unique[(start,end)] = (value,refs)
        total_seconds = sum((end-start).total_seconds() for start,end in unique)
        if abs(total_seconds-union_seconds(unique.keys())) > .01:
            raise ValueError('Overlapping curtailment energy intervals')
        curtail_rows.append(dict(id='|'.join([region,day,reason]),region=region,date=day,reason=reason,
                                 value=sum(value for value,refs in unique.values()), observedHours=union_seconds(unique.keys())/3600,
                                 sourceIds=sorted(set(ref for value,refs in unique.values() for ref in refs))))
    return util_rows, curtail_rows


def assemble(fragments, requested_start, requested_end):
    sources = validate_sources(fragments)
    loads = hourly_load(fragments)
    price_hours, price_days, national_days = price_aggregates(fragments, loads)
    constraints, constraint_coverage = constraint_aggregates(fragments)
    utilization, curtailment = other_aggregates(fragments)
    snapshots = [row for fragment in fragments for row in fragment.get('priceSnapshots', [])]
    for row in snapshots:
        if abs(number(row['p90'])-number(row['p10'])-number(row['value'])) > 1e-7: raise ValueError('Invalid price snapshot')
    declarations = defaultdict(list)
    for fragment in fragments:
        for row in fragment.get('coverage', []): declarations[(row['region'],row['metric'])].append(row)
    coverage = []
    for region in REGIONS:
        for metric in METRICS:
            observations = {'price_spread': [row for row in price_days if row['region']==region],
                            'binding_duration': [row for row in constraint_coverage if row['region']==region],
                            'utilization': [row for row in utilization if row['region']==region],
                            'curtailment': [row for row in curtailment if row['region']==region],
                            'load': [{'date': start[:10]} for (area,start) in loads if area==region]}[metric]
            declared = declarations.get((region,metric), [])
            if metric == 'load' and observations:
                # A missing native feed does not negate the independently acquired
                # actual EIA denominator. Retain successful source explanations.
                successful = [row for row in declared if row['status'] in ('observed','partial')]
                if successful: declared = successful
            dates = sorted(set(row['date'] for row in observations))
            snapshot_only = metric=='price_spread' and not observations and any(row['region']==region for row in snapshots)
            if observations: status = 'partial' if any(row['status']!='observed' for row in declared) else 'observed'
            elif snapshot_only: status = 'partial'
            else: status = next((row['status'] for row in declared if row['status'] in ('auth_required','access_blocked')), 'unavailable')
            reason = ' / '.join(dict.fromkeys(row['reason'] for row in declared)) or '공식 원문의 이 지표 수치를 확보하지 못했습니다.'
            if snapshot_only: reason = '공식 공개 지도의 MCC 스냅샷 확보. 원자료 관측시각이 없어 시간별·일별 평균과 전국 합성에서 제외. '+reason
            coverage.append(dict(region=region,metric=metric,status=status,reason=reason,
                                 sourceUrls=list(dict.fromkeys(url for row in declared for url in row.get('sourceUrls', [])))[:6],
                                 firstDate=dates[0] if dates else None,lastDate=dates[-1] if dates else None,
                                 observationCount=len(observations),dayCount=len(dates)))
    result = dict(schemaVersion=1,methodologyVersion='operational-congestion-v1',
                  generatedAt=max((source['retrievedAt'] for source in sources.values()), key=stamp, default=iso(datetime.now(timezone.utc))),
                  requestedStart=str(requested_start),requestedEnd=str(requested_end),sources=sorted(sources.values(),key=lambda row:row['id']),
                  priceHours=price_hours,priceSnapshots=snapshots,priceDays=price_days,nationalDays=national_days,
                  constraintDays=constraints,constraintCoverageDays=constraint_coverage,utilizationDays=utilization,curtailmentDays=curtailment,
                  coverage=coverage,notes=[
                    'MCC(혼잡 성분)의 부호를 보존하고 동일 UTC 시간에 노드별 시간 평균을 먼저 구한 뒤 동일 가중 선형 P90−P10을 계산한다. 연료·에너지 성분과 손실 성분은 포함하지 않는다.',
                    '부하구역·물리 가격노드·공개 가격위치·허브는 다른 모집단이다. 각 권역의 노드 수와 분할 방식도 달라 절대 순위나 전국 모든 선로의 혼잡률로 해석하지 않는다.',
                    '통합 가격지수는 같은 RT/DA 시장·모집단·UTC 날짜의 24시간 가격과 같은 시간 실제 부하가 모두 있는 권역만 공급 MWh로 가중한다. 포함 권역은 날짜마다 달라질 수 있다. 비ISO 지역은 분모에 없다.',
                    '제약 발생률은 검증한 보고기간의 시간 합집합을 분모로 한다. 개별 모델 제약은 설비와 contingency를 함께 식별하며 동시 제약시간을 권역 시간으로 중복 합산하지 않는다.',
                    '완전히 빠진 보고기간은 0으로 채우지 않는다. 성공한 완전 제약 보고서에서 특정 제약이 보고되지 않은 시간만 비발생으로 계산한다.',
                    '이용률은 같은 시각·설비·contingency·방향의 흐름과 운전한도를 확보한 범위다. 사고 대비 제약 때문에 이용률 100% 미만에서도 가격 혼잡이 생길 수 있다.',
                    '가격 분위수는 소수 지점의 극단적 혼잡을 놓칠 수 있다. 지점 수와 제약 지속성을 함께 확인한다. 공개 지도 스냅샷의 취득시각은 원자료 관측시각을 대신하지 않는다.',
                    '원본은 취득시각·SHA-256으로 보관한다. 일별 시계열의 날짜는 시장별 날짜를 맞추기 위해 UTC 00–24시로 통일했으며 KST로는 당일 09시–다음날 09시다.',
                  ])
    validate_dataset(result)
    return result


def validate_dataset(data):
    if data['schemaVersion'] != 1 or len(data['coverage']) != 35: raise ValueError('Incomplete seven-region coverage matrix')
    refs = {row['id'] for row in data['sources']}
    for field in ['priceHours','priceSnapshots','priceDays','nationalDays','constraintDays','constraintCoverageDays','utilizationDays','curtailmentDays']:
        for row in data.get(field, []):
            if not row.get('sourceIds') or any(ref not in refs for ref in row['sourceIds']): raise ValueError('Derived data source mismatch')
            if not math.isfinite(row['value']) or row['value'] < 0: raise ValueError('Invalid derived observation')
    for row in data['nationalDays']:
        if len(row['regions']) < 2 or row['loadMwh'] <= 0 or row['nationalComplete'] != (len(row['regions'])==7): raise ValueError('Invalid covered-region composite')
    for row in data['constraintDays']+data['constraintCoverageDays']:
        numerator = row.get('bindingMinutes',row.get('anyBindingMinutes'))
        if not 0 <= numerator <= row['observedMinutes'] <= 1440 or abs(row['value']-100*numerator/row['observedMinutes']) > 1e-6:
            raise ValueError('Constraint duration denominator mismatch')
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start'); parser.add_argument('--end'); parser.add_argument('--days',type=int,default=14)
    parser.add_argument('--groups',default=','.join(MODULES)); parser.add_argument('--assemble-only',action='store_true')
    parser.add_argument('--check',action='store_true'); parser.add_argument('--refresh',action='store_true')
    parser.add_argument('--output',default=str(OUTPUT))
    args = parser.parse_args()
    if args.check:
        data = json.loads(Path(args.output).read_text()); validate_dataset(data)
        # Published data must reproduce from its retained normalized evidence.
        expected = assemble(gather_fragments(), data['requestedStart'], data['requestedEnd'])
        if data != expected: raise ValueError('Operational artifact differs from retained interval evidence')
        print(json.dumps({key:len(data[key]) for key in ['sources','priceHours','priceDays','nationalDays','constraintDays','utilizationDays','curtailmentDays']})); return
    end = date.fromisoformat(args.end) if args.end else datetime.now(timezone.utc).date()-timedelta(days=1)
    start = date.fromisoformat(args.start) if args.start else end-timedelta(days=args.days-1)
    if start>end or end-start>timedelta(days=366): raise ValueError('Invalid acquisition date window')
    report = dict(startedAt=iso(datetime.now(timezone.utc)),requestedStart=str(start),requestedEnd=str(end),groups={})
    if not args.assemble_only:
        for group in args.groups.split(','):
            if group not in MODULES: raise ValueError('Unknown collector group')
            old = {row['region']:row for row in load_group(FRAGMENTS,group)}
            try:
                module = importlib.import_module(MODULES[group])
                fresh = rows_list(module.collect(start,end,APP/'.local/transmission',refresh=args.refresh))
                validate_group_scope(group, fresh)
                validate_sources(fresh)
                merged = [merge_fragment(old.get(row['region'],empty_fragment(row['region'])),row) for row in fresh]
                validate_sources(merged)
                store_group(FRAGMENTS,group,merged)
                state = 'partial' if any(coverage['status'] != 'observed' for row in fresh for coverage in row.get('coverage',[])) else 'success'
                report['groups'][group] = dict(status=state,regions=[row['region'] for row in fresh],
                    observations={row['region']:{key:len(row.get(key,[])) for key in ARRAYS} for row in fresh})
            except Exception as error:
                report['groups'][group] = dict(status='failed',error=f'{type(error).__name__}: {error}')
                if not old: raise
                for region, fragment in old.items():
                    for coverage in fragment.get('coverage',[]):
                        coverage['status']='partial' if any(fragment.get(key) for key in ARRAYS) else 'unavailable'
                        coverage['reason']='이번 수집 실패: 이전 검증 관측을 보존. '+str(error)[:250]
                        coverage['lastAttemptAt']=report['startedAt']
                store_group(FRAGMENTS,group,list(old.values()))
    fragments = gather_fragments()
    existing = json.loads(Path(args.output).read_text()) if Path(args.output).exists() else {}
    earliest = min(str(start),existing.get('requestedStart',str(start)))
    result = assemble(fragments,earliest,str(end))
    atomic_json(args.output,result)
    report['completedAt']=iso(datetime.now(timezone.utc)); report['status']='partial' if any(row['status']!='success' for row in report['groups'].values()) else 'success'
    atomic_json(APP/'.local/transmission/latest-run.json',report)
    print(json.dumps(dict(status=report['status'],priceHours=len(result['priceHours']),constraintDays=len(result['constraintDays']),sources=len(result['sources']))))


if __name__=='__main__': main()
