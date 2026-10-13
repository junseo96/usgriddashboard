"""EIA-930 reported actual hourly loads for matching congestion-price hours.

Reuses the existing reviewed EIA parser: no imputed/forecast data; also excludes
source quality flags for this analytical denominator. UTC timestamps are HE.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import urllib.parse

from transmission_common import empty_fragment, iso, stamp

PATH = Path(__file__).with_name('collect-demand.py')
SPEC = importlib.util.spec_from_file_location('demand_for_transmission', PATH)
DEMAND = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DEMAND)


def collect(start_date: date, end_date: date, cache_dir: Path, refresh=False):
    cache_dir = Path(cache_dir) / 'eia'
    cache_dir.mkdir(parents=True, exist_ok=True)
    params = {f'respondent[{index}]': value[0] for index, value in enumerate(DEMAND.REGIONS.values())}
    params.update({'type[0]': 'D', 'frequency': 'hourly',
                   'start': (start_date - timedelta(days=1)).strftime('%m%d%Y 00:00:00'),
                   'end': (end_date + timedelta(days=2)).strftime('%m%d%Y 00:00:00'),
                   'timezone': 'UTC', 'limit': '50000'})
    url = DEMAND.EIA_ENDPOINT + '?' + urllib.parse.urlencode(params)
    key = hashlib.sha256(url.encode()).hexdigest()
    raw_path, meta_path = cache_dir / (key+'.bin'), cache_dir / (key+'.json')
    if raw_path.exists() and meta_path.exists() and not refresh:
        raw, metadata = raw_path.read_bytes(), json.loads(meta_path.read_text())
        if hashlib.sha256(raw).hexdigest() != metadata['sha256']:
            raise ValueError('EIA cached source hash mismatch')
    else:
        fetcher = DEMAND.ArchivedFetcher(cache_dir / 'raw')
        raw = fetcher(url)
        metadata = dict(id='eia930-transmission-'+key[:16], title='EIA-930 reported actual hourly balancing-authority demand',
                        publisher='U.S. Energy Information Administration', url=url,
                        retrievedAt=iso(datetime.now(timezone.utc)), sha256=hashlib.sha256(raw).hexdigest(), sourceAsOf=None)
        raw_path.write_bytes(raw)
        meta_path.write_text(json.dumps(metadata, indent=2)+'\n')
    parsed = DEMAND.parse_eia(raw, datetime.now(timezone.utc), url)
    fragments = []
    for region in DEMAND.REGIONS:
        fragment = empty_fragment(region)
        fragment['sources'] = [metadata]
        source = parsed.get(region, {})
        for point in source.get('series', []):
            if point.get('quality'):
                continue
            end = stamp(point['observedAt'])
            fragment['loadIntervals'].append(dict(region=region, start=iso(end-timedelta(hours=1)), end=iso(end),
                                                  mw=point['mw'], sourceIds=[metadata['id']], basis='EIA-930 reported actual; unflagged', priority=1))
        fragment['notes'] = source.get('warnings', []) + ['가중 분모에는 원천 품질 플래그가 없는 실제 신고 부하만 사용한다.']
        fragment['coverage'] = [dict(region=region, metric='load', status='observed' if fragment['loadIntervals'] else 'unavailable',
                                     reason='동일 UTC 시간의 EIA-930 실제 신고 부하. 추정·대체·품질 플래그 값은 제외.', sourceUrls=[url])]
        fragments.append(fragment)
    return fragments


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', required=True)
    parser.add_argument('--end', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--refresh', action='store_true')
    args = parser.parse_args()
    app = Path(__file__).resolve().parents[1]
    result = collect(date.fromisoformat(args.start), date.fromisoformat(args.end), app/'.local/transmission', args.refresh)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'))+'\n')
    print(json.dumps({row['region']: len(row['loadIntervals']) for row in result}))
