"""PJM access checks and MISO official hourly MCC / 5-minute binding / actual load.

MISO hourly LMP reports use fixed EST (UTC-05) including summer. Binding report
occurrences are END timestamps per the official reader guide, so the 00:00
occurrence is the interval ending at midnight, not starting there. The complete
report window preserves those labels: previous-day 23:55 through report-day23:55.
Only blank Constraint Description denotes transmission; reserve constraints are
excluded. Shadow price is not a flow, limit, or system congestion-cost measure.
"""
from __future__ import annotations

import argparse
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

import xlrd

from transmission_common import empty_fragment, hourly_price_spreads, iso, number

EST = timezone(timedelta(hours=-5))
BASE = 'https://docs.misoenergy.org/marketreports/'
BINDING_GUIDE = BASE + 'Real-Time%20Binding%20Constraints_Real-Time%20Binding%20Constraints%20Readers%20Guide.pdf'
LMP_GUIDE = BASE + urllib.parse.quote('Real-Time Final Market LMPs_MISO Pricing Reports Readers Guide.pdf')
LOAD_GUIDE = BASE + urllib.parse.quote('Daily Forecast and Actual Load by Local Resource Zone_Daily Forecast and Actual Load Report by Local Resource Zone Report Readers Guide.pdf')
PJM_API = 'https://api.pjm.com/api/v1/rt_hrl_lmps?rowCount=1&startRow=1'
PJM_PAGE = 'https://www.pjm.com/markets-and-operations/energy/real-time/lmp'
MAX_BYTES = 16_000_000


def _day(value):
    return date.fromisoformat(value) if isinstance(value, str) else value


def _fetch(url, cache_dir, refresh=False):
    folder = Path(cache_dir) / 'midwest' / 'history'
    folder.mkdir(parents=True, exist_ok=True)
    name = urllib.parse.unquote(urllib.parse.urlparse(url).path.rsplit('/', 1)[-1])
    if not url.startswith(BASE):
        name = hashlib.sha256(url.encode()).hexdigest()[:16] + '-' + name
    path = folder / name
    meta_path = path.with_suffix(path.suffix + '.meta.json')
    if not refresh and path.exists() and meta_path.exists():
        blob = path.read_bytes()
        meta = json.loads(meta_path.read_text())
        if meta['sha256'] != hashlib.sha256(blob).hexdigest() or meta['url'] != url:
            raise ValueError('Cached source integrity mismatch')
        return blob, meta
    req = urllib.request.Request(url, headers={'User-Agent': 'GridAtlas/1.0 public official-market-data research'})
    with urllib.request.urlopen(req, timeout=30) as response:
        blob = response.read(MAX_BYTES + 1)
        if len(blob) > MAX_BYTES:
            raise ValueError('Source exceeds 16 MB acquisition limit')
        if response.url != url:
            if urllib.parse.urlparse(response.url).hostname != urllib.parse.urlparse(url).hostname:
                raise ValueError('Unexpected source redirect')
    meta = dict(url=url, retrievedAt=iso(datetime.now(timezone.utc)),
                sha256=hashlib.sha256(blob).hexdigest(), bytes=len(blob), status='success')
    path.write_bytes(blob)
    meta_path.write_text(json.dumps(meta))
    return blob, meta


def _source(meta, source_id, title, publisher, source_as_of=None):
    result = {key: meta[key] for key in ('url', 'retrievedAt', 'sha256')}
    result.update(id=source_id, title=title, publisher=publisher)
    if source_as_of:
        result['sourceAsOf'] = source_as_of
    return result


def _numeric(value):
    if value is None or str(value).strip() in ('', 'N/A', 'NA', '--', '-'):
        return None
    return number(value)


def parse_miso_lmp(blob, market_day, source_id):
    """Native hourly signed MCC of official Type=Loadzone, never total LMP."""
    market_day = _day(market_day)
    lines = blob.decode('utf-8-sig').splitlines()
    if len(lines) < 6 or next(csv.reader([lines[0]]))[0].strip() != 'Realtime Market LMPs':
        raise ValueError('Unexpected MISO realtime LMP report')
    if datetime.strptime(next(csv.reader([lines[1]]))[0].strip(), '%m/%d/%Y').date() != market_day:
        raise ValueError('MISO LMP market date mismatch')
    if 'Eastern Standard Time (EST)' not in lines[3]:
        raise ValueError('MISO LMP time basis is not fixed EST')
    reader = csv.DictReader(lines[4:])
    expected = ['Node', 'Type', 'Value'] + [f'HE {hour}' for hour in range(1, 25)]
    if reader.fieldnames != expected:
        raise ValueError('MISO hourly LMP schema changed')
    rows, seen = [], set()
    for item in reader:
        if item['Value'] != 'MCC' or item['Type'] != 'Loadzone':
            continue
        node = item['Node'].strip()
        if not node or node in seen:
            raise ValueError('Missing or duplicate MISO MCC load zone')
        seen.add(node)
        for hour in range(1, 25):
            value = _numeric(item[f'HE {hour}'])
            if value is None:
                continue
            start = datetime.combine(market_day, datetime.min.time(), EST) + timedelta(hours=hour - 1)
            rows.append(dict(start=iso(start), end=iso(start + timedelta(hours=1)), node=node, value=value, sourceIds=[source_id]))
    if len(seen) < 2 or not rows:
        raise ValueError('MISO report lacks a comparable MCC load-zone population')
    return hourly_price_spreads(rows, 'MISO', 'real_time', 'load_zones', 'MISO 공식 Loadzone 분류 · 노드 동일 가중')


