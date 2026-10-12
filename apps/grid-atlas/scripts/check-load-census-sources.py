#!/usr/bin/env python3
"""Read-only byte-change monitoring of the census's public evidence URLs.

This does not parse projects, refresh their as-of dates, or change any scores.
Only a previous successful run of this monitor is a comparable byte baseline.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
from pathlib import Path
import socket
import ssl
import threading
import time
from urllib.parse import urljoin, urlsplit, urlunsplit
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
USER_AGENT = 'GridAtlasSourceMonitor/1.0 (+https://github.com/junseo96/usgriddashboard)'
REDIRECTS = {301, 302, 303, 307, 308}


class FetchError(Exception):
    def __init__(self, code, http_status=None):
        self.code, self.http_status = code, http_status
        super().__init__(code)


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def public_url(url):
    """Validate URL syntax before resolution; fragments are not sent to servers."""
    if not isinstance(url, str) or len(url) > 8192 or any(ord(c) < 33 for c in url) or '\\' in url:
        raise FetchError('unsafe_url')
    try:
        parsed = urlsplit(url)
        host = (parsed.hostname or '').lower().rstrip('.')
        if parsed.scheme != 'https' or not host or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError()
        if host == 'localhost' or host.endswith(('.localhost', '.local', '.internal')) or ('.' not in host and ':' not in host):
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address is not None and (not address.is_global or address.is_multicast or address.is_reserved):
            raise ValueError()
        # Force a well-defined ASCII hostname. Keep public path/query identifiers intact.
        host = host.encode('idna').decode('ascii')
        netloc = '[' + host + ']' if ':' in host else host
        return urlunsplit(('https', netloc, parsed.path or '/', parsed.query, ''))
    except (ValueError, UnicodeError):
        raise FetchError('unsafe_url') from None


def public_addresses(host):
    try:
        addresses = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
    except OSError:
        raise FetchError('dns_failed') from None
    parsed = [ipaddress.ip_address(address) for address in addresses]
    if not parsed or any(not address.is_global or address.is_multicast or address.is_reserved for address in parsed):
        raise FetchError('nonpublic_address')
    return addresses


class PublicHTTPSConnection(http.client.HTTPSConnection):
    """Pin the connection to a validated address; TLS still verifies the hostname."""
    def __init__(self, host, address, timeout):
        super().__init__(host, timeout=timeout, context=ssl.create_default_context())
        self.public_address = address

    def connect(self):
        raw = socket.create_connection((self.public_address, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class Budget:
    def __init__(self, total_bytes, seconds):
        self.remaining_bytes = total_bytes
        self.deadline = time.monotonic() + seconds
        self.lock = threading.Lock()

    def charge(self, size):
        with self.lock:
            if time.monotonic() >= self.deadline:
                raise FetchError('run_time_limit')
            if size > self.remaining_bytes:
                raise FetchError('run_byte_limit')
            self.remaining_bytes -= size


def fetch(url, *, budget, timeout, max_bytes):
    deadline = min(budget.deadline, time.monotonic() + timeout)
    current = public_url(url)
    visited = set()
    for _ in range(5):
        budget.charge(0)
        if current in visited:
            raise FetchError('redirect_loop')
        visited.add(current)
        parsed = urlsplit(current)
        addresses = public_addresses(parsed.hostname)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchError('request_time_limit')
        connection = PublicHTTPSConnection(parsed.hostname, addresses[0], remaining)
        try:
            path = urlunsplit(('', '', parsed.path, parsed.query, ''))
            connection.request('GET', path, headers={'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', 'Accept': '*/*'})
            response = connection.getresponse()
            if response.status in REDIRECTS:
                location = response.getheader('Location')
                if not location:
                    raise FetchError('redirect_without_location', response.status)
                current = public_url(urljoin(current, location))
                continue
            if response.status != 200:
                # No retry, alternate host, login, browser challenge or anti-bot bypass.
                raise FetchError('http_error', response.status)
            content_length = response.getheader('Content-Length')
            try:
                expected = int(content_length) if content_length is not None else None
            except ValueError:
                raise FetchError('invalid_content_length') from None
            if expected is not None and (expected < 0 or expected > max_bytes):
                raise FetchError('source_byte_limit')
            digest, size = hashlib.sha256(), 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise FetchError('request_time_limit')
                if connection.sock is not None:
                    connection.sock.settimeout(remaining)
                # read1 returns available bytes instead of waiting to fill a chunk,
                # allowing deadline checks even when a source sends a slow stream.
                chunk = response.read1(min(64 * 1024, max_bytes - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                budget.charge(len(chunk))
                if size > max_bytes:
                    raise FetchError('source_byte_limit')
                digest.update(chunk)
            if expected is not None and size != expected:
                raise FetchError('truncated_response')
            if not size:
                raise FetchError('empty_response')
            return {'retrievedAt': utc_now(), 'sha256': digest.hexdigest(), 'bytes': size,
                    'finalUrl': current, 'httpStatus': response.status,
                    'contentType': response.getheader('Content-Type'),
                    'etag': response.getheader('ETag'), 'lastModified': response.getheader('Last-Modified')}
        except (OSError, http.client.HTTPException):
            raise FetchError('network_or_tls_error') from None
        finally:
            connection.close()
    raise FetchError('redirect_limit')


def source_manifest(census):
    if census.get('schemaVersion') != 1 or not isinstance(census.get('evidence'), list):
        raise ValueError('Unsupported or missing census evidence schema')
    sources = {}
    for evidence in census['evidence']:
        url = evidence['url']
        try:
            key = public_url(url)
        except FetchError:
            key = url
        source = sources.setdefault(key, {'url': key, 'evidenceIds': [], 'sourceFamilies': [], 'historicalEvidence': []})
        source['evidenceIds'].append(evidence['id'])
        if evidence['sourceFamily'] not in source['sourceFamilies']:
            source['sourceFamilies'].append(evidence['sourceFamily'])
        source['historicalEvidence'].append({'id': evidence['id'], 'retrievedAt': evidence.get('retrievedAt'),
                                            'sha256': evidence.get('sha256'), 'sourceAsOf': evidence.get('sourceAsOf')})
    return sorted(sources.values(), key=lambda item: item['url'])


def check_source(source, previous, *, fetcher, budget, timeout, max_bytes):
    result = {**source, 'checkedAt': utc_now(), 'status': 'fetch_failed', 'observation': None,
              'previousObservation': previous.get('observation') if previous else None,
              'reviewRequired': bool(previous and previous.get('reviewRequired'))}
    try:
        public_url(source['url'])
        observation = fetcher(source['url'], budget=budget, timeout=timeout, max_bytes=max_bytes)
        old = result['previousObservation']
        result['status'] = 'baseline' if old is None else ('unchanged' if old['sha256'] == observation['sha256'] else 'changed')
        result['observation'] = observation
        result['reviewRequired'] = result['reviewRequired'] or result['status'] in ('baseline', 'changed')
    except FetchError as error:
        result['errorCode'], result['httpStatus'] = error.code, error.http_status
        if error.code in ('unsafe_url', 'nonpublic_address'):
            result['status'] = 'blocked_url'
        elif error.code.startswith('run_'):
            result['status'] = 'skipped_budget'
    return result


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def run(args, fetcher=fetch):
    started = utc_now()
    data = args.input.read_bytes()
    census = json.loads(data)
    sources = source_manifest(census)
    state_path = args.state_dir / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {'schemaVersion': 1, 'sources': {}}
    if state.get('schemaVersion') != 1 or not isinstance(state.get('sources'), dict):
        raise ValueError('Unsupported monitor state; preserve it and choose a new state directory')
    # Oldest or never-checked URLs first so a bounded run does not starve later URLs.
    sources.sort(key=lambda source: (state['sources'].get(source['url'], {}).get('checkedAt', ''), source['url']))
    selected, deferred = sources[:args.max_sources], sources[args.max_sources:]
    budget = Budget(args.max_total_bytes, args.max_seconds)
    host_locks = {urlsplit(s['url']).hostname: threading.Lock() for s in selected}

    def work(source):
        # At most one request per origin at a time; total concurrency is also bounded.
        with host_locks[urlsplit(source['url']).hostname]:
            return check_source(source, state['sources'].get(source['url']), fetcher=fetcher,
                                budget=budget, timeout=args.timeout, max_bytes=args.max_bytes)

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        results = list(executor.map(work, selected))
    results.extend({**s, 'checkedAt': None, 'status': 'skipped_limit', 'observation': None,
                    'reviewRequired': None, 'previousObservation': state['sources'].get(s['url'], {}).get('observation')} for s in deferred)
    for result in results:
        if result['status'] == 'skipped_limit':
            continue
        last = state['sources'].get(result['url'], {})
        state['sources'][result['url']] = {'checkedAt': result['checkedAt'], 'status': result['status'],
            'observation': result['observation'] or last.get('observation'),
            'reviewRequired': result['reviewRequired']}
    counts = dict(sorted(Counter(r['status'] for r in results).items()))
    succeeded = sum(counts.get(status, 0) for status in ('baseline', 'unchanged', 'changed'))
    report = {'schemaVersion': 1, 'startedAt': started, 'finishedAt': utc_now(),
              'censusGeneratedAt': census.get('generatedAt'), 'censusSha256': hashlib.sha256(data).hexdigest(),
              'status': 'complete' if succeeded == len(sources) else ('partial' if succeeded else 'failed'),
              'mode': 'read_only_byte_monitor', 'uniqueUrls': len(sources), 'counts': counts,
              'limits': {key: getattr(args, key) for key in ('max_sources', 'workers', 'timeout', 'max_bytes', 'max_total_bytes', 'max_seconds')},
              'results': sorted(results, key=lambda r: r['url']),
              'limitations': [
                  'Byte equality/change is not evidence of project progress, semantic change, or unchanged project data.',
                  'Historical census evidence hashes are provenance only; the baseline is a previous successful monitor download.',
                  'First downloads establish baselines. Changed and first-seen documents require human review; this monitor never clears that requirement.',
                  'Failed or skipped checks retain the last successful observation without refreshing its acquisition timestamp.',
                  'Only census evidence URLs are checked. This is not a crawl of all utilities or a project dataset refresh.',
                  'Downloaded bytes are hashed, not retained. Reports preserve metadata; reviewed research archives remain separate.',
              ]}
    run_id = started.replace('-', '').replace(':', '').replace('.', '') + '-' + uuid4().hex[:8]
    write_json(args.state_dir / 'runs' / run_id / 'report.json', report)
    write_json(args.state_dir / 'latest-report.json', report)
    write_json(state_path, state)
    print(json.dumps({'status': report['status'], 'uniqueUrls': len(sources), 'counts': counts,
                      'report': str(args.state_dir / 'latest-report.json')}))
    return 0 if succeeded else 1


def bounded_int(low, high):
    def parse(value):
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f'must be between {low} and {high}')
        return number
    return parse


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=ROOT / 'data/load-project-census.json')
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.local/census-source-monitor')
    parser.add_argument('--max-sources', type=bounded_int(1, 2000), default=1000)
    parser.add_argument('--workers', type=bounded_int(1, 4), default=3)
    parser.add_argument('--timeout', type=bounded_int(1, 45), default=25)
    parser.add_argument('--max-bytes', type=bounded_int(1, 32 * 1024 * 1024), default=20 * 1024 * 1024)
    parser.add_argument('--max-total-bytes', type=bounded_int(1, 512 * 1024 * 1024), default=192 * 1024 * 1024)
    parser.add_argument('--max-seconds', type=bounded_int(1, 900), default=780)
    return parser.parse_args()


if __name__ == '__main__':
    raise SystemExit(run(arguments()))
