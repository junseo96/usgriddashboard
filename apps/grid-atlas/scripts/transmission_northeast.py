"""Public NYISO / ISO-NE operational congestion evidence, without credentials.

ISO-NE: original hourly RT Congestion component and SAME-DAY DA location metadata.
NYISO: hourly RT zonal congestion, 5-minute limiting constraints, integrated hourly
load and external-interface directional limits/flows. No LMP spread substitution.
Closed-day event windows require a complete accompanying hourly price day.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.error
import urllib.request
import zipfile
from zoneinfo import ZoneInfo

from transmission_common import empty_fragment, hourly_price_spreads, iso, number

EASTERN = ZoneInfo('America/New_York')
NY_ZONES = {'CAPITL', 'CENTRL', 'DUNWOD', 'GENESE', 'HUD VL', 'LONGIL', 'MHK VL', 'MILLWD', 'N.Y.C.', 'NORTH', 'WEST'}
NY_BASE = 'https://mis.nyiso.com/public/csv'
ISO_BASE = 'https://www.iso-ne.com/static-transform/csv/histRpts'


def days(start, end):
    cursor, last = date.fromisoformat(str(start)), date.fromisoformat(str(end))
    if cursor > last or (last-cursor).days > 370:
        raise ValueError('Expected inclusive dates within a one-year collection window')
    while cursor <= last:
        yield cursor
        cursor += timedelta(days=1)


def cached(url, key, root, publisher, title, refresh=False):
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    rawpath, metapath = root / (key + '.raw'), root / (key + '.json')
    if not refresh and rawpath.exists() and metapath.exists():
        raw, meta = rawpath.read_bytes(), json.loads(metapath.read_text())
        if meta.get('url') != url or hashlib.sha256(raw).hexdigest() != meta.get('sha256'):
            raise ValueError('Cached source hash / URL mismatch: ' + key)
    else:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'GridAtlas public-data research/1.0'}), timeout=35) as response:
            raw = response.read(64 * 1024 * 1024 + 1)
            if len(raw) > 64 * 1024 * 1024:
                raise ValueError('Source exceeds acquisition size bound')
            meta = dict(url=url, finalUrl=response.url, status=response.status, bytes=len(raw),
                        retrievedAt=iso(datetime.now(timezone.utc)), sha256=hashlib.sha256(raw).hexdigest())
        rawpath.write_bytes(raw); metapath.write_text(json.dumps(meta, ensure_ascii=False, indent=2)+'\n')
    return raw, dict(id=key+'-'+meta['sha256'][:12], title=title, publisher=publisher, url=url,
                     retrievedAt=meta['retrievedAt'], sha256=meta['sha256'])


def csv_report(raw, required):
    rows = list(csv.reader(io.StringIO(raw.decode('utf-8-sig'))))
    headers = [r for r in rows if r and r[0] == 'H' and required <= set(r)]
    if len(headers) != 1:
        raise ValueError('Expected unique ISO-NE report header: ' + ', '.join(sorted(required)))
    header = headers[0]
    if len(set(header)) != len(header):
        raise ValueError('Duplicate source column')
    data = [dict(zip(header, r)) for r in rows if r and r[0] == 'D' and len(r) == len(header)]
    declared = [r for r in rows if r and r[0] == 'T']
    if len(declared) != 1 or not re.fullmatch(r'\d+ lines', declared[0][1]) or int(declared[0][1].split()[0]) != len(data):
        raise ValueError('Missing or unreconciled ISO-NE report record-count trailer')
    return data


def hour_ending(day, value):
    """ISO-NE HE02X is the repeated fall-back hour, not a duplicate record."""
    match = re.fullmatch(r'(\d{1,2})(X?)', value.strip())
    if not match or not 1 <= int(match[1]) <= 24:
        raise ValueError('Unrecognized source hour ending')
    start = datetime.combine(day, datetime.min.time()).replace(hour=int(match[1])-1, tzinfo=EASTERN, fold=int(bool(match[2])))
    start = start.astimezone(timezone.utc)
    return iso(start), iso(start + timedelta(hours=1))


def isone_prices(price_raw, map_raw, day, source_ids, diagnostics=None):
    prices = csv_report(price_raw, {'Date','Hour Ending','Location','Congestion','LMP','Energy','Loss'})
    locations = csv_report(map_raw, {'Location Name','Location Type','Location ID','Date','Hour Ending'})
    mapping = {}
    for row in locations:
        if datetime.strptime(row['Date'], '%m/%d/%Y').date() != day:
            raise ValueError('Location map belongs to another operating day')
        name, kind = row['Location Name'], row['Location Type']
        if name in mapping and mapping[name] != kind:
            raise ValueError('Conflicting same-day location membership')
        mapping[name] = kind
    cohorts = {'NETWORK NODE': [], 'LOAD ZONE': []}
    unclassified = set()
    for row in prices:
        if datetime.strptime(row['Date'], '%m/%d/%Y').date() != day:
            raise ValueError('RT report belongs to another operating day')
        if row['Location'] not in mapping:
            unclassified.add(row['Location'])
            continue
        kind = mapping[row['Location']]
        if kind not in cohorts:
            continue
        start, end = hour_ending(day, row['Hour Ending'])
        # Explicit MCC only. Energy / marginal losses remain excluded.
        value = number(row['Congestion'])
        if abs(number(row['LMP']) - number(row['Energy']) - value - number(row['Loss'])) > .031:
            raise ValueError('RT LMP component reconciliation failed')
        cohorts[kind].append(dict(start=start,end=end,node=row['Location'],value=value,sourceIds=source_ids))
    result = hourly_price_spreads(cohorts['NETWORK NODE'], 'ISO-NE', 'RT', 'physical_nodes', 'ISO-NE NETWORK NODE · 같은 날 공식 노드분류')
    result += hourly_price_spreads(cohorts['LOAD ZONE'], 'ISO-NE', 'RT', 'load_zones', 'ISO-NE 8개 부하구역 · 허브·외부노드 제외')
    for point in result:
        kind = 'NETWORK NODE' if point['population'] == 'physical_nodes' else 'LOAD ZONE'
        point['candidateNodeCount'] = sum(v == kind for v in mapping.values())
    if unclassified and diagnostics is not None:
        diagnostics.append(day.isoformat()+': 같은 날 공식 분류 미연결 '+str(len(unclassified))+'개 RT 가격위치는 제외 ('+', '.join(sorted(unclassified))+').')
    return result


def plain_csv(raw, required):
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    if not reader.fieldnames or not required <= set(reader.fieldnames):
        raise ValueError('Unrecognized NYISO CSV header: '+str(reader.fieldnames))
    return list(reader)


def ny_timestamp(row):
    raw = row['Time Stamp'].strip()
    parsed = None
    for fmt in ['%m/%d/%Y %H:%M:%S', '%m/%d/%Y %H:%M', '%Y-%m-%d %H:%M:%S']:
        try:
            parsed = datetime.strptime(raw, fmt); break
        except ValueError:
            pass
    if parsed is None:
        raise ValueError('Unrecognized NYISO timestamp')
    tz = row.get('Time Zone', '').strip()
    if tz in ('EDT', 'EST'):
        return parsed.replace(tzinfo=timezone(timedelta(hours=-4 if tz == 'EDT' else -5))).astimezone(timezone.utc)
    early, late = parsed.replace(tzinfo=EASTERN, fold=0), parsed.replace(tzinfo=EASTERN, fold=1)
    if early.utcoffset() != late.utcoffset():
        raise ValueError('Ambiguous NYISO DST timestamp without zone')
    return early.astimezone(timezone.utc)


def nyiso_prices(raw, day, source_id):
    data = plain_csv(raw, {'Time Stamp','Name','PTID','LBMP ($/MWHr)','Marginal Cost Congestion ($/MWHr)'})
    rows = []
    for r in data:
        if r['Name'].strip() not in NY_ZONES:
            continue
        start = ny_timestamp(r)
        if start.astimezone(EASTERN).date() != day:
            raise ValueError('Hourly NYISO price file date mismatch')
        if start.minute or start.second:
            raise ValueError('NYISO hourly LMP is not aligned to the hour')
        # NYISO's raw MCC sign is inverse to additive price contribution.
        rows.append(dict(start=iso(start),end=iso(start+timedelta(hours=1)),node=r['Name'].strip(),
                         value=-number(r['Marginal Cost Congestion ($/MWHr)']),sourceIds=[source_id]))
    result = hourly_price_spreads(rows, 'NYISO', 'RT', 'load_zones', 'NYISO 11개 부하구역 · 원문 혼잡성분 부호 정규화')
    return [p for p in result if p['nodeCount'] == len(NY_ZONES)]


def nyiso_load(raw, day, source_id):
    rows = plain_csv(raw, {'Time Stamp','Name','Integrated Load'})
    groups = {}
    for r in rows:
        zone = r['Name'].strip()
        if zone not in NY_ZONES:
            continue
        start = ny_timestamp(r)
        if start.astimezone(EASTERN).date() != day or start.minute or start.second:
            raise ValueError('Integrated NYISO load date / hour mismatch')
        value = number(r['Integrated Load'])
        if value < 0:
            raise ValueError('Negative integrated load')
        group = groups.setdefault(start,{})
        if zone in group and group[zone] != value:
            raise ValueError('Conflicting NYISO zonal load')
        group[zone] = value
    return [dict(region='NYISO',start=iso(start),end=iso(start+timedelta(hours=1)),mw=sum(zones.values()),sourceIds=[source_id])
            for start,zones in sorted(groups.items()) if set(zones)==NY_ZONES]


def nyiso_constraints(raw, day, source_id):
    data = plain_csv(raw, {'Time Stamp','Limiting Facility','Facility PTID','Contingency','Constraint Cost($)'})
    result = []
    for row in data:
        start = ny_timestamp(row)
        if start.astimezone(EASTERN).date() != day:
            raise ValueError('Constraint report date mismatch')
        value = number(row['Constraint Cost($)'])
        if not row['Limiting Facility'].strip():
            raise ValueError('Limiting facility identity missing')
        result.append(dict(region='NYISO',start=iso(start),end=iso(start+timedelta(minutes=5)),
                           assetId=row['Facility PTID'].strip()+' · '+row['Limiting Facility'].strip(),
                           contingency=row['Contingency'].strip() or None,binding=abs(value)>0,sourceIds=[source_id]))
    return result


def nyiso_flows(raw, day, source_id):
    data = plain_csv(raw, {'Time Stamp','Interface Name','Flow (MWH)','Positive Limit (MWH)','Negative Limit (MWH)'})
    result=[]
    for r in data:
        start=ny_timestamp(r)
        if start.astimezone(EASTERN).date()!=day:
            raise ValueError('Interface report date mismatch')
        flow=number(r['Flow (MWH)']); limit=number(r['Positive Limit (MWH)'] if flow>=0 else r['Negative Limit (MWH)'])
        if limit==0:
            continue
        # Both source values use the same dimensional basis. Never sum interfaces.
        result.append(dict(region='NYISO',start=iso(start),end=iso(start+timedelta(minutes=5)),assetId=r['Interface Name'],
                           contingency=None,flowMw=flow,limitMw=abs(limit),value=abs(flow)/abs(limit)*100,
                           sourceUnit='MWH (as published; ratio only)',directionalBasis='해당 외부 연계구간의 흐름 부호에 맞는 양/음 한도. 원문 열 표기 MWH; 순간 전력/한도의 동차 비율.',sourceIds=[source_id]))
    return result


def ny_fetch(dataset, filename, day, root, refresh):
    month=day.strftime('%Y%m01'); filename_day=day.strftime('%Y%m%d')+filename+'.csv'
    if day >= datetime.now(EASTERN).date()-timedelta(days=6):
        return cached(f'{NY_BASE}/{dataset}/{filename_day}', 'nyiso-'+filename+'-'+day.strftime('%Y%m%d'), root,
                      'NYISO', dataset+' · '+day.isoformat(), refresh)
    raw, source = cached(f'{NY_BASE}/{dataset}/{month}{filename}_csv.zip','nyiso-'+filename+'-'+month,root,
                         'NYISO', dataset+' 월간 공식 보관본 · '+month[:6],refresh)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if filename_day not in z.namelist():
            raise ValueError('Requested operating day absent from monthly archive')
        item=z.getinfo(filename_day)
        if item.file_size>64*1024*1024:
            raise ValueError('Archive member too large')
        return z.read(filename_day),source


def add_coverage(frag,metric,status,reason,urls):
    frag['coverage'].append(dict(region=frag['region'],metric=metric,status=status,reason=reason,sourceUrls=urls))


def collect(start_date,end_date,cache_dir,refresh=False):
    requested=list(days(start_date,end_date));root=Path(cache_dir)/'northeast'
    isone=empty_fragment('ISO-NE');nyiso=empty_fragment('NYISO');seen={}
    def source(frag,s):
        if s['id'] not in seen:
            frag['sources'].append(s);seen[s['id']]=s
    def iso_day(day):
        ymd=day.strftime('%Y%m%d')
        p,ps=cached(f'{ISO_BASE}/rt-lmp/lmp_rt_prelim_{ymd}.csv','isone-rt-hour-'+ymd,root,'ISO New England','실시간 시간당 LMP 성분 · '+day.isoformat(),refresh)
        m,ms=cached(f'{ISO_BASE}/da-lmp/WW_DALMP_ISO_{ymd}.csv','isone-da-map-'+ymd,root,'ISO New England','같은 날 공식 가격노드 분류 · '+day.isoformat(),refresh)
        diagnostics=[]
        return isone_prices(p,m,day,[ps['id'],ms['id']],diagnostics),[ps,ms],diagnostics
    failures=[];diagnostics=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        jobs={pool.submit(iso_day,d):d for d in requested}
        for job in concurrent.futures.as_completed(jobs):
            day=jobs[job]
            try:
                points,sources,day_diagnostics=job.result();diagnostics.extend(day_diagnostics);isone['priceIntervals'].extend(points)
                for s in sources:source(isone,s)
            except Exception as e:
                failures.append(day.isoformat()+': '+str(e))
    isone['priceIntervals'].sort(key=lambda p:(p['start'],p['population']))
    expected_hours=sum(int((datetime.combine(d+timedelta(days=1),datetime.min.time()).replace(tzinfo=EASTERN).astimezone(timezone.utc)-datetime.combine(d,datetime.min.time()).replace(tzinfo=EASTERN).astimezone(timezone.utc)).total_seconds()/3600) for d in requested)
    add_coverage(isone,'price_spread','observed' if not failures and not diagnostics and len(isone['priceIntervals'])==2*expected_hours else 'partial' if isone['priceIntervals'] else 'access_blocked',
                 f'{len(isone["priceIntervals"])}/{2*expected_hours}개 시간·모집단 관측. RT Congestion만 사용하고 NETWORK NODE와 LOAD ZONE을 분리. '+ '; '.join(sorted(failures)[:3]+sorted(diagnostics)[:3]),[ISO_BASE+'/rt-lmp/',ISO_BASE+'/da-lmp/'])
    add_coverage(isone,'binding_duration','auth_required','공식 5분 제약 API는 등록 계정 인증이 필요합니다. 가격차로 제약시간을 역산하지 않습니다.', ['https://webservices.iso-ne.com/api/v1.1/fiveminuteconstraints/final/day/'+requested[-1].strftime('%Y%m%d')])
    add_coverage(isone,'load','unavailable','동일 기간의 실제 시간당 공급량 원자료 미연결. 순간 부하·예측값으로 전국 가중치를 만들지 않습니다.', ['https://webservices.iso-ne.com/api/v1.1/realtimehourlydemand/day/'+requested[-1].strftime('%Y%m%d')+'/location/4000'])
    for metric in ['utilization','curtailment']:
        add_coverage(isone,metric,'unavailable','동일 기간의 방향별 흐름/운전한도 또는 송전 원인 출력제한 에너지 공개 원자료 미연결.', ['https://www.iso-ne.com/isoexpress/'])
    isone['notes']=['시간당 노드별 혼잡성분의 공간 P90−P10. 전체 LMP·손실을 섞지 않습니다. 노드/구역 분위수는 별도 계열이며 전국 합산하지 않습니다.', '공식 RT preliminary 자료입니다. 동일 원문 시각·SHA를 보존하며 이후 정산 수정값과 구분합니다.']
    ny_errors={};ok_days={}; blocked=False
    parsers=[('price_spread','rtlbmp','rtlbmp_zone',nyiso_prices,'priceIntervals'),('load','palIntegrated','palIntegrated',nyiso_load,'loadIntervals'),('binding_duration','LimitingConstraints','LimitingConstraints',nyiso_constraints,'constraintIntervals'),('utilization','ExternalLimitsFlows','ExternalLimitsFlows',nyiso_flows,'utilizationIntervals')]
    for metric,dataset,filename,parse,outfield in parsers:
        errors=[];successful=[]
        for day in requested:
            if blocked:
                errors.append('이 실행환경에서 mis.nyiso.com 공식 호스트 접근 차단');break
            try:
                raw,s=ny_fetch(dataset,filename,day,root,refresh);rows=parse(raw,day,s['id']);source(nyiso,s);nyiso[outfield].extend(rows);successful.append(day)
                if metric=='binding_duration':
                    local_start=datetime.combine(day,datetime.min.time()).replace(tzinfo=EASTERN)
                    local_end=datetime.combine(day+timedelta(days=1),datetime.min.time()).replace(tzinfo=EASTERN)
                    expected=int((local_end.astimezone(timezone.utc)-local_start.astimezone(timezone.utc)).total_seconds()/3600)
                    prices=[p for p in nyiso['priceIntervals'] if p['start']>=iso(local_start) and p['end']<=iso(local_end)]
                    if day<datetime.now(EASTERN).date() and len(prices)==expected:
                        nyiso['constraintWindows'].append(dict(region='NYISO',start=iso(local_start),end=iso(local_end),sourceIds=[s['id']]))
            except Exception as e:
                errors.append(day.isoformat()+': '+str(e))
                if 'Tunnel connection failed' in str(e) or '[Errno 1] Operation not permitted' in str(e):
                    blocked=True
        ny_errors[metric]=errors;ok_days[metric]=successful
        add_coverage(nyiso,metric,'observed' if not errors else 'partial' if successful else 'access_blocked',
                     f'확보 {len(successful)}/{len(requested)}일. '+'; '.join(errors[:2]),[f'{NY_BASE}/{dataset}/'])
    add_coverage(nyiso,'curtailment','unavailable','송전 원인만 분리한 실제 출력제한 MWh 원자료 미연결. 경제성 감발·계획 출력과 합치지 않습니다.', ['https://www.nyiso.com/energy-market-operational-data'])
    nyiso['notes']=['시간당 실시간11개부하구역 혼잡성분만 사용. 원문 MCC 부호는 가산가격 성분으로 반전; 분위수 차이는 동일합니다.', '제약 이벤트는 시설+contingency별 보존. 동일 시각 여러 contingency를 시설 이용시간으로 단순 합산하지 않습니다.', '외부 연계구간 한도/흐름은 내부 송전망 전체 이용률을 뜻하지 않습니다. 전국 평균과 분리합니다.']
    for fragment in [isone,nyiso]:
        fragment['sources'].sort(key=lambda s:s['id'])
    return [isone,nyiso]


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--start',required=True);p.add_argument('--end',required=True)
    p.add_argument('--cache-dir',type=Path,default=Path('.local/transmission'));p.add_argument('--output',type=Path);p.add_argument('--refresh',action='store_true');a=p.parse_args()
    result=collect(a.start,a.end,a.cache_dir,a.refresh)
    if a.output:
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps([dict(region=f['region'],prices=len(f['priceIntervals']),constraints=len(f['constraintIntervals']),loads=len(f['loadIntervals']),coverage=f['coverage']) for f in result],ensure_ascii=False))
