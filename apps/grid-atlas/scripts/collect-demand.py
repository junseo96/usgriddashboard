#!/usr/bin/env python3
"""Collect verified ISO/RTO demand. Public official feeds only; never fill gaps."""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

UTC = dt.timezone.utc
ROOT = Path(__file__).resolve().parents[1]
EIA_ENDPOINT = 'https://www.eia.gov/electricity/930-api/region_data/data'
REGIONS = {
    'CAISO': ('CISO', 'California ISO', 'America/Los_Angeles'),
    'ERCOT': ('ERCO', 'Electric Reliability Council of Texas', 'America/Chicago'),
    'ISO-NE': ('ISNE', 'ISO New England', 'America/New_York'),
    'MISO': ('MISO', 'Midcontinent ISO', 'America/Chicago'),
    'NYISO': ('NYIS', 'New York ISO', 'America/New_York'),
    'PJM': ('PJM', 'PJM Interconnection', 'America/New_York'),
    'SPP': ('SWPP', 'Southwest Power Pool', 'America/Chicago'),
}
ALLOWED_HOSTS = {'www.eia.gov', 'www.nyiso.com', 'mis.nyiso.com', 'www.caiso.com',
                 'www.ercot.com', 'www.iso-ne.com', 'www.misoenergy.org',
                 'api.misoenergy.org', 'www.pjm.com', 'api.spp.org', 'www.spp.org'}
MAX_BYTES = 16 * 1024 * 1024


def iso(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec='seconds').replace('+00:00', 'Z')


def timestamp(value: str) -> dt.datetime:
    if not isinstance(value, str):
        raise ValueError('Timestamp must be a UTC ISO string')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Timestamp must include timezone')
    return parsed.astimezone(UTC)


