"""Append-only ERCOT aggregate observations from the public Kardashev API.

These are provider extractions of ERCOT reports, not individual applications and
not independently verified official figures. No inferred rows or scores.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE_URL = 'https://data.kardashevlabs.org/ercot/large-load'
ENDPOINTS = {name: f'{BASE_URL}/{name}' for name in ('history', 'latest')}
MAX_BYTES = 8 * 1024 * 1024
MAX_ROWS = 20000
RAW_FIELDS = {
    'snapshot_month', 'report_date', 'total_mw', 'colocated_mw', 'standalone_mw',
    'by_status', 'by_size_bucket', 'by_type', 'by_zone',
    'approved_to_energize_mw', 'planning_studies_approved_mw', 'trailing_12mo',
    'source_url', 'extracted_at',
}
FIELD_MAP = {
    'snapshot_month': 'snapshotMonth', 'report_date': 'reportDate',
    'total_mw': 'totalMw', 'colocated_mw': 'colocatedMw', 'standalone_mw': 'standaloneMw',
    'by_status': 'byStatus', 'by_size_bucket': 'bySizeBucket', 'by_type': 'byType',
    'by_zone': 'byZone', 'approved_to_energize_mw': 'approvedToEnergizeMw',
    'planning_studies_approved_mw': 'planningStudiesApprovedMw',
    'trailing_12mo': 'trailing12mo', 'source_url': 'sourceUrl',
    'extracted_at': 'providerExtractedAt',
}


class CollectionError(ValueError):
    """An acquisition/validation failure that must preserve previous observations."""


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def strict_json(body: bytes):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise CollectionError(f'duplicate JSON key: {key}')
            result[key] = value
        return result
    try:
        return json.loads(body, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(CollectionError('nonfinite JSON number')))
    except (ValueError, UnicodeDecodeError) as exc:
        raise CollectionError(f'invalid JSON: {exc}') from exc


def date(value, field, month=False):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise CollectionError(f'{field}: expected YYYY-MM-DD')
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as exc:
        raise CollectionError(f'{field}: invalid date') from exc
    if month and parsed.day != 1:
        raise CollectionError(f'{field}: expected first day of observation month')
    return value


def timestamp(value, field, nullable=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})', value):
        raise CollectionError(f'{field}: expected timezone-aware ISO timestamp')
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as exc:
        raise CollectionError(f'{field}: invalid timestamp') from exc
    if parsed.utcoffset() is None:
        raise CollectionError(f'{field}: timestamp needs timezone')
    return value


def number(value, field, *, nullable=True, count=False, percentage=False):
    if value is None and nullable:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise CollectionError(f'{field}: expected nonnegative finite number' + (' or null' if nullable else ''))
    if count and int(value) != value:
        raise CollectionError(f'{field}: expected integer count')
    if percentage and value > 100:
        raise CollectionError(f'{field}: percentage exceeds 100')
    return int(value) if count else float(value)


def mapping(value, field):
    if value is None:
        return None
    if not isinstance(value, dict) or len(value) > 1000:
        raise CollectionError(f'{field}: expected bounded object or null')
    for key in value:
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9_ .-]{1,100}', key):
            raise CollectionError(f'{field}: invalid category key')
    return value


def source_url(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r'[\x00-\x20\\]', value):
        raise CollectionError('source_url: invalid URL')
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise CollectionError('source_url: invalid host or port') from exc
    if (parsed.scheme != 'https' or parsed.hostname not in {'ercot.com', 'www.ercot.com'}
            or parsed.username or parsed.password or port not in (None, 443)
            or parsed.query or parsed.fragment or not parsed.path.startswith('/files/docs/')):
        raise CollectionError('source_url: expected an HTTPS ERCOT original report, no credentials or query')
    return value


def warning(code, detail, **amounts):
    return {'code': code, 'severity': 'warning', 'detail': detail, **amounts}


def quality_issues(fields):
    result = []
    total = fields['totalMw']
    def compare(values, code, detail):
        known = [value for value in values if value is not None]
        if known and not math.isclose(sum(known), total, rel_tol=0, abs_tol=0.000001):
            result.append(warning(code, detail, reportedSumMw=sum(known), expectedMw=total))
    stages = fields['byStatus']
    if stages is None or not stages or any(value is None for value in stages.values()):
        result.append(warning('stages_incomplete', 'Provider stage table is absent or contains unknown categories; no complete stage score is derived.'))
    if stages:
        compare(stages.values(), 'stages_total_mismatch', 'Reported stage amounts do not reconcile to the headline. Missing categories, scope, report revision, rounding or extraction require source review; values are preserved. ERCOT 9.4/9.5 categories are not inferred. ')
    sizes = fields['bySizeBucket']
    if sizes:
        compare([row['mw'] for row in sizes.values()], 'size_total_mismatch', 'Reported size buckets do not reconcile to the headline; bucket counts are aggregate source counts, not identified projects.')
    types = fields['byType']
    if types:
        compare([row['mw'] for row in types.values()], 'type_total_mismatch', 'Reported type amounts do not reconcile to the headline; provider extraction may calculate rounded percentage × total.')
        result.append(warning('type_capacity_derivation_unverified', 'Type MW may be derived from chart percentages by the provider; not independently verified requested capacity per customer.'))
    zones = fields['byZone']
    if zones:
        result.append(warning('zone_scope_unverified', 'Reported zones are not a verified complete allocation of the regional total; do not use them as a complete ERCOT zone denominator.', reportedSumMw=sum(value for value in zones.values() if value is not None), expectedMw=total))
    if fields['colocatedMw'] is not None and fields['standaloneMw'] is not None:
        compare([fields['colocatedMw'], fields['standaloneMw']], 'colocated_total_mismatch', 'Colocated and standalone amounts do not reconcile to the headline; values preserved for source review.')
    trailing = fields['trailing12mo'] or {}
    key = fields['snapshotMonth'][:7]
    if trailing.get(key) is not None and trailing[key] != total:
        result.append(warning('current_trend_total_mismatch', 'Report trailing table differs from its snapshot headline; preserve the two original values.', reportedSumMw=trailing[key], expectedMw=total))
    if trailing:
        result.append(warning('trend_vintage_difference', 'Trailing-month figures belong to this report vintage and can restate earlier reports. Do not mix report vintages into a month-on-month change.'))
    return result


def normalize(raw, receipt):
    if not isinstance(raw, dict):
        raise CollectionError('observation must be an object')
    extra = set(raw) - RAW_FIELDS
    if extra:
        raise CollectionError(f'unreviewed provider fields: {sorted(extra)}')
    out = {
        'snapshotMonth': date(raw.get('snapshot_month'), 'snapshot_month', month=True),
        'reportDate': date(raw.get('report_date'), 'report_date'),
        'sourceUrl': source_url(raw.get('source_url')),
        'providerExtractedAt': timestamp(raw.get('extracted_at'), 'extracted_at', nullable=True),
    }
    timestamp(receipt['fetchedAt'], 'receipt.fetchedAt')
    if out['snapshotMonth'] > out['reportDate']:
        raise CollectionError('snapshot_month is after report_date')
    if out['reportDate'] > receipt['fetchedAt'][:10]:
        raise CollectionError('report_date is in the future')
    if out['providerExtractedAt'] and dt.datetime.fromisoformat(out['providerExtractedAt'].replace('Z', '+00:00')) > dt.datetime.fromisoformat(receipt['fetchedAt'].replace('Z', '+00:00')):
        raise CollectionError('provider extraction timestamp is after acquisition')
    for raw_key in ('total_mw', 'colocated_mw', 'standalone_mw', 'approved_to_energize_mw', 'planning_studies_approved_mw'):
        out[FIELD_MAP[raw_key]] = number(raw.get(raw_key), raw_key, nullable=raw_key != 'total_mw')
    for raw_key in ('by_status', 'by_zone'):
        entries = mapping(raw.get(raw_key), raw_key)
        out[FIELD_MAP[raw_key]] = None if entries is None else {key: number(value, f'{raw_key}.{key}') for key, value in entries.items()}
    for raw_key, extra_key in (('by_size_bucket', 'count'), ('by_type', 'pct')):
        entries = mapping(raw.get(raw_key), raw_key)
        out[FIELD_MAP[raw_key]] = None
        if entries is not None:
            normalized = {}
            for key, value in entries.items():
                # Older size tables expose MW as a scalar, with no count.
                if raw_key == 'by_size_bucket' and (value is None or type(value) in (int, float)):
                    value = {'mw': value, 'count': None}
                if not isinstance(value, dict) or set(value) - {'mw', extra_key}:
                    raise CollectionError(f'{raw_key}.{key}: unsupported bucket schema')
                normalized[key] = {'mw': number(value.get('mw'), f'{raw_key}.{key}.mw'), extra_key: number(value.get(extra_key), f'{raw_key}.{key}.{extra_key}', count=extra_key == 'count', percentage=extra_key == 'pct')}
            out[FIELD_MAP[raw_key]] = normalized
    trailing = mapping(raw.get('trailing_12mo'), 'trailing_12mo')
    out['trailing12mo'] = None
    if trailing is not None:
        out['trailing12mo'] = {}
        for key, value in trailing.items():
            if not re.fullmatch(r'\d{4}-\d{2}', key):
                raise CollectionError('trailing_12mo: expected YYYY-MM keys')
            date(key + '-01', 'trailing_12mo month', month=True)
            if key > out['snapshotMonth'][:7]:
                raise CollectionError('trailing_12mo contains a future month relative to snapshot')
            out['trailing12mo'][key] = number(value, f'trailing_12mo.{key}')
    payload_hash = sha(canonical(out))
    record_id = 'kardashev:' + sha(canonical([out['sourceUrl'], out['snapshotMonth'], out['reportDate'], payload_hash]))
    return {
        'id': record_id, 'region': 'ERCOT', 'scope': 'regional_aggregate', **out,
        'fetchedAt': receipt['fetchedAt'], 'payloadSha256': payload_hash,
        'receipt': {key: receipt[key] for key in ('url', 'fetchedAt', 'sha256')},
        'verification': 'provider_extraction_unverified', 'qualityIssues': quality_issues(out),
    }


def validate_receipt(receipt, full=False):
    if not isinstance(receipt, dict) or receipt.get('url') not in ENDPOINTS.values():
        raise CollectionError('receipt endpoint is not an approved public API URL')
    timestamp(receipt.get('fetchedAt'), 'receipt.fetchedAt')
    digest = receipt.get('sha256')
    if digest is not None and (not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest)):
        raise CollectionError('receipt SHA256 invalid')
    if not full and digest is None:
        raise CollectionError('observation needs a raw response SHA256')
    if full:
        status = receipt.get('httpStatus')
        if status is not None and (type(status) is not int or not 100 <= status <= 599):
            raise CollectionError('receipt HTTP status invalid')
        number(receipt.get('bytes'), 'receipt.bytes', nullable=False, count=True)
        number(receipt.get('recordCount'), 'receipt.recordCount', count=True)


def validate_dataset(data):
    if not isinstance(data, dict) or data.get('schemaVersion') != 1 or data.get('provider') != 'kardashev':
        raise CollectionError('unsupported load API dataset schema')
    timestamp(data.get('generatedAt'), 'generatedAt')
    records = data.get('records')
    if not isinstance(records, list) or len(records) > MAX_ROWS:
        raise CollectionError('records must be a bounded array')
    seen = set()
    for record in records:
        if not isinstance(record, dict) or record.get('region') != 'ERCOT' or record.get('scope') != 'regional_aggregate':
            raise CollectionError('unexpected record region or scope')
        if record.get('verification') != 'provider_extraction_unverified':
            raise CollectionError('provider extraction must retain unverified label')
        receipt = record.get('receipt')
        validate_receipt(receipt)
        expected = normalize({key: record.get(value) for key, value in FIELD_MAP.items()}, receipt)
        if record != expected:
            raise CollectionError('normalized record content, identity, timestamp or quality flags do not match')
        if record['id'] in seen:
            raise CollectionError('duplicate observation ID')
        seen.add(record['id'])
    collection = data.get('collection')
    if not isinstance(collection, dict) or collection.get('status') not in {'success', 'failed'}:
        raise CollectionError('invalid collection status')
    for key in ('startedAt', 'completedAt'):
        timestamp(collection.get(key), 'collection.' + key)
    timestamp(collection.get('lastSuccessAt'), 'collection.lastSuccessAt', nullable=True)
    if collection['startedAt'] > collection['completedAt']:
        raise CollectionError('collection completed before it started')
    number(collection.get('addedCount'), 'collection.addedCount', nullable=False, count=True)
    if collection['status'] == 'success' and (collection.get('error') is not None or collection.get('lastSuccessAt') != collection['completedAt']):
        raise CollectionError('successful collection needs success timestamp and no error')
    if collection['status'] == 'failed' and (not isinstance(collection.get('error'), str) or not collection['error'] or collection['addedCount'] != 0):
        raise CollectionError('failed collection needs error and zero added records')
    if not isinstance(collection.get('endpointReceipts'), list):
        raise CollectionError('endpointReceipts must be an array')
    for receipt in collection['endpointReceipts']:
        validate_receipt(receipt, full=True)
    if not isinstance(collection.get('warnings'), list) or any(not isinstance(value, str) for value in collection['warnings']):
        raise CollectionError('collection warnings must be strings')
    return data


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False, allow_nan=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise CollectionError('public API redirect rejected; endpoint change requires review')


def fetch_endpoint(url, destination, receipts, *, opener=None, retries=2, sleep=time.sleep):
    opener = opener or urllib.request.build_opener(NoRedirect())
    for attempt in range(retries):
        receipt = {'url': url, 'fetchedAt': now(), 'httpStatus': None, 'sha256': None, 'bytes': 0, 'recordCount': None}
        receipts.append(receipt)
        try:
            request = urllib.request.Request(url, headers={'Accept': 'application/json', 'User-Agent': 'GridAtlas-public-load-observations/1.0 (+https://github.com/junseo96/usgriddashboard)'})
            with opener.open(request, timeout=25) as response:
                receipt['httpStatus'] = response.status
                if response.status != 200:
                    raise CollectionError(f'public API HTTP {response.status}')
                length = response.headers.get('Content-Length')
                if length and (not length.isdigit() or int(length) > MAX_BYTES):
                    raise CollectionError('API body Content-Length invalid or too large')
                body = response.read(MAX_BYTES + 1)
                if len(body) > MAX_BYTES:
                    raise CollectionError('API body exceeds size limit')
                # Save bytes even when JSON/schema validation fails.
                digest = sha(body)
                destination.mkdir(parents=True, exist_ok=True)
                (destination / f'{digest}.json').write_bytes(body)
                receipt.update(sha256=digest, bytes=len(body), fetchedAt=now())
                if length and len(body) != int(length):
                    raise CollectionError('truncated API response')
                payload = strict_json(body)
                receipt['recordCount'] = len(payload) if isinstance(payload, list) else 1 if isinstance(payload, dict) else None
                return payload, receipt
        except urllib.error.HTTPError as exc:
            receipt['httpStatus'] = exc.code
            error = CollectionError(f'public API HTTP {exc.code}')
            retry = exc.code == 429 or 500 <= exc.code <= 599
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # Avoid echoing arbitrary response bodies or proxy credentials.
            error = CollectionError(f'public API transport failure ({type(exc).__name__})')
            retry = True
        except CollectionError as exc:
            error = exc
            retry = False
        if not retry or attempt == retries - 1:
            raise error
        sleep(min(2 ** attempt, 2))
    raise CollectionError('API request failed')


def merge(previous, history, latest, receipts):
    if not isinstance(history, list) or not 1 <= len(history) <= MAX_ROWS:
        raise CollectionError('history must contain a nonempty bounded array')
    history_receipt, latest_receipt = receipts
    incoming = [normalize(row, history_receipt) for row in history]
    current = normalize(latest, latest_receipt)
    latest_month = max(row['snapshotMonth'] for row in incoming)
    if current['snapshotMonth'] < latest_month:
        raise CollectionError('latest endpoint regressed behind history')
    if any(row['snapshotMonth'] == current['snapshotMonth'] and row['reportDate'] > current['reportDate'] for row in incoming):
        raise CollectionError('latest endpoint report date regressed behind history for its snapshot month')
    same_vintage = [row for row in incoming if (row['snapshotMonth'], row['sourceUrl'], row['reportDate']) == (current['snapshotMonth'], current['sourceUrl'], current['reportDate'])]
    if same_vintage and all(row['id'] != current['id'] for row in same_vintage):
        raise CollectionError('history and latest disagree within the same report vintage')
    old = previous.get('records', [])
    if old and current['snapshotMonth'] < max(row['snapshotMonth'] for row in old):
        raise CollectionError('latest endpoint regressed behind previously acquired observation month')
    if any(row['snapshotMonth'] == current['snapshotMonth'] and row['reportDate'] > current['reportDate'] for row in old):
        raise CollectionError('latest endpoint report date regressed behind previously acquired vintage')
    by_id = {row['id']: row for row in old}
    incoming_ids = {row['id'] for row in incoming + [current]}
    warnings = []
    missing = set(by_id) - incoming_ids
    if missing:
        warnings.append(f'{len(missing)} previously acquired report revision(s) absent from current API responses; preserved without retirement or deletion.')
    # History first keeps raw-response provenance for the report series; the
    # identical latest copy is not a new observation or a new first fetch time.
    for row in incoming + [current]:
        by_id.setdefault(row['id'], row)
    rows = sorted(by_id.values(), key=lambda row: (row['snapshotMonth'], row['reportDate'], row['fetchedAt'], row['id']))
    if len(rows) > MAX_ROWS:
        raise CollectionError('append-only dataset exceeds reviewed row limit')
    latest_source = max(row['reportDate'] for row in rows)
    if (dt.date.fromisoformat(now()[:10]) - dt.date.fromisoformat(latest_source)).days > 62:
        warnings.append(f'Latest source report date is {latest_source}; successful API acquisition does not make source observations current.')
    return rows, len(rows) - len(old), warnings


@contextlib.contextmanager
def collection_lock(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / 'collection.lock').open('a') as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise CollectionError('another load API collection is running') from exc
        yield


def collect(output, state_dir, *, fetcher=fetch_endpoint):
    output, state_dir = Path(output), Path(state_dir)
    with collection_lock(state_dir):
        previous = validate_dataset(strict_json(output.read_bytes())) if output.exists() else {'records': [], 'collection': {'lastSuccessAt': None}}
        started = now()
        run_id = started.replace('-', '').replace(':', '').replace('.', '') + '-' + uuid.uuid4().hex[:8]
        run_dir = state_dir / 'runs' / run_id
        run_dir.mkdir(parents=True)
        receipts = []
        error = None
        code = 0
        rows, added, warnings = previous['records'], 0, []
        try:
            history, history_receipt = fetcher(ENDPOINTS['history'], run_dir / 'raw', receipts)
            latest, latest_receipt = fetcher(ENDPOINTS['latest'], run_dir / 'raw', receipts)
            rows, added, warnings = merge(previous, history, latest, (history_receipt, latest_receipt))
        except CollectionError as exc:
            error, code = str(exc), 1
        except Exception as exc:
            error, code = f'unexpected collection failure ({type(exc).__name__})', 2
        completed = now()
        collection = {
            'startedAt': started, 'completedAt': completed,
            'status': 'success' if code == 0 else 'failed',
            'lastSuccessAt': completed if code == 0 else previous['collection']['lastSuccessAt'],
            'addedCount': added if code == 0 else 0, 'error': error,
            'endpointReceipts': receipts, 'warnings': warnings,
        }
        dataset = {'schemaVersion': 1, 'generatedAt': completed, 'provider': 'kardashev', 'records': rows if code == 0 else previous['records'], 'collection': collection}
        # Always report failed runs. Only the health envelope changes on failure;
        # previously validated observations and first-fetch provenance are exact.
        atomic_json(run_dir / 'report.json', {'runId': run_id, 'output': str(output), **collection})
        atomic_json(state_dir / 'last-run.json', {'runId': run_id, **collection})
        validate_dataset(dataset)
        atomic_json(output, dataset)
        return code, dataset
