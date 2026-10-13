"""SPP public RTBM operations, separate from annual financial congestion reports.

Daily LMP archives normally publish five days after the operating day. Binding
reports and actual hourly load have their own publication delay. Missing days
stay missing. SPP East (BAA SPP / Interconnect E) is selected consistently;
SWPW is a different reference basin and is not pooled into the MCC dispersion.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
from pathlib import Path
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

from transmission_common import empty_fragment, hourly_price_spreads, iso, number

UTC = timezone.utc
CENTRAL = ZoneInfo('America/Chicago')
BASE = 'https://portal.spp.org/file-browser-api/download/'
HEADERS = {'User-Agent': 'GridAtlas/1.0 public operational-data collector'}
SOURCE_TYPES = {
    'lmp': ('rtbm-lmp-by-location', 'RTBM-LMP-DAILY-SL', 'SPP RTBM settlement-location LMP'),
    'bc': ('rtbm-binding-constraints', 'RTBM-DAILY-BC', 'SPP RTBM binding-constraint report'),
    'load': ('hourly-load', 'DAILY_HOURLY_LOAD', 'SPP actual hourly load by control zone'),
}


def dates(start, end):
    start, end = date.fromisoformat(str(start)), date.fromisoformat(str(end))
    if end < start:
        raise ValueError('end before start')
    while start <= end:
        yield start
        start += timedelta(days=1)


def url_for(kind, day):
    endpoint, prefix, _ = SOURCE_TYPES[kind]
    folder = day.strftime('/%Y/') if kind == 'load' else day.strftime('/%Y/%m/By_Day/')
    return BASE + endpoint + '?path=' + folder + prefix + '-' + day.strftime('%Y%m%d') + '.csv'


def day_bounds(day):
    start = datetime.combine(day, time(), CENTRAL).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time(), CENTRAL).astimezone(UTC)
    return start, end


def utc_field(value):
    # Both GMTIntervalEnd/GMT Interval and Market Hour are UTC end timestamps.
    return datetime.strptime(value.strip(), '%m/%d/%Y %H:%M:%S').replace(tzinfo=UTC)


def reader(path):
    handle = Path(path).open(encoding='utf-8-sig', newline='')
    rows = csv.DictReader(handle)
    if not rows.fieldnames:
        handle.close()
        raise ValueError('Missing CSV header')
    rows.fieldnames = [key.strip() for key in rows.fieldnames]
    return handle, rows


def fetch(kind, day, cache_dir, refresh=False):
    stem = kind + '-' + day.strftime('%Y%m%d')
    return fetch_url(stem, url_for(kind, day), SOURCE_TYPES[kind][2] + ' · ' + day.isoformat(), day, cache_dir, refresh)


def fetch_url(stem, url, title, day, cache_dir, refresh=False):
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    raw, metadata = cache_dir / (stem + '.csv'), cache_dir / (stem + '.meta.json')
    if refresh or not raw.exists() or not metadata.exists():
        request = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(request, timeout=90) as response:
            body = response.read(128 * 1024 * 1024 + 1)
        if len(body) > 128 * 1024 * 1024:
            raise ValueError('SPP file exceeds 128 MiB')
        if not body.strip() or body.lstrip().startswith(b'<'):
            raise ValueError('SPP response is not CSV')
        meta = dict(url=url, retrievedAt=iso(datetime.now(UTC)), sha256=hashlib.sha256(body).hexdigest(), bytes=len(body))
        temporary = raw.with_suffix('.tmp')
        temporary.write_bytes(body)
        temporary.replace(raw)
        metadata.write_text(json.dumps(meta), encoding='utf-8')
    meta = json.loads(metadata.read_text())
    digest = hashlib.sha256(raw.read_bytes()).hexdigest()
    if meta['url'] != url or meta['sha256'] != digest:
        raise ValueError('SPP cached source URL/hash mismatch')
    source = dict(id='spp-' + stem, title=title, publisher='Southwest Power Pool',
                  url=url, retrievedAt=iso(meta['retrievedAt']), sha256=digest, sourceAsOf=day.isoformat())
    return raw, source


def latest_day_intervals(kind, day, cache_dir, refresh=False):
    """Recover the most recent requested day from actual interval files.

    This is not synthetic backfill: every five-minute file retains its own
    provenance. Incomplete hours remain missing under the shared price helper.
    """
    start_day, end_day = day_bounds(day)
    endpoints = [start_day + timedelta(minutes=5 * i) for i in range(1, int((end_day-start_day).total_seconds()/300)+1)]
    endpoint = SOURCE_TYPES[kind][0]
    prefix = 'RTBM-LMP-SL' if kind == 'lmp' else 'RTBM-BC'

    def acquire(end):
        local_end = end.astimezone(CENTRAL)
        suffix = 'd' if abs(local_end.utcoffset()) > abs((end-timedelta(hours=1)).astimezone(CENTRAL).utcoffset()) else ''
        stamp = local_end.strftime('%Y%m%d%H%M') + suffix
        folder = (end-timedelta(minutes=5)).astimezone(CENTRAL).strftime('/%Y/%m/By_Interval/%d/')
        url = BASE + endpoint + '?path=' + folder + prefix + '-' + stamp + '.csv'
        try:
            path, source = fetch_url(kind + '-interval-' + stamp, url, SOURCE_TYPES[kind][2] + ' · ' + iso(end), day, cache_dir, refresh)
            return end, path, source, None
        except (OSError, ValueError) as error:
            return end, None, None, str(error)

    sources, price_rows, prices, constraints, windows, errors = [], [], [], [], [], []
    with ThreadPoolExecutor(max_workers=2) as pool:
        for expected_end, path, source, error in pool.map(acquire, endpoints):
            if error:
                errors.append(iso(expected_end) + ': ' + error)
                continue
            try:
                if kind == 'bc':
                    events, observed_windows = parse_constraints(path, day, source['id'])
                    if any(row['end'] != iso(expected_end) for row in observed_windows):
                        raise ValueError('Constraint interval file does not match its timestamp')
                    constraints.extend(events)
                    windows.extend(observed_windows)
                else:
                    handle, rows = reader(path)
                    file_rows = []
                    with handle:
                        if not {'GMTIntervalEnd', 'Pnode', 'MCC', 'BAA'}.issubset(rows.fieldnames):
                            raise ValueError('Unrecognized SPP interval LMP columns')
                        for row in rows:
                            end = utc_field(row['GMTIntervalEnd'])
                            if end != expected_end:
                                raise ValueError('LMP interval file does not match its timestamp')
                            if row['BAA'].strip() != 'SPP' or not row['MCC'].strip():
                                continue
                            node = row['Pnode'].strip()
                            if not node:
                                raise ValueError('Missing SPP interval PNODE')
                            file_rows.append(dict(start=iso(end-timedelta(minutes=5)), end=iso(end), node=node, value=number(row['MCC']), sourceIds=[source['id']]))
                    price_rows.extend(file_rows)
                    if expected_end.minute == 0:
                        prices.extend(hourly_price_spreads(price_rows, 'SPP', 'real_time', 'native_locations', 'SPP East unique public PNODEs (generation, load and aggregate locations)'))
                        price_rows = []
                sources.append(source)
            except (OSError, ValueError, csv.Error) as parse_error:
                errors.append(iso(expected_end) + ': ' + str(parse_error))
    if price_rows:
        prices.extend(hourly_price_spreads(price_rows, 'SPP', 'real_time', 'native_locations', 'SPP East unique public PNODEs (generation, load and aggregate locations)'))
    return sources, prices, merge_intervals(constraints, ['assetId', 'contingency', 'binding']), merge_intervals(windows, ['region']), errors


def parse_prices(path, day, source_id):
    """Deduplicate PNODEs, retain signed MCC, form complete hourly node means."""
    handle, rows = reader(path)
    start_day, end_day = day_bounds(day)
    output, hour_rows = [], []
    current_hour = None
    with handle:
        fields = set(rows.fieldnames)
        utc_name = 'GMT Interval' if 'GMT Interval' in fields else 'GMTIntervalEnd'
        node_name = 'PNODE Name' if 'PNODE Name' in fields else 'Pnode'
        if not {utc_name, node_name, 'MCC', 'BAA'}.issubset(fields):
            raise ValueError('Unrecognized SPP LMP columns')
        for row in rows:
            if row['BAA'].strip() != 'SPP':
                continue
            end = utc_field(row[utc_name])
            if end.minute % 5 or end.second:
                raise ValueError('SPP RTBM timestamp is not a five-minute boundary')
            start = end - timedelta(minutes=5)
            if not start_day <= start < end <= end_day:
                raise ValueError('LMP interval outside requested operating day')
            hour = start.replace(minute=0, second=0, microsecond=0)
            if current_hour is not None and hour < current_hour:
                raise ValueError('SPP daily LMP rows are not chronological')
            if current_hour is not None and hour != current_hour:
                output.extend(hourly_price_spreads(hour_rows, 'SPP', 'real_time', 'native_locations', 'SPP East unique public PNODEs (generation, load and aggregate locations)'))
                hour_rows = []
            current_hour = hour
            node = row[node_name].strip()
            if not node:
                raise ValueError('Missing SPP PNODE identity')
            # A missing value creates incomplete node-hour coverage; never zero.
            if not row['MCC'].strip():
                continue
            hour_rows.append(dict(start=iso(start), end=iso(end), node=node, value=number(row['MCC']), sourceIds=[source_id]))
    if hour_rows:
        output.extend(hourly_price_spreads(hour_rows, 'SPP', 'real_time', 'native_locations', 'SPP East unique public PNODEs (generation, load and aggregate locations)'))
    if not output:
        raise ValueError('No complete SPP East node-hours')
    return output


def merge_intervals(rows, keys):
    grouped = defaultdict(list)
    for row in rows:
        grouped[tuple(row[key] for key in keys)].append(row)
    result = []
    for items in grouped.values():
        current = None
        for row in sorted(items, key=lambda r: (r['start'], r['end'])):
            if current and row['start'] <= current['end']:
                current['end'] = max(current['end'], row['end'])
                current['sourceIds'] = sorted(set(current['sourceIds'] + row['sourceIds']))
            else:
                if current:
                    result.append(current)
                current = dict(row)
        if current:
            result.append(current)
    return sorted(result, key=lambda r: (r['start'], r.get('assetId', ''), r.get('contingency', '')))


def parse_constraints(path, day, source_id):
    handle, rows = reader(path)
    start_day, end_day = day_bounds(day)
    events, ends = [], set()
    with handle:
        required = {'GMTIntervalEnd', 'Constraint Name', 'NERCID', 'State', 'Interconnect', 'Contingent Facility'}
        if not required.issubset(rows.fieldnames):
            raise ValueError('Unrecognized SPP constraint columns')
        for row in rows:
            end = utc_field(row['GMTIntervalEnd'])
            if end.minute % 5 or end.second:
                raise ValueError('SPP constraint timestamp is not a five-minute boundary')
            start = end - timedelta(minutes=5)
            if not start_day <= start < end <= end_day:
                raise ValueError('Constraint interval outside requested operating day')
            # The full report covers both interconnects. Timestamps are retained
            # before filtering East events so absent East constraints are not lost.
            ends.add(end)
            if row['Interconnect'].strip() != 'E':
                continue
            state = row['State'].strip().upper()
            if state not in {'ACTIVATED', 'BINDING', 'BREACHED'}:
                raise ValueError('Unrecognized SPP constraint state: ' + state)
            if state == 'ACTIVATED':
                continue
            asset = row['Constraint Name'].strip()
            if not asset:
                raise ValueError('Missing SPP constraint name')
            events.append(dict(region='SPP', start=iso(start), end=iso(end), assetId=asset + ' [' + row['NERCID'].strip() + ']',
                               contingency=row['Contingent Facility'].strip(), binding=True, sourceIds=[source_id]))
    if not ends:
        raise ValueError('Empty SPP constraint report cannot prove complete coverage')
    windows = [dict(region='SPP', start=iso(end - timedelta(minutes=5)), end=iso(end), sourceIds=[source_id]) for end in sorted(ends)]
    return merge_intervals(events, ['assetId', 'contingency', 'binding']), merge_intervals(windows, ['region'])


def parse_load(path, day, source_id):
    handle, rows = reader(path)
    start_day, end_day = day_bounds(day)
    by_hour, partitions = defaultdict(dict), set()
    with handle:
        if not {'Market Hour', 'Balancing Area Name', 'Control Zone Name', 'Forecast Area Type', 'Load MW'}.issubset(rows.fieldnames):
            raise ValueError('Unrecognized SPP actual hourly-load columns')
        for row in rows:
            if row['Balancing Area Name'].strip() != 'SPP':
                continue
            end = utc_field(row['Market Hour'])
            if end.minute or end.second:
                raise ValueError('SPP actual-load timestamp is not an hourly boundary')
            if not start_day <= end - timedelta(hours=1) < end <= end_day:
                raise ValueError('Load interval outside requested operating day')
            partition = (row['Control Zone Name'].strip(), row['Forecast Area Type'].strip())
            if not partition[0] or partition[1] not in {'CF', 'NC'}:
                raise ValueError('Unknown SPP control-zone/forecast-area partition')
            partitions.add(partition)
            if not row['Load MW'].strip():
                continue
            value = number(row['Load MW'])
            if partition in by_hour[end] and by_hour[end][partition] != value:
                raise ValueError('Conflicting duplicate SPP actual-load component')
            by_hour[end][partition] = value
    result = []
    for end, values in sorted(by_hour.items()):
        if set(values) != partitions:
            continue
        total = sum(values.values())
        if total < 0:
            raise ValueError('Negative regional actual load')
        result.append(dict(region='SPP', start=iso(end - timedelta(hours=1)), end=iso(end), mw=total, sourceIds=[source_id]))
    if not result:
        raise ValueError('No complete actual-load hours')
    return result


def collect(start_date, end_date, cache_dir, refresh=False):
    fragment = empty_fragment('SPP')
    requested = list(dates(start_date, end_date))
    failures, successes = defaultdict(list), defaultdict(list)
    for day in requested:
        for kind in SOURCE_TYPES:
            try:
                path, source = fetch(kind, day, cache_dir, refresh)
                if kind == 'lmp':
                    fragment['priceIntervals'].extend(parse_prices(path, day, source['id']))
                elif kind == 'bc':
                    events, windows = parse_constraints(path, day, source['id'])
                    fragment['constraintIntervals'].extend(events)
                    fragment['constraintWindows'].extend(windows)
                else:
                    fragment['loadIntervals'].extend(parse_load(path, day, source['id']))
                fragment['sources'].append(source)
                successes[kind].append(day.isoformat())
            except (OSError, ValueError, csv.Error) as error:
                failures[kind].append(day.isoformat() + ': ' + str(error))
                # Archive lag should not hide the most recent complete day when
                # the public interval feed can substantiate it independently.
                retained_intervals = any(not path.stem.endswith('0000') for path in Path(cache_dir).glob(kind + '-interval-' + day.strftime('%Y%m%d') + '*.csv'))
                if kind in {'lmp', 'bc'} and (day == requested[-1] or retained_intervals):
                    sources, prices, events, windows, errors = latest_day_intervals(kind, day, cache_dir, refresh)
                    fragment['sources'].extend(sources)
                    fragment['priceIntervals'].extend(prices)
                    fragment['constraintIntervals'].extend(events)
                    fragment['constraintWindows'].extend(windows)
                    if prices or windows:
                        successes[kind].append(day.isoformat())
                        failures[kind][-1] += f'; recovered from {len(sources)} actual five-minute files; {len(errors)} missing/rejected interval files.'
    fragment['constraintIntervals'] = merge_intervals(fragment['constraintIntervals'], ['assetId', 'contingency', 'binding'])
    fragment['constraintWindows'] = merge_intervals(fragment['constraintWindows'], ['region'])
    expected_hours = sum((day_bounds(day)[1] - day_bounds(day)[0]).total_seconds() / 3600 for day in requested)
    covered_hours = {
        'lmp': len(fragment['priceIntervals']),
        'bc': sum((datetime.fromisoformat(row['end'].replace('Z', '+00:00')) - datetime.fromisoformat(row['start'].replace('Z', '+00:00'))).total_seconds() / 3600 for row in fragment['constraintWindows']),
        'load': len(fragment['loadIntervals']),
    }
    for kind, metric in [('lmp', 'price_spread'), ('bc', 'binding_duration'), ('load', 'load')]:
        successful = successes[kind]
        reason = f'Requested {start_date}–{end_date}; acquired data for {len(successful)}/{len(requested)} operating days. Observed temporal coverage {covered_hours[kind]:.3f}/{expected_hours:g} hours.'
        if successful:
            reason += f' Actual acquired dates: {successful[0]}–{successful[-1]}.'
        if kind == 'lmp':
            reason += ' Daily RTBM LMP archives publish with a roughly five-day delay; the most recent requested day can use actual public five-minute files. Each hourly value requires complete node observations. BAA SPP only, unique PNODEs, unweighted native-location cohort.'
        if kind == 'bc':
            reason += ' East interconnect only. BINDING and BREACHED count as binding; ACTIVATED does not. Denominator windows contain actual report timestamps; missing intervals are not zero-filled.'
        if kind == 'load':
            reason += ' Actual Load MW sums distinct SPP control-zone CF/NC partitions, never forecast columns or SWPW load.'
        if failures[kind]:
            reason += ' Missing/error dates: ' + '; '.join(failures[kind])
        actual_sources = [source for source in fragment['sources'] if source['id'].startswith('spp-' + kind + '-')]
        links = [actual_sources[-1]['url']] if actual_sources else [url_for(kind, requested[-1])]
        complete = len(successful) == len(requested) and not failures[kind] and abs(covered_hours[kind] - expected_hours) < 1e-8
        fragment['coverage'].append(dict(region='SPP', metric=metric, status='observed' if complete else 'partial' if successful else 'unavailable', reason=reason, sourceUrls=links))
    fragment['coverage'].extend([
        dict(region='SPP', metric='utilization', status='unavailable', reason='Public RTBM constraint files disclose limits, but no matched actual monitored-facility flow. Tie-flow totals cannot substitute for the same constraint flow/limit.', sourceUrls=['https://portal.spp.org/pages/rtbm-binding-constraints']),
        dict(region='SPP', metric='curtailment', status='unavailable', reason='No transmission-cause-specific curtailment interval series was acquired in this adapter.', sourceUrls=['https://portal.spp.org/pages/ver-curtailments']),
    ])
    fragment['notes'] = [
        'SPP East only: RTBM BAA=SPP, constraints Interconnect=E, actual load Balancing Area Name=SPP. SWPW has a separate reference basin and is not pooled.',
        'Duplicate settlement names sharing the same PNODE/MCC collapse to one node. The published file does not classify a comparable load-zone-only cohort; native_locations includes generation, load and aggregate points.',
        'Price metric is P90 minus P10 of complete hourly signed-MCC node means, not a mean of 5-minute spatial spreads and not absolute MCC.',
        'Constraint windows describe temporal coverage of complete downloaded reports, not an inventory of every physically monitored line or evidence of zero congestion in unpublished intervals.',
        'The binding metric combines binding and breached records; nonbinding activated constraints do not add binding duration. Monitored source/effective limits alone do not establish utilization.',
    ]
    return [fragment]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--cache-dir', default='.local/transmission/spp')
    parser.add_argument('--output', default='data/transmission-fragments/spp.json')
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    fragments = collect(args.start, args.end, args.cache_dir, args.refresh)
    output.write_text(json.dumps(fragments, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({key: len(fragments[0][key]) for key in ['sources', 'priceIntervals', 'constraintIntervals', 'constraintWindows', 'loadIntervals']}))
