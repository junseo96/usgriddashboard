"""PJM's anonymous official LMP map, separate from dated interval series.

The map explicitly exposes PRICE, MLC_VALUE and MCC_VALUE for transmission
zones. It exposes no market timestamp or averaging interval. Acquisition time
is therefore only capturedAt, never a manufactured hourly operating time.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import urllib.request

from transmission_common import empty_fragment, iso, number, quantile

PAGE = 'https://www.pjm.com/library/maps/lmp-map.aspx'
LAYER = 'https://mapservices.pjm.com/arcgis/rest/services/Interregional/LMP/MapServer/1'
QUERY = LAYER + '/query?where=1%3D1&outFields=*&returnGeometry=false&f=json'
MAX_BYTES = 2_000_000


def fetch(url, cache_dir, refresh=False):
    folder = Path(cache_dir) / 'pjm-snapshot'
    folder.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()[:20]
    receipt = folder / (key + '.json')
    if not refresh and receipt.exists():
        meta = json.loads(receipt.read_text())
        blob = (folder / (meta['sha256'] + '.bin')).read_bytes()
        if meta['url'] != url or hashlib.sha256(blob).hexdigest() != meta['sha256']:
            raise ValueError('PJM snapshot cache integrity mismatch')
        return blob, meta
    request = urllib.request.Request(url, headers={'User-Agent': 'GridAtlas/1.0 public official-map research'})
    with urllib.request.urlopen(request, timeout=30) as response:
        blob = response.read(MAX_BYTES + 1)
        if len(blob) > MAX_BYTES:
            raise ValueError('PJM public map exceeds acquisition limit')
    meta = dict(url=url, retrievedAt=iso(datetime.now(timezone.utc)),
                sha256=hashlib.sha256(blob).hexdigest(), bytes=len(blob))
    (folder / (meta['sha256'] + '.bin')).write_bytes(blob)
    receipt.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + '\n')
    return blob, meta


def parse_snapshot(blob, source_id, captured_at):
    payload = json.loads(blob)
    if 'error' in payload or payload.get('exceededTransferLimit'):
        raise ValueError('PJM map response is unavailable or truncated')
    fields = {item['name'] for item in payload.get('fields', [])}
    required = {'ZONE_OPS_KEY', 'OPS_ZONE_NAME', 'MCC_VALUE', 'PRICE', 'MLC_VALUE'}
    if not required <= fields or not isinstance(payload.get('features'), list):
        raise ValueError('PJM map component schema changed')
    nodes, seen = [], set()
    for feature in payload['features']:
        row = feature['attributes']
        identifier, name = row.get('ZONE_OPS_KEY'), row.get('OPS_ZONE_NAME')
        if identifier is None or not isinstance(name, str) or not name.strip() or identifier in seen:
            raise ValueError('PJM zone identity missing or duplicated')
        seen.add(identifier)
        if row.get('MCC_VALUE') is None:
            continue
        value = number(row['MCC_VALUE'])
        nodes.append(dict(node=str(identifier), name=name, mcc=value))
    if len(nodes) < 2:
        raise ValueError('PJM map has fewer than two disclosed congestion components')
    values = [row['mcc'] for row in nodes]
    p10, p90 = quantile(values, .1), quantile(values, .9)
    return dict(region='PJM', market='RT', population='load_zones',
                populationLabel='PJM 공식 현재 LMP 지도 · 송전 존 동일 가중',
                sourceObservedAt=None, capturedAt=iso(captured_at),
                p10=p10, p90=p90, value=p90-p10, min=min(values), max=max(values),
                nodeCount=len(nodes), candidateNodeCount=len(seen), quantileMethod='linear-type7',
                sourceIds=[source_id], nodes=nodes,
                note='공식 지도의 공개 MCC 스냅샷. 원자료 시장시각·평균 구간은 제공되지 않는다. 취득시각을 운영시각으로 바꾸거나 시간·일 평균 및 전국 가중평균에 포함하지 않는다. P90−P10이 0이어도 일부 존의 혼잡 성분 차이는 존재할 수 있어 최솟값·최댓값도 함께 보존한다.')


def collect(start_date=None, end_date=None, cache_dir='.local/transmission', refresh=False):
    result = empty_fragment('PJM')
    result['priceSnapshots'] = []
    sources = []
    try:
        # The public page documents that this is a transmission-zone LMP map,
        # and its own popup labels MCC_VALUE as Congestion, separately from MLC.
        page, meta = fetch(PAGE, cache_dir, refresh)
        page_text = page.decode('utf-8-sig')
        if 'MCC_VALUE' not in page_text or 'Congestion:' not in page_text or 'transmission zone' not in page_text:
            raise ValueError('PJM official map no longer identifies zone congestion components')
        sources.append(dict(id='pjm-public-lmp-map-definition', title='PJM public LMP map — transmission-zone congestion component definition', publisher='PJM Interconnection', sourceAsOf=None, **meta))
        layer_blob, layer_meta = fetch(LAYER + '?f=pjson', cache_dir, refresh)
        layer = json.loads(layer_blob)
        if layer.get('name') != 'PJM Zones':
            raise ValueError('PJM public map layer changed')
        sources.append(dict(id='pjm-public-lmp-map-layer', title='PJM Zones public ArcGIS layer schema', publisher='PJM Interconnection', sourceAsOf=None, **layer_meta))
        blob, meta = fetch(QUERY, cache_dir, refresh)
        source_id = 'pjm-public-lmp-map-' + meta['sha256'][:16]
        sources.append(dict(id=source_id, title='PJM public LMP map — zone MCC snapshot; market timestamp undisclosed', publisher='PJM Interconnection', sourceAsOf=None, **meta))
        snapshot = parse_snapshot(blob, source_id, meta['retrievedAt'])
        snapshot['sourceIds'] = [source['id'] for source in sources]
        result['priceSnapshots'].append(snapshot)
        status = 'partial'
        reason = '공식 공개 지도에서 존별 MCC 현재 스냅샷을 확보했다. 시장시각과 평균 구간이 없어 요청 기간의 시간별 관측 또는 전국 시간 가중평균에 포함하지 않는다. Data Miner 시간별 원자료는 별도 인증이 필요하다.'
    except (OSError, ValueError, KeyError, TypeError) as error:
        status, reason = 'access_blocked', f'공식 공개 MCC 지도 취득·검증 실패: {type(error).__name__}: {error}'
    result['sources'] = sources
    result['coverage'].append(dict(region='PJM', metric='price_spread', status=status, reason=reason, sourceUrls=[PAGE, QUERY]))
    result['notes'].append('PJM 공개 지도에는 MCC와 MLC가 별도 존재한다. PRICE 전체의 산포를 혼잡 성분으로 대신하지 않는다. 시각 미공개 스냅샷은 시간별 계열과 분리한다.')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', default='.local/transmission')
    parser.add_argument('--refresh', action='store_true')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    fragment = collect(cache_dir=args.cache_dir, refresh=args.refresh)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(fragment, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(dict(region='PJM', priceSnapshots=len(fragment['priceSnapshots']), coverage=fragment['coverage'])))