def parse_miso_binding(blob, market_day, source_id):
    market_day = _day(market_day)
    sheet = xlrd.open_workbook(file_contents=blob).sheet_by_index(0)
    if sheet.nrows < 4 or sheet.cell_value(0, 0) != 'Binding Constraints Report - Real-Time Market':
        raise ValueError('Unexpected MISO binding report')
    match = re.fullmatch(r'Market Date:\s*(\d{1,2}/\d{1,2}/\d{4})', str(sheet.cell_value(1, 0)))
    if not match or datetime.strptime(match.group(1), '%m/%d/%Y').date() != market_day:
        raise ValueError('MISO binding market date mismatch')
    headers = sheet.row_values(3)
    required = ['Constraint ID', 'Constraint Name', 'Contingency Description', 'Hour of  Occurrence', 'Constraint Description', 'Preliminary Shadow Price']
    if any(key not in headers for key in required):
        raise ValueError('MISO binding schema changed')
    rows, seen, reserve_count = [], set(), 0
    for index in range(4, sheet.nrows):
        row = dict(zip(headers, sheet.row_values(index)))
        if not any(str(value).strip() for value in row.values()):
            continue
        # Reserve procurement rows are documented separately from transmission.
        if str(row['Constraint Description']).strip():
            reserve_count += 1
            continue
        name, occurrence = str(row['Constraint Name']).strip(), str(row['Hour of  Occurrence']).strip()
        raw_id = number(row['Constraint ID'])
        if raw_id <= 0 or raw_id != int(raw_id):
            raise ValueError('Invalid MISO constraint identity')
        asset_id = f'{int(raw_id)}:{name}'
        if not name or not re.fullmatch(r'(?:[01]\d|2[0-3]):(?:[0-5][05])', occurrence):
            raise ValueError('Malformed MISO transmission binding occurrence')
        # Validate the price exists, without using its sign as the binding flag.
        number(row['Preliminary Shadow Price'])
        hour, minute = map(int, occurrence.split(':'))
        end = datetime.combine(market_day, datetime.min.time(), EST) + timedelta(hours=hour, minutes=minute)
        contingency = str(row['Contingency Description']).strip() or None
        key = (asset_id, contingency, iso(end))
        if key in seen:
            continue
        seen.add(key)
        rows.append(dict(region='MISO', start=iso(end - timedelta(minutes=5)), end=iso(end), assetId=asset_id,
                         contingency=contingency, binding=True, sourceIds=[source_id]))
    # Official daily report contains all 288 end-labeled slots, including slots
    # with no event. Do not stretch its window into the next day's ending00:00.
    start = datetime.combine(market_day, datetime.min.time(), EST) - timedelta(minutes=5)
    window = dict(region='MISO', start=iso(start), end=iso(start + timedelta(days=1)), sourceIds=[source_id])
    return rows, [window], reserve_count


def parse_miso_load(blob, market_day, source_id):
    market_day = _day(market_day)
    book = xlrd.open_workbook(file_contents=blob)
    sheet = book.sheet_by_index(0)
    if sheet.nrows < 6 or 'ACTUAL LOAD REPORT' not in str(sheet.cell_value(1, 0)):
        raise ValueError('Unexpected MISO actual-load report')
    headers = sheet.row_values(4)
    if any(key not in headers for key in ['Market Day', 'HourEnding', 'MISO ActualLoad (MWh)']):
        raise ValueError('MISO actual-load schema changed')
    rows, seen = [], set()
    for index in range(5, sheet.nrows):
        row = dict(zip(headers, sheet.row_values(index)))
        raw_day = row['Market Day']
        if not isinstance(raw_day, (int, float)):
            continue
        day = xlrd.xldate_as_datetime(raw_day, book.datemode).date()
        if day != market_day:
            continue
        hour_raw = row['HourEnding']
        hour = int(number(hour_raw))
        if hour != number(hour_raw) or not 1 <= hour <= 24 or hour in seen:
            raise ValueError('Invalid/duplicate MISO actual-load hour')
        seen.add(hour)
        mwh = _numeric(row['MISO ActualLoad (MWh)'])
        if mwh is None:
            continue
        if mwh < 0:
            raise ValueError('Negative actual MISO load')
        # Report column is MWh within this one-hour interval => same numeric MW.
        start = datetime.combine(market_day, datetime.min.time(), EST) + timedelta(hours=hour - 1)
        rows.append(dict(region='MISO', start=iso(start), end=iso(start + timedelta(hours=1)), mw=mwh, sourceIds=[source_id]))
    if not rows:
        raise ValueError('No actual load for requested market date; forecasts are not observations')
    return rows