def valid_mw(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1_000_000


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def check_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Only allowlisted official HTTPS sources are permitted')


class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ArchivedFetcher:
    def __init__(self, state_dir: Path):
        self.state_dir = state_dir
        self.records = []
        self.opener = urllib.request.build_opener(OfficialRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def __call__(self, url: str) -> bytes:
        check_url(url)
        for attempt in range(2):
            try:
                request = urllib.request.Request(url, headers={'User-Agent': 'GridAtlas/1.0 (public grid demand research)', 'Accept': 'application/json,text/csv,text/plain,*/*'})
                with self.opener.open(request, timeout=20) as response:
                    expected = response.headers.get('Content-Length')
                    if expected and int(expected) > MAX_BYTES:
                        raise ValueError('Official response exceeds 16 MiB limit')
                    raw = response.read(MAX_BYTES + 1)
                    if len(raw) > MAX_BYTES or (expected and len(raw) != int(expected)):
                        raise ValueError('Truncated or oversized official response')
                    final_url = response.geturl()
                    check_url(final_url)
                digest = hashlib.sha256(raw).hexdigest()
                raw_dir = self.state_dir / 'raw'
                raw_dir.mkdir(parents=True, exist_ok=True)
                artifact = raw_dir / (digest + '.bin')
                if not artifact.exists():
                    artifact.write_bytes(raw)
                elif hashlib.sha256(artifact.read_bytes()).hexdigest() != digest:
                    raise ValueError('Existing raw archive hash mismatch')
                self.records.append({'url': url, 'resolvedUrl': final_url, 'sha256': digest, 'bytes': len(raw), 'retrievedAt': iso(dt.datetime.now(UTC))})
                return raw
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                if attempt:
                    raise RuntimeError('Official source fetch failed: ' + type(error).__name__) from error
                time.sleep(0.25)
        raise RuntimeError('Official source unavailable')


def eia_url(now: dt.datetime, days: int) -> str:
    params = {f'respondent[{index}]': item[0] for index, item in enumerate(REGIONS.values())}
    params.update({'type[0]': 'D', 'frequency': 'hourly',
                   'start': (now - dt.timedelta(days=days + 1)).strftime('%m%d%Y 00:00:00'),
                   'end': (now + dt.timedelta(days=1)).strftime('%m%d%Y 00:00:00'),
                   'timezone': 'UTC', 'limit': '50000'})
    return EIA_ENDPOINT + '?' + urllib.parse.urlencode(params)


def parse_eia(raw: bytes, now: dt.datetime, source_url: str) -> dict:
    document = json.loads(raw)
    if not isinstance(document, list) or len(document) != 1 or not isinstance(document[0], dict):
        raise ValueError('Unrecognized EIA envelope')
    envelope = document[0]
    rows = envelope.get('data')
    if not isinstance(rows, list) or not rows:
        raise ValueError('Empty EIA observations')
    if envelope.get('recordCount') != len(rows) or envelope.get('totalCount') != len(rows):
        raise ValueError('EIA result is truncated or count changed')
    known_codes = {item[0] for item in REGIONS.values()}
    by_code = {code: {} for code in known_codes}
    omissions = {code: {'imputed': 0, 'missing': 0, 'future': 0} for code in known_codes}
    for row in rows:
        if not isinstance(row, dict) or row.get('RESPONDENT_ID') not in known_codes or row.get('TYPE_ID') != 'D':
            raise ValueError('Unexpected respondent or measure in EIA response')
        code = row['RESPONDENT_ID']
        observed = dt.datetime.strptime(row['TIMESTAMP_'], '%m/%d/%Y %H:%M:%S').replace(tzinfo=UTC)
        if observed.minute or observed.second:
            raise ValueError('EIA hourly observation is not hour ending')
        if observed > now:
            omissions[code]['future'] += 1
            continue
        # EIA VAL can silently contain an imputed value. Only reported demand is actual.
        reported = row.get('REPORTED_VAL')
        if not valid_mw(reported):
            omissions[code]['imputed' if row.get('IMPUTED_VAL') is not None else 'missing'] += 1
            continue
        flag = row.get('FLAG_ID')
        description = row.get('FLAG_DESCRIPTION')
        quality = ': '.join(str(value) for value in (flag, description) if value is not None) or None
        point = {'observedAt': iso(observed), 'mw': reported, 'quality': quality}
        previous = by_code[code].get(point['observedAt'])
        if previous is not None and previous != point:
            raise ValueError('Conflicting EIA observations for one hour')
        by_code[code][point['observedAt']] = point
    result = {}
    for region, (code, name, timezone) in REGIONS.items():
        points = sorted(by_code[code].values(), key=lambda value: value['observedAt'])
        if not points:
            continue
        omitted = omissions[code]
        warnings = ['EIA-930 신고 수요의 1시간 평균 MW입니다. 5분 실시간 계측값과 같지 않습니다.',
                    '시각은 UTC 시간 종료(HE)이며 일일 피크는 해당 시간 구간이 속하는 권역 현지 날짜로 계산합니다.']
        if omitted['imputed']:
            warnings.append(f"EIA 추정·대체값 {omitted['imputed']}개를 실제 부하와 피크 계산에서 제외했습니다.")
        if omitted['missing']:
            warnings.append(f"원문 미보고·오류값 {omitted['missing']}개를 제외했습니다.")
        if omitted['future']:
            warnings.append(f"수집 시각 이후의 관측 {omitted['future']}개를 제외했습니다.")
        if any(point['quality'] for point in points):
            warnings.append('원천 품질 플래그가 있는 신고값은 개별 관측에 표시합니다.')
        result[region] = {'region': region, 'name': name, 'timezone': timezone,
                          'sourceName': 'EIA-930 · hourly reported demand', 'sourceUrl': source_url,
                          'retrievedAt': iso(now), 'observedAt': points[-1]['observedAt'],
                          'intervalMinutes': 60, 'latestMw': points[-1]['mw'], 'status': 'available',
                          'series': points, 'dailyPeaks': [], 'warnings': warnings, '_intervalEnding': True}
    return result


def daily_peaks(series: list, timezone: str, interval_minutes: int, now: dt.datetime, interval_ending: bool = False) -> list:
    if interval_minutes not in (1, 5, 10, 15, 30, 60):
        raise ValueError('Unsupported demand interval')
    zone = ZoneInfo(timezone)
    groups = {}
    unique = {}
    for point in series:
        observed = timestamp(point['observedAt'])
        if not valid_mw(point.get('mw')) or observed > now:
            raise ValueError('Invalid or future demand point')
        key = iso(observed)
        if key in unique:
            if unique[key] != point:
                raise ValueError('Conflicting observations')
            continue
        unique[key] = point
        local = (observed - dt.timedelta(microseconds=1) if interval_ending else observed).astimezone(zone)
        groups.setdefault(local.date(), []).append(point)
    peaks = []
    for date, points in sorted(groups.items()):
        beginning = dt.datetime.combine(date, dt.time(), zone).astimezone(UTC)
        ending = dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), zone).astimezone(UTC)
        expected = int((ending - beginning).total_seconds() / (60 * interval_minutes))
        # Distinct interval slots guard against duplicates or shifted dense bursts falsely completing a day.
        slots = {(timestamp(point['observedAt']) - beginning - (dt.timedelta(microseconds=1) if interval_ending else dt.timedelta())).total_seconds() // (60 * interval_minutes) for point in points}
        peak = max(points, key=lambda point: point['mw'])
        complete = len(points) == expected and len(slots) == expected and ending <= now and not any(point.get('quality') for point in points)
        peaks.append({'date': date.isoformat(), 'peakMw': peak['mw'], 'peakAt': peak['observedAt'],
                      'observations': len(points), 'expectedObservations': expected, 'complete': complete})
    return peaks


def normalize_region(item: dict, now: dt.datetime, days: int) -> dict:
    item = copy.deepcopy(item)
    if item.get('region') not in REGIONS:
        raise ValueError('Unsupported demand region')
    _, name, timezone = REGIONS[item['region']]
    if item.get('timezone') != timezone:
        raise ValueError('Unexpected market timezone')
    check_url(item['sourceUrl'])
    interval_ending = item.pop('_intervalEnding', False)
    start_date = now.astimezone(ZoneInfo(timezone)).date() - dt.timedelta(days=days - 1)
    points = []
    seen = {}
    for point in sorted(item['series'], key=lambda value: value['observedAt']):
        observed = timestamp(point['observedAt'])
        if not valid_mw(point.get('mw')) or observed > now:
            raise ValueError('Demand point invalid or in future')
        date = (observed - dt.timedelta(microseconds=1) if interval_ending else observed).astimezone(ZoneInfo(timezone)).date()
        if date < start_date:
            continue
        normalized = {'observedAt': iso(observed), 'mw': point['mw'], 'quality': point.get('quality')}
        if normalized['observedAt'] in seen:
            if seen[normalized['observedAt']] != normalized:
                raise ValueError('Conflicting direct demand points')
            continue
        seen[normalized['observedAt']] = normalized
        points.append(normalized)
    if not points:
        raise ValueError('No usable recent actual demand observations')
    item['series'] = points
    item['observedAt'], item['latestMw'] = points[-1]['observedAt'], points[-1]['mw']
    item['dailyPeaks'] = daily_peaks(points, timezone, item['intervalMinutes'], now, interval_ending)
    for peak in item['dailyPeaks']:
        peak.update(intervalMinutes=item['intervalMinutes'], sourceName=item['sourceName'], sourceUrl=item['sourceUrl'])
    max_age = dt.timedelta(hours=4 if item['intervalMinutes'] == 60 else 2)
    age = now - timestamp(item['observedAt'])
    item['status'] = 'stale' if age > max_age else 'available'
    if item['status'] == 'stale':
        item['warnings'].append(f"최신 관측이 수집 시점보다 {int(age.total_seconds() // 60)}분 이전으로 지연됐습니다.")
    if any(not point['complete'] for point in item['dailyPeaks']):
        item['warnings'].append('진행 중이거나 관측이 빠진 날짜의 피크는 잠정 최댓값이며 완결된 일일 피크가 아닙니다.')
    if len(item['dailyPeaks']) < days:
        item['warnings'].append(f"이 출처에서 확인한 일일 관측은 {len(item['dailyPeaks'])}일입니다. 없는 날짜를 생성하지 않습니다.")
    return item


def unavailable(region: str, reason: str) -> dict:
    _, name, timezone = REGIONS[region]
    return {'region': region, 'name': name, 'timezone': timezone, 'sourceName': 'EIA-930',
            'sourceUrl': EIA_ENDPOINT, 'retrievedAt': None, 'observedAt': None, 'intervalMinutes': None,
            'latestMw': None, 'status': 'unavailable', 'series': [], 'dailyPeaks': [], 'warnings': [reason]}


def collect(now: dt.datetime, fetch, previous: dict | None = None, days: int = 7, direct=None, eia_only: bool = False) -> tuple[dict, dict]:
    previous_regions = {item['region']: item for item in (previous or {}).get('regions', []) if item.get('region') in REGIONS}
    fallback_error = None
    try:
        url = eia_url(now, days)
        fallback = parse_eia(fetch(url), now, url)
        records = getattr(fetch, 'records', [])
        if records:
            for item in fallback.values():
                item['retrievedAt'] = records[-1]['retrievedAt']
    except (ValueError, KeyError, TypeError, RuntimeError, OSError) as error:
        fallback, fallback_error = {}, f'{type(error).__name__}: {error}'
    regions, failures, chosen, direct_failures = [], {}, {}, {}
    for region in REGIONS:
        candidate, direct_error = None, None
        if direct is not None and not eia_only:
            try:
                before_fetches = len(getattr(fetch, 'records', []))
                raw = direct(region, fetch, now, days=days)
                if raw is not None:
                    records = getattr(fetch, 'records', [])
                    if len(records) > before_fetches:
                        raw['retrievedAt'] = records[-1]['retrievedAt']
                    candidate = normalize_region(raw, now, days)
            except (ValueError, KeyError, TypeError, RuntimeError, OSError) as error:
                direct_error = f'{type(error).__name__}: {error}'
                direct_failures[region] = direct_error
        fallback_candidate = None
        if region in fallback:
            try:
                fallback_candidate = normalize_region(fallback[region], now, days)
            except (ValueError, KeyError, TypeError) as error:
                failures[region] = str(error)
        # A failed/stale direct feed does not hide a newer verified hourly observation.
        if fallback_candidate and (candidate is None or timestamp(fallback_candidate['observedAt']) > timestamp(candidate['observedAt']) + dt.timedelta(hours=2)):
            candidate = fallback_candidate
            if direct_error:
                candidate['warnings'].append('직접 운영기관 피드 갱신 실패로 EIA 신고 수요를 표시합니다.')
        if candidate is not None and fallback_candidate is not None and candidate is not fallback_candidate:
            # Preserve seven local days without mixing hourly and five-minute line samples.
            # Historical hourly peaks carry their own cadence/source; direct current-day peak wins.
            direct_dates = {peak['date']: peak for peak in candidate['dailyPeaks']}
            combined = {peak['date']: copy.deepcopy(peak) for peak in fallback_candidate['dailyPeaks']}
            today = now.astimezone(ZoneInfo(candidate['timezone'])).date().isoformat()
            for date, peak in direct_dates.items():
                if date == today or peak['complete'] or date not in combined or not combined[date]['complete']:
                    combined[date] = peak
            if any(peak['sourceName'] != candidate['sourceName'] for peak in combined.values()):
                candidate['warnings'].append('일일 이력 일부는 EIA 1시간 평균의 피크입니다. 각 날짜의 출처·측정 간격을 확인하세요. 5분 최신 관측선에는 시간별 자료를 혼합하지 않습니다.')
            candidate['dailyPeaks'] = [combined[key] for key in sorted(combined)]
        old = previous_regions.get(region)
        if candidate is not None and old and old.get('observedAt') and timestamp(old['observedAt']) > timestamp(candidate['observedAt']):
            candidate = copy.deepcopy(old)
            candidate['status'] = 'stale'
            candidate['warnings'].append('새 원문이 직전 관측보다 과거여서 기존 검증 관측을 보존했습니다.')
        if candidate is None:
            old = previous_regions.get(region)
            if old and old.get('latestMw') is not None and old.get('series'):
                candidate = copy.deepcopy(old)
                candidate['status'] = 'stale'
                candidate['warnings'] = [warning for warning in candidate.get('warnings', []) if not warning.startswith('이번 수집 실패')]
                candidate['warnings'].append('이번 수집 실패: 직전 검증 관측을 보존했으며 취득 시각을 갱신하지 않았습니다.')
            else:
                candidate = unavailable(region, '공식 원문을 취득·검증하지 못했습니다. 미확보 값을 0으로 대체하지 않습니다.')
            failures[region] = direct_error or fallback_error or failures.get(region) or 'No reported observations'
        elif candidate['status'] == 'stale':
            failures[region] = 'Latest official observation is stale'
        regions.append(candidate)
        chosen[region] = candidate['sourceName']
    dataset = {'schemaVersion': 1, 'generatedAt': iso(now), 'lastAttemptAt': iso(now), 'refreshMinutes': 15, 'regions': regions}
    report = {'generatedAt': iso(now), 'status': 'success' if not failures else ('partial' if any(item['status'] == 'available' for item in regions) else 'failed'),
              'failures': failures, 'eiaFailure': fallback_error, 'directFailures': direct_failures, 'sources': chosen}
    return dataset, report



def validate_previous(document: object, now: dt.datetime) -> dict:
    """Reject corrupt cached/public artifacts before preserving any historical value."""
    def require(condition, reason):
        if not condition:
            raise ValueError('Invalid previous demand dataset: ' + reason)
    require(isinstance(document, dict), 'object required')
    require(type(document.get('schemaVersion')) is int and document['schemaVersion'] == 1, 'schema version')
    generated = timestamp(document.get('generatedAt'))
    attempted = timestamp(document.get('lastAttemptAt'))
    require(attempted <= generated <= now + dt.timedelta(minutes=5), 'generation/attempt order or future timestamp')
    require(type(document.get('refreshMinutes')) is int and 0 < document['refreshMinutes'] <= 1440, 'refresh minutes')
    regions = document.get('regions')
    require(isinstance(regions, list) and len(regions) == len(REGIONS), 'seven regions required')
    seen = set()
    for item in regions:
        require(isinstance(item, dict), 'region object')
        region = item.get('region')
        require(region in REGIONS and region not in seen, 'unknown or duplicate region')
        seen.add(region)
        require(item.get('timezone') == REGIONS[region][2], 'market timezone')
        require(isinstance(item.get('name'), str) and bool(item['name']), 'region name')
        require(isinstance(item.get('sourceName'), str) and bool(item['sourceName']), 'source name')
        require(isinstance(item.get('sourceUrl'), str), 'source URL')
        check_url(item['sourceUrl'])
        require(item.get('status') in ('available', 'stale', 'unavailable'), 'region status')
        require(isinstance(item.get('warnings'), list) and all(isinstance(value, str) for value in item['warnings']), 'warnings')
        series, peaks = item.get('series'), item.get('dailyPeaks')
        require(isinstance(series, list) and isinstance(peaks, list), 'observation arrays')
        if item['status'] == 'unavailable':
            require(item.get('latestMw') is None and item.get('observedAt') is None and item.get('retrievedAt') is None and item.get('intervalMinutes') is None and not series and not peaks, 'unavailable values must remain null')
            continue
        require(type(item.get('intervalMinutes')) is int and item['intervalMinutes'] in (1, 5, 10, 15, 30, 60), 'observation interval')
        require(valid_mw(item.get('latestMw')) and bool(series), 'actual observations required')
        retrieved = timestamp(item.get('retrievedAt'))
        observed = timestamp(item.get('observedAt'))
        require(observed <= retrieved <= generated, 'observation/retrieval order')
        previous_time = None
        for point in series:
            require(isinstance(point, dict) and valid_mw(point.get('mw')), 'invalid MW point')
            stamp = timestamp(point.get('observedAt'))
            require(stamp <= observed and (previous_time is None or stamp > previous_time), 'unordered/duplicate/future series')
            require(point.get('quality') is None or isinstance(point['quality'], str), 'point quality')
            previous_time = stamp
        require(series[-1]['observedAt'] == item['observedAt'] and series[-1]['mw'] == item['latestMw'], 'latest does not match series')
        prior_date = None
        for peak in peaks:
            require(isinstance(peak, dict) and valid_mw(peak.get('peakMw')), 'invalid peak MW')
            date = dt.date.fromisoformat(peak.get('date'))
            require(prior_date is None or date > prior_date, 'unordered/duplicate peak date')
            prior_date = date
            require(timestamp(peak.get('peakAt')) <= retrieved, 'peak occurs after retrieval')
            require(type(peak.get('complete')) is bool, 'peak completeness')
            count, expected = peak.get('observations'), peak.get('expectedObservations')
            require(type(count) is int and type(expected) is int and 0 < count <= expected <= 1500, 'peak observation counts')
            require(not peak['complete'] or count == expected, 'complete peak has missing points')
            interval = peak.get('intervalMinutes', item['intervalMinutes'])
            require(type(interval) is int and interval in (1, 5, 10, 15, 30, 60), 'peak interval')
            zone = ZoneInfo(item['timezone'])
            beginning = dt.datetime.combine(date, dt.time(), zone).astimezone(UTC)
            ending = dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), zone).astimezone(UTC)
            require(expected == (ending - beginning).total_seconds() / (interval * 60), 'peak expected count/calendar mismatch')
            require(not peak['complete'] or ending <= retrieved, 'ongoing date marked complete')
            if 'sourceUrl' in peak:
                require(isinstance(peak['sourceUrl'], str), 'peak source URL')
                check_url(peak['sourceUrl'])
            if 'sourceName' in peak:
                require(isinstance(peak['sourceName'], str) and bool(peak['sourceName']), 'peak source name')
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/grid-demand.json')
    parser.add_argument('--previous', type=Path, help='Read last-good dataset from this file instead of --output')
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.local/demand')
    parser.add_argument('--days', type=int, choices=range(3, 8), default=7)
    parser.add_argument('--eia-only', action='store_true', help='Use verified hourly EIA observations for all regions')
    args = parser.parse_args()
    previous_path = args.previous or args.output
    now = dt.datetime.now(UTC)
    try:
        previous = validate_previous(json.loads(previous_path.read_text()), now) if previous_path.exists() else None
    except (ValueError, TypeError, KeyError, OSError) as error:
        print('Previous demand dataset validation failed: ' + str(error), file=sys.stderr)
        return 2
    fetch = ArchivedFetcher(args.state_dir)
    try:
        from demand_direct import collect_direct
    except ImportError:
        collect_direct = None
    dataset, report = collect(now, fetch, previous, args.days, collect_direct, args.eia_only)
    dataset['generatedAt'] = iso(dt.datetime.now(UTC))
    report['completedAt'] = dataset['generatedAt']
    report['rawSources'] = fetch.records
    validate_previous(dataset, dt.datetime.now(UTC))
    atomic_json(args.output, dataset)
    report_file = args.state_dir / 'runs' / (now.strftime('%Y%m%dT%H%M%S%fZ') + '.json')
    atomic_json(report_file, report)
    print(json.dumps({'status': report['status'], 'output': str(args.output), 'report': str(report_file),
                      'regions': [{'region': item['region'], 'status': item['status'], 'source': item['sourceName'], 'latestMw': item['latestMw'], 'observedAt': item['observedAt'], 'points': len(item['series'])} for item in dataset['regions']]}, ensure_ascii=False))
    return 0 if report['status'] == 'success' else 1


if __name__ == '__main__':
    sys.exit(main())
