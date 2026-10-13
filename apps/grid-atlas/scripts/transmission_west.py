"""Official CAISO OASIS / renewables and ERCOT public MIS operational data.

No credentials or access-control workarounds. ERCOT's rolling public archive is
not a 30-day archive: absent days stay absent. SCED prices are effective until
the next published SCED timestamp (Protocol 6.6.1.1 TLMP, seconds), not fixed
five-minute samples. Electrical-bus uncapped LMP minus uncapped system lambda
keeps VOLL caps and reliability adders out of the congestion price comparison.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from zoneinfo import ZoneInfo

from transmission_common import empty_fragment, hourly_price_spreads, iso, number, stamp

UTC = timezone.utc
LA = ZoneInfo('America/Los_Angeles')
TX = ZoneInfo('America/Chicago')
OASIS = 'https://oasis.caiso.com/oasisapi/SingleZip?'
MIS = 'https://www.ercot.com/misapp/servlets/IceDocListJsonWS?reportTypeId='
DOWNLOAD = 'https://www.ercot.com/misdownload/servlets/mirDownload?doclookupId='
PROTOCOL = 'https://www.ercot.com/files/docs/2024/06/28/06-082826_Nodal.docx'
ZONES = ('DLAP_PGAE-APND', 'DLAP_SCE-APND', 'DLAP_SDGE-APND')


def day(value):
    return date.fromisoformat(value) if isinstance(value, str) else value


def bounds(start, end, zone):
    return (datetime.combine(day(start), datetime.min.time(), zone).astimezone(UTC),
            datetime.combine(day(end) + timedelta(days=1), datetime.min.time(), zone).astimezone(UTC))


def fetch(url, cache_dir, refresh=False):
    folder = Path(cache_dir) / 'west' / 'history'
    folder.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()
    path, meta_path = folder / (key + '.raw'), folder / (key + '.json')

    def archive_version(blob, metadata):
        archive = folder / 'by-sha256'
        archive.mkdir(exist_ok=True)
        archived = archive / (metadata['sha256'] + '.raw')
        if not archived.exists():
            archived.write_bytes(blob)
            archived.with_suffix('.json').write_text(json.dumps(metadata))

    if path.exists() and meta_path.exists() and not refresh:
        raw, meta = path.read_bytes(), json.loads(meta_path.read_text())
        if meta['url'] != url or meta['sha256'] != hashlib.sha256(raw).hexdigest():
            raise ValueError('Source cache integrity mismatch')
        archive_version(raw, meta)
        return raw, meta
    if path.exists() and meta_path.exists():
        old_raw, old_meta = path.read_bytes(), json.loads(meta_path.read_text())
        if old_meta['sha256'] != hashlib.sha256(old_raw).hexdigest():
            raise ValueError('Cannot refresh a corrupt source cache')
        archive_version(old_raw, old_meta)
    request = urllib.request.Request(url, headers={'User-Agent': 'GridAtlas/1.0 official-public-market-data'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=150) as response:
                raw = response.read(24_000_001)
                if len(raw) > 24_000_000:
                    raise ValueError('Public source exceeds 24 MB acquisition limit')
                if urllib.parse.urlparse(response.url).hostname != urllib.parse.urlparse(url).hostname:
                    raise ValueError('Unexpected source host redirect')
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
            time.sleep(2 ** (attempt + 1))
    meta = dict(url=url, retrievedAt=iso(datetime.now(UTC)), sha256=hashlib.sha256(raw).hexdigest())
    archive_version(raw, meta)
    path.write_bytes(raw)
    meta_path.write_text(json.dumps(meta))
    return raw, meta


def source(meta, title, publisher, source_day=None):
    result = dict(meta, id='west-' + hashlib.sha256(meta['url'].encode()).hexdigest()[:20],
                  title=title, publisher=publisher)
    if source_day:
        result['sourceAsOf'] = str(source_day)
    return result


def zip_csv(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        names = [name for name in archive.namelist() if name.lower().endswith('.csv')]
        if not names:
            raise ValueError('Official response has no CSV (possibly OASIS error/no data)')
        for name in names:
            if archive.getinfo(name).file_size > 100_000_000:
                raise ValueError('CSV exceeds parser bound')
            with archive.open(name) as handle:
                yield from csv.DictReader(io.TextIOWrapper(handle, encoding='utf-8-sig'))


def oasis_url(query, start, end, **parameters):
    params = dict(queryname=query, startdatetime=start.strftime('%Y%m%dT%H:%M-0000'),
                  enddatetime=end.strftime('%Y%m%dT%H:%M-0000'), version='1', resultformat='6')
    params.update(parameters)
    return OASIS + urllib.parse.urlencode(params)


def parse_caiso_mcc(raw, source_id, start, end):
    result = []
    for row in zip_csv(raw):
        if row['LMP_TYPE'] != 'MCC' or row['NODE'] not in ZONES:
            continue
        begin, finish = stamp(row['INTERVALSTARTTIME_GMT']), stamp(row['INTERVALENDTIME_GMT'])
        if start <= begin < finish <= end:
            if finish - begin != timedelta(minutes=5) or row['MARKET_RUN_ID'] != 'RTM':
                raise ValueError('Unexpected CAISO MCC market or interval')
            result.append(dict(start=iso(begin), end=iso(finish), node=row['NODE'],
                               value=number(row['VALUE']), sourceIds=[source_id]))
    return hourly_price_spreads(result, 'CAISO', 'real_time', 'load_zones',
                                'CAISO PG&E·SCE·SDG&E 3개 DLAP · 전 노드 아님')


def parse_caiso_load(raw, source_id, start, end):
    result, seen = [], set()
    for row in zip_csv(raw):
        if row['TAC_AREA_NAME'] != 'CA ISO-TAC' or row['MARKET_RUN_ID'] != 'ACTUAL':
            continue
        if row['LABEL'] != 'Total Actual Hourly Integrated Load':
            raise ValueError('CAISO actual integrated-load definition changed')
        begin, finish = stamp(row['INTERVALSTARTTIME_GMT']), stamp(row['INTERVALENDTIME_GMT'])
        if start <= begin < finish <= end:
            if finish - begin != timedelta(hours=1) or begin in seen:
                raise ValueError('Duplicate/nonhourly CAISO actual integrated load')
            seen.add(begin)
            result.append(dict(region='CAISO', start=iso(begin), end=iso(finish),
                               mw=number(row['MW']), sourceIds=[source_id]))
    return result


def parse_caiso_binding(raw, source_id, start, end):
    result, seen = [], set()
    for row in zip_csv(raw):
        begin, finish = stamp(row['INTERVALSTARTTIME_GMT']), stamp(row['INTERVALENDTIME_GMT'])
        if not start <= begin < finish <= end:
            continue
        if row['MARKET_RUN_ID'] != 'RTM' or finish - begin != timedelta(minutes=5):
            raise ValueError('Unexpected CAISO binding market or interval')
        asset = row.get('NOMOGRAM_ID') or row.get('TI_ID')
        contingency = row.get('CONSTRAINT_CAUSE') or None
        key = (begin, finish, asset, contingency)
        if key in seen:
            continue  # OASIS GROUP repeats the same modeled constraint.
        seen.add(key)
        result.append(dict(region='CAISO', start=iso(begin), end=iso(finish), assetId=asset,
                           contingency=contingency, binding=abs(number(row['PRC'])) > 0,
                           marketScope='CAISO-operated RTM including WEIM; not CAISO internal branches only',
                           sourceIds=[source_id]))
    return result


def parse_caiso_curtailment(raw, operating_day, source_id):
    text = raw.decode('utf-8')
    title = re.search(r'Daily Renewable Report\s*-\s*([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})', text)
    if not title or datetime.strptime(title.group(1), '%b %d, %Y').date() != day(operating_day):
        raise ValueError('CAISO curtailment report operating date mismatch')
    if 'mitigate local congestion' not in text:
        raise ValueError('CAISO Local curtailment cause definition missing')
    arrays = []
    for fuel in ('solar', 'wind'):
        for cause in ('econ', 'ss', 'oi'):
            name = f'curt_hr_tot_{fuel}_{cause}_local_mwh'
            match = re.search(r'\b' + name + r'\s*=\s*(\[[^\]]*\])', text)
            if not match:
                raise ValueError('Missing hourly local curtailment energy array')
            arrays.append(json.loads(match.group(1)))
    start, end = bounds(operating_day, operating_day, LA)
    hours = int((end - start).total_seconds() / 3600)
    if any(len(values) != hours for values in arrays):
        raise ValueError('Curtailment hour count does not match local operating day (including DST)')
    result = []
    for hour in range(hours):
        values = [values[hour] for values in arrays]
        if any(value is None or str(value) in ('NA', 'N/A', '') for value in values):
            continue
        values = [number(value) for value in values]
        if any(value < 0 for value in values):
            raise ValueError('Negative curtailment energy')
        begin = start + timedelta(hours=hour)
        result.append(dict(region='CAISO', start=iso(begin), end=iso(begin + timedelta(hours=1)),
                           mwh=sum(values), reason='Local congestion: Economic + SelfSchCut + Operator Instruction, solar + wind; System excluded',
                           sourceIds=[source_id]))
    return result


def ercot_stamp(value, repeated='N'):
    naive = datetime.strptime(value.strip(), '%m/%d/%Y %H:%M:%S')
    first, second = naive.replace(tzinfo=TX, fold=0), naive.replace(tzinfo=TX, fold=1)
    if repeated not in ('N', 'Y'):
        raise ValueError('Unknown ERCOT repeated-hour flag')
    local = second if repeated == 'Y' else first
    result = local.astimezone(UTC)
    if result.astimezone(TX).replace(tzinfo=None) != naive:
        raise ValueError('Nonexistent ERCOT local timestamp')
    if repeated == 'Y' and first.utcoffset() == second.utcoffset():
        raise ValueError('Repeated-hour flag outside repeated hour')
    return result


def ercot_documents(raw):
    documents = [item['Document'] for item in json.loads(raw)['ListDocsByRptTypeRes']['DocumentList']]
    return [doc for doc in documents if doc.get('SecurityStatus') == 'P'
            and doc.get('Extension') == 'zip' and '_csv' in doc['ConstructedName']]


def document_sced(doc):
    match = re.search(r'_(\d{8})_(\d{6})_csv', doc['ConstructedName'])
    if not match:
        raise ValueError('Missing exact SCED timestamp in filename')
    naive = datetime.strptime(''.join(match.groups()), '%Y%m%d%H%M%S')
    # Filename cannot identify the repeated hour; publication offset can.
    offset = datetime.fromisoformat(doc['PublishDate']).utcoffset()
    for fold in (0, 1):
        candidate = naive.replace(tzinfo=TX, fold=fold)
        if candidate.utcoffset() == offset:
            return candidate.astimezone(UTC)
    raise ValueError('SCED filename/publication time offset mismatch')


def parse_ercot_lambda(raw, expected):
    rows = list(zip_csv(raw))
    if len(rows) != 1:
        raise ValueError('SCED system lambda must contain exactly one interval')
    row = rows[0]
    when = ercot_stamp(row['SCEDTimeStamp'], row['RepeatedHourFlag'])
    if when != expected:
        raise ValueError('SCED lambda filename/data timestamp mismatch')
    return number(row['UncappedSystemLambda'])


def parse_ercot_bus(raw, expected, system_lambda):
    result, validated_stamps = {}, set()
    for row in zip_csv(raw):
        time_key = (row['SCEDTimestamp'], row['RepeatedHourFlag'])
        if time_key not in validated_stamps:
            when = ercot_stamp(*time_key)
            if when != expected:
                raise ValueError('SCED electrical bus/lambda timestamp mismatch')
            validated_stamps.add(time_key)
        node = row['ElectricalBus']
        if not node or node in result:
            raise ValueError('Duplicate/missing ERCOT electrical bus')
        result[node] = number(row['UncappedLMP']) - system_lambda
    if len(result) < 2:
        raise ValueError('No comparable ERCOT electrical bus pool')
    return result


def sced_hourly_spreads(intervals):
    """Stream (start,end,{bus:signedMCC},sources), bounded to two hour buckets.

    Explicit seconds of effectiveness are accumulated for each bus. A missing
    price/node/gap cannot turn into a complete hour or an implicit zero.
    """
    buckets = defaultdict(dict)
    refs = defaultdict(set)
    result = []

    def flush(hour):
        full = []
        for node, (seconds, integral, first, last) in buckets.pop(hour).items():
            if seconds == 3600 and first == hour and last == hour + timedelta(hours=1):
                full.append(dict(start=iso(hour), end=iso(hour + timedelta(hours=1)), node=node,
                                 value=integral / seconds, sourceIds=sorted(refs[hour])))
        refs.pop(hour, None)
        observations = hourly_price_spreads(full, 'ERCOT', 'real_time', 'electrical_buses',
                                             'ERCOT 공개 Electrical Bus 전체 풀 · 무상한 LMP−무상한 System Lambda')
        for observation in observations:
            observation['candidateNodeCount'] = candidate_count
        result.extend(observations)

    last_end = None
    for start, end, values, sources in intervals:
        if end <= start or end - start > timedelta(minutes=10):
            raise ValueError('SCED interval outside conservative 10-minute continuity bound')
        if last_end is not None and start < last_end:
            raise ValueError('Overlapping SCED effective intervals')
        last_end = end
        for hour in sorted(list(buckets)):
            if hour + timedelta(hours=1) <= start:
                candidate_count = len(buckets[hour])
                flush(hour)
        cursor = start
        while cursor < end:
            hour = cursor.replace(minute=0, second=0, microsecond=0)
            finish = min(end, hour + timedelta(hours=1))
            seconds = (finish - cursor).total_seconds()
            refs[hour].update(sources)
            for node, value in values.items():
                old = buckets[hour].get(node)
                if old and old[3] != cursor:
                    # Node missing in any intervening interval: retain a gap.
                    old = (old[0], old[1], old[2], old[3])
                if old:
                    buckets[hour][node] = (old[0] + seconds, old[1] + number(value) * seconds, old[2], finish)
                else:
                    buckets[hour][node] = (seconds, number(value) * seconds, cursor, finish)
            cursor = finish
    for hour in sorted(list(buckets)):
        candidate_count = len(buckets[hour])
        flush(hour)
    return result


def parse_ercot_load(raw, source_id, start, end):
    result = []
    for row in zip_csv(raw):
        operating_day = datetime.strptime(row['DeliveryDate'], '%m/%d/%Y').date()
        hour, minute = map(int, row['TimeEnding'].split(':'))
        if minute not in (0, 15, 30, 45) or not 0 <= hour <= 24 or (hour == 24 and minute):
            raise ValueError('Unexpected ERCOT demand quarter-hour')
        if hour == 24:
            operating_day += timedelta(days=1)
            hour = 0
        finish = ercot_stamp(f'{operating_day:%m/%d/%Y} {hour:02d}:{minute:02d}:00', row['DSTFlag'])
        begin = finish - timedelta(minutes=15)
        if start <= begin < finish <= end:
            result.append(dict(region='ERCOT', start=iso(begin), end=iso(finish), mw=number(row['Demand']), sourceIds=[source_id]))
    return result


def parse_ercot_constraints(raw, source_id):
    result = []
    for row in zip_csv(raw):
        when = ercot_stamp(row['SCEDTimeStamp'], row['RepeatedHourFlag'])
        result.append(dict(when=when, assetId=row['ConstraintName'], contingency=row['ContingencyName'] or None,
                           shadow=number(row['ShadowPrice']), flow=number(row['Value']),
                           limit=number(row['Limit']), sourceIds=[source_id]))
    return result


def utilization_percent(flow, limit):
    """Percent of the same positive directed modeled constraint limit."""
    flow, limit = number(flow), number(limit)
    if limit <= 0 or flow < 0:
        return None
    return 100 * flow / limit


def coverage(fragment, metric, reason, urls, complete=False):
    key = dict(price_spread='priceIntervals', binding_duration='constraintIntervals',
               utilization='utilizationIntervals', curtailment='curtailmentIntervals', load='loadIntervals')[metric]
    fragment['coverage'].append(dict(region=fragment['region'], metric=metric,
                                     status=('observed' if complete else 'partial') if fragment[key] else 'unavailable',
                                     reason=reason, sourceUrls=urls))


def collect_caiso(start_date, end_date, cache_dir, refresh=False):
    fragment = empty_fragment('CAISO')
    start, end = bounds(start_date, end_date, LA)
    errors = []
    for query, label, parameters, parser, target in [
        ('PRC_INTVL_LMP', 'Real-time five-minute DLAP marginal congestion components', dict(version='3', market_run_id='RTM', node=','.join(ZONES)), parse_caiso_mcc, 'priceIntervals'),
        ('SLD_FCST', 'Actual hourly integrated load, CA ISO-TAC', dict(market_run_id='ACTUAL'), parse_caiso_load, 'loadIntervals'),
        ('PRC_RTM_NOMOGRAM', 'Real-time five-minute nomogram/branch constraint shadow prices', {}, parse_caiso_binding, 'constraintIntervals'),
    ]:
        # OASIS explicit-node/report queries support at most 31 days. Split at
        # seven days to bound public-service load and preserve useful failures.
        cursor = start
        while cursor < end:
            finish = min(end, cursor + timedelta(days=7))
            url = oasis_url(query, cursor, finish, **parameters)
            try:
                raw, meta = fetch(url, cache_dir, refresh)
                src = source(meta, 'CAISO ' + label, 'California ISO', f'{cursor.date()}/{finish.date()}')
                rows = parser(raw, src['id'], cursor, finish)
                fragment[target].extend(rows)
                fragment['sources'].append(src)
                # Binding feed lists constraints with nonzero shadow prices;
                # successful complete query establishes the event-feed window.
                if target == 'constraintIntervals' and rows:
                    fragment['constraintWindows'].append(dict(region='CAISO', start=iso(cursor), end=iso(finish), sourceIds=[src['id']]))
            except Exception as exc:
                errors.append(f'{query} {cursor.date()}: {type(exc).__name__}: {str(exc)[:150]}')
            cursor = finish
    days = [day(start_date) + timedelta(days=i) for i in range((day(end_date) - day(start_date)).days + 1)]

    def curtailment(operating_day):
        slug = operating_day.strftime('%b-%d-%Y').lower()
        url = f'https://www.caiso.com/documents/daily-renewable-report-{slug}.html'
        for suffix in ('', '-corrected'):
            try:
                current = url.replace('.html', suffix + '.html')
                raw, meta = fetch(current, cache_dir, refresh)
                src = source(meta, 'CAISO Daily Renewables Report — hourly Local curtailment MWh', 'California ISO', operating_day)
                return src, parse_caiso_curtailment(raw, operating_day, src['id']), None
            except Exception as exc:
                error = f'{operating_day}: {type(exc).__name__}: {str(exc)[:100]}'
        return None, [], error

    with ThreadPoolExecutor(max_workers=3) as pool:
        for src, rows, error in pool.map(curtailment, days):
            if src:
                fragment['sources'].append(src)
                fragment['curtailmentIntervals'].extend(rows)
            else:
                errors.append('curtailment ' + error)
    expected_hours = (end - start).total_seconds() / 3600
    coverage(fragment, 'price_spread', '3개 DLAP의 5분 MCC를 노드별 완전한 시간평균으로 만든 뒤 P90−P10. 모든 가격 노드의 공간 분포가 아니며 부하가중도 아님.', [OASIS], len(fragment['priceIntervals']) == expected_hours)
    coverage(fragment, 'load', 'OASIS ACTUAL의 CA ISO-TAC Total Actual Hourly Integrated Load. EIM 타 BAA와 TAC 부분지역은 합산하지 않음.', [OASIS], len(fragment['loadIntervals']) == expected_hours)
    coverage(fragment, 'binding_duration', 'CAISO 운영 RTM 보고 범위(WEIM 포함, CAISO 내부 선로만 아님)의 OASIS nomogram/branch에서 비영(非零) shadow price인 제약의 효력 5분. 소유권/BAA 미제공으로 내부 선로 분리 불가. Intertie 미포함; contingency별 제약쌍이며 CA ISO-TAC 부하와 공간 분모가 다름.', [OASIS])
    coverage(fragment, 'utilization', '해당 OASIS 가격 보고서는 동일 제약쌍의 흐름과 limit을 제공하지 않아 물리 이용률을 생성하지 않음.', [OASIS])
    coverage(fragment, 'curtailment', '공식 일별 보고서의 Local(Economic·SelfSchCut·Operator Instruction) 태양광·풍력 MWh만 합산. System 사유는 제외. 아직 미발행/접근실패인 날짜는 공백.', ['https://www.caiso.com/todays-outlook/supply'], len(fragment['curtailmentIntervals']) == expected_hours)
    fragment['notes'] = ['최신 공개 운영자료는 정산 확정치가 아니며 이후 정정될 수 있습니다.', *errors]
    return fragment


def collect_ercot(start_date, end_date, cache_dir, refresh=False):
    fragment = empty_fragment('ERCOT')
    start, end = bounds(start_date, end_date, TX)
    errors, documents = [], {}
    for report_id in (11485, 13114, 12302, 12340):
        try:
            raw, meta = fetch(MIS + str(report_id), cache_dir, refresh)
            src = source(meta, f'ERCOT public MIS document manifest {report_id}', 'ERCOT')
            fragment['sources'].append(src)
            documents[report_id] = ercot_documents(raw)
        except Exception as exc:
            errors.append(f'MIS {report_id}: {type(exc).__name__}: {str(exc)[:130]}')
            documents[report_id] = []
    try:
        raw, meta = fetch(PROTOCOL, cache_dir, refresh)
        protocol_source = source(meta, 'ERCOT Nodal Protocols §6, effective 2026-08-28; SCED price effectiveness and §6.6.1.1 TLMP seconds', 'ERCOT', '2026-08-28')
        fragment['sources'].append(protocol_source)
    except Exception as exc:
        errors.append(f'Protocol: {type(exc).__name__}: {str(exc)[:130]}')
        protocol_source = None

    bus_docs = {document_sced(doc): doc for doc in documents[11485] if start - timedelta(minutes=10) <= document_sced(doc) <= end + timedelta(minutes=10)}
    lambda_docs = {document_sced(doc): doc for doc in documents[13114] if start - timedelta(minutes=10) <= document_sced(doc) <= end + timedelta(minutes=10)}
    timeline = sorted(set(bus_docs) | set(lambda_docs))
    all_docs = [doc for mapping in (bus_docs, lambda_docs) for doc in mapping.values()]
    # Hourly packet publication can follow the last operating hour. Include the
    # next two hours, then retain only intervals inside requested local days.
    for report in (12302, 12340):
        documents[report] = [doc for doc in documents[report]
                             if start <= stamp(doc['PublishDate']) <= end + timedelta(hours=2)]
        all_docs.extend(documents[report])

    def download(doc):
        try:
            raw, meta = fetch(DOWNLOAD + doc['DocID'], cache_dir, refresh)
            src = source(meta, 'ERCOT ' + doc['ReportName'] + ' — ' + doc['ConstructedName'], 'ERCOT', doc['PublishDate'][:10])
            return doc['DocID'], src, None
        except Exception as exc:
            return doc['DocID'], None, f'{doc["DocID"]}: {type(exc).__name__}: {str(exc)[:100]}'

    acquired = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for doc_id, src, error in pool.map(download, all_docs):
            if src:
                acquired[doc_id] = src
                fragment['sources'].append(src)
            else:
                errors.append(error)

    def cached(doc):
        src = acquired.get(doc['DocID'])
        if not src:
            return None, None
        raw, _ = fetch(src['url'], cache_dir, False)
        return raw, src

    def prices():
        if not protocol_source:
            return
        for begin, finish in zip(timeline, timeline[1:]):
            if finish <= start or begin >= end or finish - begin > timedelta(minutes=10):
                continue
            if begin not in bus_docs or begin not in lambda_docs:
                continue
            bus_raw, bus_source = cached(bus_docs[begin])
            lam_raw, lam_source = cached(lambda_docs[begin])
            if bus_raw is None or lam_raw is None:
                continue
            try:
                lam = parse_ercot_lambda(lam_raw, begin)
                values = parse_ercot_bus(bus_raw, begin, lam)
            except Exception as exc:
                errors.append(f'SCED {begin}: {type(exc).__name__}: {str(exc)[:100]}')
                continue
            yield max(begin, start), min(finish, end), values, [bus_source['id'], lam_source['id'], protocol_source['id']]
    fragment['priceIntervals'] = sced_hourly_spreads(prices())

    for doc in documents[12340]:
        raw, src = cached(doc)
        if raw is None:
            continue
        try:
            fragment['loadIntervals'].extend(parse_ercot_load(raw, src['id'], start, end))
        except Exception as exc:
            errors.append(f'Demand {doc["DocID"]}: {type(exc).__name__}: {str(exc)[:100]}')

    constraint_snapshots = defaultdict(list)
    for doc in documents[12302]:
        raw, src = cached(doc)
        if raw is None:
            continue
        try:
            for row in parse_ercot_constraints(raw, src['id']):
                constraint_snapshots[row['when']].append(row)
        except Exception as exc:
            errors.append(f'Constraints {doc["DocID"]}: {type(exc).__name__}: {str(exc)[:100]}')
    # SCED effective duration is known only between adjacent public SCED runs.
    # A report containing no row at a time is not synthesized into no congestion.
    for begin, finish in zip(timeline, timeline[1:]):
        if finish <= start or begin >= end or finish - begin > timedelta(minutes=10):
            continue
        snapshots = constraint_snapshots.get(begin, [])
        if not snapshots:
            continue
        refs = sorted({ref for row in snapshots for ref in row['sourceIds']})
        fragment['constraintWindows'].append(dict(region='ERCOT', start=iso(max(start, begin)), end=iso(min(end, finish)), sourceIds=refs))
        seen = set()
        for row in snapshots:
            key = (row['assetId'], row['contingency'])
            if key in seen:
                continue
            seen.add(key)
            common = dict(region='ERCOT', start=iso(max(start, begin)), end=iso(min(end, finish)),
                          assetId=row['assetId'], contingency=row['contingency'], sourceIds=row['sourceIds'])
            fragment['constraintIntervals'].append(dict(common, binding=row['shadow'] > 0))
            utilization = utilization_percent(row['flow'], row['limit'])
            if utilization is not None:
                fragment['utilizationIntervals'].append(dict(common, flowMw=row['flow'], limitMw=row['limit'],
                    value=utilization, unit='%', directionalBasis='100 × SCED constraint Value / positive Limit for identical ConstraintName + ContingencyName; directed modeled flow, not branch thermal-rating telemetry'))
    # Files may republish the same quarter-hour; preserve one identical record,
    # fail conflicting intervals instead of double counting load energy.
    loads = {}
    for row in fragment['loadIntervals']:
        key = (row['start'], row['end'])
        if key in loads and loads[key]['mw'] != row['mw']:
            raise ValueError('Conflicting ERCOT demand observations')
        loads[key] = row
    fragment['loadIntervals'] = sorted(loads.values(), key=lambda row: row['start'])
    coverage(fragment, 'price_spread', '공개 MIS 최근 약 5일 전기 버스 전체 풀. 동일 SCED의 UncappedLMP−UncappedSystemLambda를 효력 지속초로 시간평균한 뒤 노드 P90−P10; 노드별 완전한 60분만 포함. 캡·reliability adder·15분 정산가격을 섞지 않음.', [MIS + '11485', MIS + '13114', PROTOCOL])
    coverage(fragment, 'binding_duration', '공개 최근 약 7일 shadow-price 보고서 중 관측된 SCED 제약쌍; ShadowPrice>0을 경제적 binding으로 정의하고 다음 SCED까지 지속초 집계. 파일 부재·SCED 미확보 구간은 무혼잡으로 채우지 않음.', [MIS + '12302', PROTOCOL])
    coverage(fragment, 'utilization', '동일 SCED ConstraintName+ContingencyName의 Value/Limit. 양의 limit·비음수 방향흐름에 한해 계산; 송전선 열정격 전체 원격계측이나 전국 선로 이용률이 아님.', [MIS + '12302'])
    coverage(fragment, 'load', 'System-Wide Demand 공개 15분 실제 평균 MW×0.25h. 공개 MIS 보유기간 이전 날짜는 미확보.', [MIS + '12340'])
    coverage(fragment, 'curtailment', '풍력·태양광 잠재발전량 차이를 송전 원인 출력제한으로 추정하지 않음. 같은 기간 원인분류된 공개 MWh 보고서는 아직 연결하지 않음.', ['https://www.ercot.com/gridinfo/generation'])
    fragment['notes'] = ['MIS는 순환 보관이므로 요청 30일 전체와 다릅니다. 매일 수집해 확보된 원자료를 쌓아야 장기 시계열이 확장됩니다.', '실시간 SCED 모델 제약은 실제 선로 계측 혼잡과 구분합니다. 보고서의 모든 제약이 경제적으로 binding인 것은 아닙니다.', *errors]
    return fragment


def collect(start_date, end_date, cache_dir, refresh=False):
    return [collect_caiso(start_date, end_date, cache_dir, refresh),
            collect_ercot(start_date, end_date, cache_dir, refresh)]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', default='2026-09-13')
    parser.add_argument('--end', default='2026-10-12')
    parser.add_argument('--cache-dir', default='.local/transmission')
    parser.add_argument('--output', default='data/transmission-fragments/west.json')
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    fragments = collect(args.start, args.end, args.cache_dir, args.refresh)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(fragments, ensure_ascii=False, separators=(',', ':')) + '\n')
    print(json.dumps([{key: len(fragment[key]) for key in ('sources', 'priceIntervals', 'constraintIntervals', 'loadIntervals', 'utilizationIntervals', 'curtailmentIntervals')} | {'region': fragment['region'], 'notes': fragment['notes'][-5:]} for fragment in fragments], ensure_ascii=False))