def _miso(start_day, end_day, cache_dir, refresh):
    fragment = empty_fragment('MISO')
    failures = []
    reserve_count, complete_prices, complete_load, binding_days = 0, 0, 0, 0
    day = start_day
    while day <= end_day:
        tag, next_tag = day.strftime('%Y%m%d'), (day + timedelta(days=1)).strftime('%Y%m%d')
        for metric, variants, parser, target in [
            ('price_spread', [f'{tag}_rt_lmp_final.csv', f'{tag}_rt_lmp_prelim.csv'], parse_miso_lmp, 'priceIntervals'),
            ('binding_duration', [f'{next_tag}_rt_bc.xls'], parse_miso_binding, 'constraintIntervals'),
            ('load', [f'{next_tag}_df_al.xls'], parse_miso_load, 'loadIntervals'),
        ]:
            success = False
            for name in variants:
                url = BASE + name
                try:
                    blob, meta = _fetch(url, cache_dir, refresh)
                    source_id = 'miso-' + name.replace('.', '-')
                    parsed = parser(blob, day, source_id)
                    if metric == 'binding_duration':
                        parsed, windows, reserves = parsed
                        fragment['constraintWindows'].extend(windows)
                        reserve_count += reserves
                        binding_days += 1
                    elif metric == 'price_spread':
                        complete_prices += len(parsed) == 24
                    elif metric == 'load':
                        complete_load += len(parsed) == 24
                    fragment[target].extend(parsed)
                    fragment['sources'].append(_source(meta, source_id, f'MISO {metric} {day.isoformat()} ({name})', 'MISO', day.isoformat()))
                    success = True
                    break
                except (urllib.error.URLError, TimeoutError, ValueError, OSError, xlrd.biffh.XLRDError) as error:
                    failures.append(dict(metric=metric, date=day.isoformat(), url=url, error=str(error)))
            if not success:
                continue
        day += timedelta(days=1)
    expected = (end_day - start_day).days + 1
    for metric, count, field in [('price_spread', complete_prices, 'priceIntervals'), ('binding_duration', binding_days, 'constraintWindows'), ('load', complete_load, 'loadIntervals')]:
        available = bool(fragment[field])
        fragment['coverage'].append(dict(region='MISO', metric=metric, status='observed' if count == expected else 'partial' if available else 'unavailable',
          reason=f'요청 {expected}일 중 완전한 일별 보고서 {count}일. 공식 원자료의 시장일과 고정 EST 사용; 게시되지 않은 날짜는 공백.',
          sourceUrls=sorted({source['url'] for source in fragment['sources'] if metric in source['title']})))
    for metric, reason in [('utilization', 'Binding·shadow price는 실측 흐름/동시 운전한도가 아니므로 이용률로 변환하지 않음.'), ('curtailment', '이번 공개 보고서는 송전 제약에 귀속되는 출력제한 MWh를 제공하지 않음.')]:
        fragment['coverage'].append(dict(region='MISO', metric=metric, status='unavailable', reason=reason, sourceUrls=[BASE]))
    for guide_url, guide_id, title, guide_date in [
        (BINDING_GUIDE, 'miso-binding-readers-guide', 'MISO Real-Time Binding Constraints Readers Guide v3.3', '2014-05-02'),
        (LMP_GUIDE, 'miso-lmp-readers-guide', 'MISO Pricing Reports Readers Guide v3.0', '2015-04-27'),
        (LOAD_GUIDE, 'miso-load-readers-guide', 'MISO Actual Load by Local Resource Zone Readers Guide v3.1', '2015-01-15'),
    ]:
        try:
            _, guide_meta = _fetch(guide_url, cache_dir, refresh)
            fragment['sources'].append(_source(guide_meta, guide_id, title, 'MISO', guide_date))
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            failures.append(dict(metric='documentation', url=guide_url, error=str(error)))
    fragment['notes'] = [
        'MCC는 부호가 있는 혼잡 성분만 사용. 같은 시각 공식 Loadzone 분류의 시간평균 MCC에서 P90−P10을 산출하며 지역별 부하 가중값이 아님. 날짜별 공식 노드 구성 변경은 nodeCount에 표시.',
        'MISO 시장시간은 서머타임을 적용하지 않는 EST(UTC−05). 실제 부하 MWh/1시간은 같은 숫자의 평균 MW로 보존.',
        'Binding reader guide는 Hour of Occurrence를 5분 구간 끝으로 정의. 00:00~23:55 라벨을 보존하여 관측창은 시장일 전날23:55~시장일23:55 EST.',
        f'전송제약과 다른 reserve procurement 행 {reserve_count}건 제외. 동일 제약·사고·시각 중복을 제거하고 전체 ISO 어딘가 한 건 발생을 주력 혼잡도로 삼지 않음.',
        '실제 흐름과 허용한도는 이 binding 파일에 없으며 shadow price/curve breakpoint를 이용률로 바꾸지 않음.',
        'Source guide: ' + BINDING_GUIDE,
    ]
    # Machine-readable failed acquisition evidence remains private with raw data.
    folder = Path(cache_dir) / 'midwest'
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'failures.json').write_text(json.dumps(failures, ensure_ascii=False, indent=2))
    return fragment


