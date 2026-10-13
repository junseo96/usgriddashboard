"""Public NYISO / ISO-NE operational congestion evidence, without credentials.

ISO-NE: hourly RT Congestion component, SAME-DAY DA location metadata and final
five-minute binding reports. System reserve requirements remain excluded.
NYISO: hourly RT zonal congestion, 5-minute limiting constraints, integrated hourly
load and internal/external-interface directional flow/limit snapshots.
No LMP spread substitution. NYISO closed-day event windows require a complete
accompanying hourly price day; ISO-NE windows require a published final report.
"""
from __future__ import annotations
import argparse
import concurrent.futures
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import html
import http.cookiejar
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
ISO_CONSTRAINT_PAGE = 'https://www.iso-ne.com/isoexpress/web/reports/grid/-/tree/constraint-rt-fivemin-final'


def days(start, end):
    cursor, last = date.fromisoformat(str(start)), date.fromisoformat(str(end))
    if cursor > last or (last-cursor).days > 370:
        raise ValueError('Expected inclusive dates within a one-year collection window')
    while cursor <= last:
        yield cursor
        cursor += timedelta(days=1)


def cached(url, key, root, publisher, title, refresh=False, opener=None):
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    rawpath, metapath = root / (key + '.raw'), root / (key + '.json')
    if not refresh and rawpath.exists() and metapath.exists():
        raw, meta = rawpath.read_bytes(), json.loads(metapath.read_text())
        if meta.get('url') != url or hashlib.sha256(raw).hexdigest() != meta.get('sha256'):
            raise ValueError('Cached source hash / URL mismatch: ' + key)
    else:
        open_url = opener.open if opener is not None else urllib.request.urlopen
        with open_url(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (GridAtlas public-data research)'}), timeout=35) as response:
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


def isone_final_available(page):
    """Only final dates actually linked on the public report page are published."""
    text = html.unescape(page.decode('utf-8'))
    dates = re.findall(r'fiveminconstraints\?type=final&start=(\d{8})&end=\1', text)
    if not dates:
        raise ValueError('Official final report page has no published daily CSV dates')
    return max(datetime.strptime(value, '%Y%m%d').date() for value in dates)


def isone_constraints(raw, day, source_ids, diagnostics=None):
    """Final sparse event report; official interval field is a five-minute START.

    The same export also contains reserve requirement prices (e.g.
    SYSTEM_10MINSYNC). Those are not physical transmission constraints.
    """
    text = raw.decode('utf-8-sig')
    if 'Real-Time Five Minute Binding Constraints Report, final version' not in text:
        raise ValueError('Expected final ISO-NE five-minute constraint report')
    if f'Report for: {day:%m/%d/%Y} - {day:%m/%d/%Y}' not in text:
        raise ValueError('Final constraint report date mismatch')
    data = csv_report(raw, {'Date','Hour Ending','Marginal Value Interval','Constraint Name','Marginal Value'})
    result = []; reserve = set()
    for row in data:
        if datetime.strptime(row['Date'], '%m/%d/%Y').date() != day:
            raise ValueError('Constraint row date mismatch')
        when = datetime.strptime(row['Marginal Value Interval'], '%H:%M:%S').time()
        if when.minute % 5 or when.second:
            raise ValueError('Constraint interval is not aligned to five minutes')
        hour_start, _ = hour_ending(day, row['Hour Ending'])
        start = datetime.fromisoformat(hour_start.replace('Z','+00:00')) + timedelta(minutes=when.minute)
        if start.astimezone(EASTERN).hour != when.hour:
            raise ValueError('Constraint interval disagrees with source hour ending')
        asset = row['Constraint Name'].strip()
        if not asset:
            raise ValueError('Missing constraint identity')
        value = number(row['Marginal Value'])
        if asset.startswith('SYSTEM_') or re.search(r'(?:10|30)MIN', asset):
            reserve.add(asset); continue
        result.append(dict(region='ISO-NE',start=iso(start),end=iso(start+timedelta(minutes=5)),
                           assetId=asset,contingency='',binding=abs(value)>0,sourceIds=source_ids))
    if reserve and diagnostics is not None:
        diagnostics.append('비송전 예비력 요건 제외: '+', '.join(sorted(reserve)))
    return result


def isone_constraint_window(day, latest_final, source_ids):
    if day > latest_final:
        raise ValueError('Final constraint report is not yet published for this day')
    start = datetime.combine(day,datetime.min.time()).replace(tzinfo=EASTERN)
    end = datetime.combine(day+timedelta(days=1),datetime.min.time()).replace(tzinfo=EASTERN)
    return dict(region='ISO-NE',start=iso(start),end=iso(end),sourceIds=source_ids)


def plain_csv(raw, required):
    reader = csv.DictReader(io.StringIO(raw.decode('utf-8-sig')))
    if not reader.fieldnames or not required <= set(reader.fieldnames):
        raise ValueError('Unrecognized NYISO CSV header: '+str(reader.fieldnames))
    return list(reader)


def ny_timestamp(row):
    raw = row.get('Time Stamp', row.get('Timestamp', '')).strip()
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
    dispatch_times=sorted(set(ny_timestamp(row) for row in data))
    next_dispatch={left:right for left,right in zip(dispatch_times,dispatch_times[1:])}
    result = []
    for row in data:
        start = ny_timestamp(row)
        if start.astimezone(EASTERN).date() != day:
            raise ValueError('Constraint report date mismatch')
        value = number(row['Constraint Cost($)'])
        if not row['Limiting Facility'].strip():
            raise ValueError('Limiting facility identity missing')
        end=min(start+timedelta(minutes=5),next_dispatch.get(start,start+timedelta(minutes=5)))
        result.append(dict(region='NYISO',start=iso(start),end=iso(end),
                           assetId=row['Facility PTID'].strip()+' · '+row['Limiting Facility'].strip(),
                           contingency=row['Contingency'].strip(),binding=abs(value)>0,sourceIds=[source_id]))
    return result


def nyiso_flows(raw, day, source_id, diagnostics=None):
    data = plain_csv(raw, {'Interface Name','Flow (MWH)','Positive Limit (MWH)','Negative Limit (MWH)'})
    result=[];groups={};conflicts=0;excluded_limits=0;scheduled=0
    for r in data:
        start=ny_timestamp(r)
        if start.astimezone(EASTERN).date()!=day:
            raise ValueError('Interface report date mismatch')
        asset=r['Interface Name'].strip()
        if not asset:
            raise ValueError('Interface identity missing')
        # SCH-labelled external interchange schedules are not established
        # physical flow observations. Never display their schedule/limit ratio
        # as transmission utilization; retain the complete original CSV only.
        if re.match(r'^SCH(?:\s|[-_])',asset,re.IGNORECASE):
            scheduled+=1;continue
        values=(number(r['Flow (MWH)']),number(r['Positive Limit (MWH)']),number(r['Negative Limit (MWH)']))
        groups.setdefault((start,asset),set()).add(values)
    for (start,asset),observations in sorted(groups.items()):
        if len(observations)!=1:
            conflicts+=1;continue
        flow,positive,negative=next(iter(observations));limit=positive if flow>=0 else negative
        if limit==0 or abs(limit)==9999:
            excluded_limits+=1
            continue
        if (flow>=0 and limit<0) or (flow<0 and limit>0):
            raise ValueError('Directional interface limit has incompatible sign')
        # Source timestamps identify dispatch snapshots, not interval-average
        # energy. A 1s envelope is storage only; consumers must use sample means
        # with observedHours=0, never interpret this as a duration observation.
        result.append(dict(region='NYISO',start=iso(start),end=iso(start+timedelta(seconds=1)),assetId=asset,
                           contingency='',flowMw=flow,limitMw=abs(limit),value=abs(flow)/abs(limit)*100,
                           intervalNature='instantaneous',sampleObservedAt=iso(start),
                           sourceUnit='MWH (as published; ratio only)',directionalBasis='NYISO 보고 인터페이스 흐름/같은 방향 보고 한도 비율 표본. 원문 MWH 표기 보존. SCH 계열 제외; 개별 선로 실측·telemetry 또는 열정격 이용률로 확인되지 않음.',sourceIds=[source_id]))
    if diagnostics is not None and (conflicts or excluded_limits or scheduled):
        diagnostics.append(f'{day.isoformat()}: SCH 계열 {scheduled}개 원문행, 동일 시각 값 충돌 {conflicts}개 시설·시각, 0/±9999 한도 {excluded_limits}개 표본 제외.')
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
    # The public report CSV uses ordinary anonymous session cookies from its
    # landing page. No account or bulk-download CAPTCHA submission is needed.
    binding_failures=[]; binding_diagnostics=[]; latest_final=None
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    try:
        try:
            page,page_source=cached(ISO_CONSTRAINT_PAGE,'isone-final-binding-page',root,'ISO New England','Final 5분 제약 보고서 · 간격 정의와 게시일',True,opener)
        except (urllib.error.URLError,TimeoutError):
            page,page_source=cached(ISO_CONSTRAINT_PAGE,'isone-final-binding-page',root,'ISO New England','Final 5분 제약 보고서 · 간격 정의와 게시일',False,opener)
        latest_final=isone_final_available(page);source(isone,page_source)
        for day in requested:
            if day>latest_final:
                binding_failures.append(day.isoformat()+': final 미게시');continue
            ymd=day.strftime('%Y%m%d')
            url=f'https://www.iso-ne.com/transform/csv/fiveminconstraints?type=final&start={ymd}&end={ymd}'
            try:
                raw,s=cached(url,'isone-final-constraint-'+ymd,root,'ISO New England','Final 실시간 5분 송전 제약 · '+day.isoformat(),refresh,opener)
                refs=[s['id'],page_source['id']]
                events=isone_constraints(raw,day,refs,binding_diagnostics)
                window=isone_constraint_window(day,latest_final,refs)
                source(isone,s);isone['constraintIntervals'].extend(events);isone['constraintWindows'].append(window)
            except Exception as e:
                binding_failures.append(day.isoformat()+': '+str(e))
    except Exception as e:
        binding_failures.append(str(e))
    add_coverage(isone,'binding_duration','observed' if not binding_failures else 'partial' if isone['constraintWindows'] else 'access_blocked',
                 f'Final 완결 일별 보고서 {len(isone["constraintWindows"])}/{len(requested)}일, 실제 5분 송전 제약 {len(isone["constraintIntervals"])}행. '+
                 ('최신 final '+latest_final.isoformat()+'. ' if latest_final else '')+
                 '음/양 marginal value의 절댓값이 0 초과인 제약을 사용하며 SYSTEM·10/30분 예비력 요건은 제외. 미게시일은 0으로 채우지 않음. '+
                 '; '.join(binding_failures[:3]),[ISO_CONSTRAINT_PAGE])
    add_coverage(isone,'load','unavailable','동일 기간의 실제 시간당 공급량 원자료 미연결. 순간 부하·예측값으로 전국 가중치를 만들지 않습니다.', ['https://webservices.iso-ne.com/api/v1.1/realtimehourlydemand/day/'+requested[-1].strftime('%Y%m%d')+'/location/4000'])
    for metric in ['utilization','curtailment']:
        add_coverage(isone,metric,'unavailable','동일 기간의 방향별 흐름/운전한도 또는 송전 원인 출력제한 에너지 공개 원자료 미연결.', ['https://www.iso-ne.com/isoexpress/'])
    isone['notes']=['시간당 노드별 혼잡성분의 공간 P90−P10. 전체 LMP·손실을 섞지 않습니다. 노드/구역 분위수는 별도 계열이며 전국 합산하지 않습니다.', '가격은 공식 RT preliminary, 제약은 공식 RT final 자료입니다. 동일 원문 시각·SHA를 보존하며 이후 정산 수정값과 구분합니다.', '5분 제약은 공식 보고서가 지정한 시작시각과 원문 Constraint Name을 보존합니다. 원문에는 별도 contingency 필드가 없어 이름에서 임의 분리하지 않습니다. Final 완결 보고서의 전체 운영일만 관측 시간 분모에 포함합니다.']+sorted(set(binding_diagnostics))
    ny_errors={};ok_days={}; blocked=False;flow_diagnostics=[]
    parsers=[('price_spread','rtlbmp','rtlbmp_zone',nyiso_prices,'priceIntervals'),('load','palIntegrated','palIntegrated',nyiso_load,'loadIntervals'),('binding_duration','LimitingConstraints','LimitingConstraints',nyiso_constraints,'constraintIntervals'),('utilization','ExternalLimitsFlows','ExternalLimitsFlows',nyiso_flows,'utilizationIntervals')]
    for metric,dataset,filename,parse,outfield in parsers:
        errors=[];successful=[]
        for day in requested:
            if blocked:
                errors.append('이 실행환경에서 mis.nyiso.com 공식 호스트 접근 차단');break
            try:
                raw,s=ny_fetch(dataset,filename,day,root,refresh)
                rows=parse(raw,day,s['id'],flow_diagnostics) if metric=='utilization' else parse(raw,day,s['id'])
                source(nyiso,s);nyiso[outfield].extend(rows);successful.append(day)
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
        status='observed' if not errors else 'partial' if successful else 'access_blocked'
        if metric=='utilization' and flow_diagnostics and successful:status='partial'
        add_coverage(nyiso,metric,status,
                     f'확보 {len(successful)}/{len(requested)}일. '+('SCH 스케줄 계열 제외. NYISO 보고 인터페이스 흐름/같은 방향 보고 한도 비율 표본이며 시간평균·개별 선로 실측 이용률이 아님. ' if metric=='utilization' else '')+'; '.join(errors[:2]),[f'{NY_BASE}/{dataset}/'])
    add_coverage(nyiso,'curtailment','unavailable','송전 원인만 분리한 실제 출력제한 MWh 원자료 미연결. 경제성 감발·계획 출력과 합치지 않습니다.', ['https://www.nyiso.com/energy-market-operational-data'])
    nyiso['notes']=['시간당 실시간11개부하구역 혼잡성분만 사용. 원문 MCC 부호는 가산가격 성분으로 반전; 분위수 차이는 동일합니다.', '제약 이벤트는 시설+contingency별 보존. 동일 시각 여러 contingency를 시설 이용시간으로 단순 합산하지 않습니다. 5분 dispatch 구간보다 이른 다음 보고 dispatch 시각이 있으면 해당 시각에서 끝냅니다.', 'SCH 스케줄 계열은 물리적 흐름으로 확인되지 않아 비율 지표에서 전부 제외하며 원문만 보존합니다. 남은 인터페이스도 NYISO 보고 흐름/방향별 보고 한도의 같은 시각 비율이며 개별 송전선 실측·telemetry·열정격 이용률이 아닙니다. 전국 평균과 분리하고 1초 저장 구간은 실제 지속시간이 아닙니다.']+flow_diagnostics
    for fragment in [isone,nyiso]:
        fragment['sources'].sort(key=lambda s:s['id'])
    return [isone,nyiso]


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--start',required=True);p.add_argument('--end',required=True)
    p.add_argument('--cache-dir',type=Path,default=Path('.local/transmission'));p.add_argument('--output',type=Path);p.add_argument('--refresh',action='store_true');a=p.parse_args()
    result=collect(a.start,a.end,a.cache_dir,a.refresh)
    if a.output:
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n')
    print(json.dumps([dict(region=f['region'],prices=len(f['priceIntervals']),constraints=len(f['constraintIntervals']),loads=len(f['loadIntervals']),coverage=f['coverage']) for f in result],ensure_ascii=False))