def _pjm(cache_dir, refresh):
    fragment = empty_fragment('PJM')
    try:
        blob, meta = _fetch(PJM_PAGE, cache_dir, refresh)
        text = blob.decode('utf-8', errors='replace')
        if 'This page is no longer available' not in text or 'rt_hrl_lmps' not in text:
            raise ValueError('Legacy PJM download-page status changed; review required')
        fragment['sources'].append(_source(meta, 'pjm-hourly-lmp-moved', 'PJM Daily Real-Time LMP official data-location notice', 'PJM'))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
        fragment['notes'].append('공식 기존 다운로드 페이지 확인 실패: ' + str(error))
    status, reason = 'unavailable', 'PJM 공식 Data Miner 시계열의 공개 취득 상태를 확인하지 못함.'
    try:
        blob, meta = _fetch(PJM_API, cache_dir, refresh)
        # A successful response requires an explicit bounded/date-aware adapter;
        # an empty probe cannot be counted as observed current/history data.
        json.loads(blob)
        status, reason = 'unavailable', '공식 API 접근은 가능하지만 날짜 범위·노드·페이지 완결성을 검증한 취득이 아직 없음.'
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            status = 'auth_required' if error.code == 401 else 'access_blocked'
            reason = f'공식 Data Miner hourly LMP API가 인증 없는 요청에 HTTP {error.code}. 구독키가 연결되지 않아 MCC·동시간 부하·제약 이력을 취득하지 못함.'
        else:
            reason = f'공식 API HTTP {error.code}; 취득 없음.'
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
        reason = '공식 API 취득 실패: ' + str(error)
    for metric in ('price_spread', 'binding_duration', 'load'):
        fragment['coverage'].append(dict(region='PJM', metric=metric, status=status, reason=reason, sourceUrls=[PJM_API, PJM_PAGE]))
    for metric in ('utilization', 'curtailment'):
        fragment['coverage'].append(dict(region='PJM', metric=metric, status='unavailable', reason='이번 취득에서 개별 제약의 실측 흐름/동시 한도 또는 송전 원인 출력제한 자료를 확보하지 못함.', sourceUrls=[PJM_PAGE]))
    fragment['notes'].append('PJM 기존 일별 LMP 페이지는 공식적으로 Data Miner 2로 이전됨. 연간 혼잡비용을 실제 시간별 관측의 대체값으로 채우지 않음.')
    return fragment


def collect(start_date, end_date, cache_dir, refresh=False):
    start_day, end_day = _day(start_date), _day(end_date)
    if start_day > end_day or (end_day - start_day).days > 366:
        raise ValueError('Requested date range must be inclusive and at most 367 days')
    return [_pjm(cache_dir, refresh), _miso(start_day, end_day, cache_dir, refresh)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--cache-dir', default='.local/transmission')
    parser.add_argument('--output', default='data/transmission-fragments/midwest.json')
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    fragments = collect(args.start, args.end, args.cache_dir, args.refresh)
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fragments, ensure_ascii=False, separators=(',', ':')) + '\n')
    for fragment in fragments:
        print(json.dumps(dict(region=fragment['region'], prices=len(fragment['priceIntervals']), binding=len(fragment['constraintIntervals']), windows=len(fragment['constraintWindows']), load=len(fragment['loadIntervals']), coverage=fragment['coverage']), ensure_ascii=False))


if __name__ == '__main__':
    main()
