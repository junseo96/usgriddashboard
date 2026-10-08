#!/usr/bin/env python3
"""Acquire official sources, validate NYISO scope, optionally publish authenticated imports.
Run reports/raw files are immutable; unsupported adapters never advance normalized state.
"""
import argparse
import copy
import datetime as dt
import fcntl
import hashlib
import http.client
import io
import json
import math
import os
from pathlib import Path
import posixpath
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zipfile
from lbnl import discover_lbnl_workbook, parse_lbnl, workbook_source_as_of

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 32 * 1024 * 1024
XML_LIMIT = 96 * 1024 * 1024
NYISO = 'nyiso-load-register'
DEFAULT_SOURCES = [NYISO, 'lbnl-generation-storage-queues']
NS = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
HEADERS = ['Queue Number', 'Developer Name', 'Project: Project Name', 'IR Submission Date', 'Peak MW load', 'End-Use', 'Record Type Name', 'Type/Fuel', 'County', 'State', 'NYISO Zone', 'Points of Interconnection', 'CTO/Utility', 'Affected Transmission Owner (ATO)', 'Project Status #', 'SIS Bundle', 'Last Updated Date', 'Availability of Studies', 'IA Tender Date', 'FS Completion Date', 'Proposed Initial Backfeed Date']
# Exact public legend is a schema contract. A change requires review, never silent remapping.
STATUSES = {'0': 'Withdrawn', '1': 'Scoping Meeting Pending', '2': 'FES Pending', '3': 'FES in Progress', '3A': 'FES Approved/Performed', '4': 'SRIS/SIS Pending', '5': 'SRIS/SIS in Progress', '5P': 'SRIS Commenced, Stopped and Pending Adoption of IP', '6': 'SRIS/SIS Approved', '7': 'FS Pending', '8': 'Rejected Cost Allocation/Next FS Pending', '9': 'FS in Progress', '10': 'Accepted Cost Allocation/IA in Progress', '11': 'IA Completed', '12': 'Under Construction', '13': 'In Service for Test', '14': 'In Service Commercial', '15': 'Partial In-Service', 'P': 'Pending Adoption of IP Compliance with Order 2023'}
STATES = set('AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def encode(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode()


def write_atomic(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_bytes(encode(value))
    temp.replace(path)


def valid_url(url, api=False):
    value = urllib.parse.urlsplit(url)
    if value.username or value.password or value.fragment or not value.hostname:
        raise ValueError('Invalid URL or embedded credentials')
    loopback = value.hostname in ('127.0.0.1', 'localhost', '::1')
    if value.scheme != 'https' and not (api and loopback and value.scheme == 'http'):
        raise ValueError('HTTPS required (HTTP allowed only for loopback API)')
    if api and (value.query or value.path not in ('', '/')):
        raise ValueError('API URL must be an origin without query, path or credentials')
    return url.rstrip('/') if api else url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        valid_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('API redirect refused')


def fetch(url, timeout=20, opener=None):
    valid_url(url)
    opener = opener or urllib.request.build_opener(SafeRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    request = urllib.request.Request(url, headers={'User-Agent': 'GridAtlas/1.0 official-source-monitor'})
    # Two bounded attempts. Any partial body is discarded and cannot become current state.
    for attempt in range(2):
        try:
            with opener.open(request, timeout=timeout) as response:
                final_url = response.geturl()
                valid_url(final_url)
                length = response.headers.get('Content-Length')
                expected = int(length) if length else None
                if expected is not None and expected > MAX_BYTES:
                    raise ValueError('Source exceeds maximum download size')
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES or not data:
                    raise ValueError('Empty or oversized source')
                if expected is not None and len(data) != expected:
                    raise http.client.IncompleteRead(data, expected - len(data))
                return data, {'url': url, 'finalUrl': final_url, 'retrievedAt': now(), 'contentType': response.headers.get('Content-Type'), 'lastModified': response.headers.get('Last-Modified'), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        except (urllib.error.URLError, http.client.HTTPException, TimeoutError, OSError):
            if attempt:
                raise


def workbook_rows(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(entry.file_size for entry in archive.infolist()) > XML_LIMIT:
            raise ValueError('Expanded workbook too large')
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = [s for s in workbook.findall('x:sheets/x:sheet', NS) if s.get('name') == 'Load Projects']
        if len(sheets) != 1:
            raise ValueError('Exactly one Load Projects sheet required')
        rid = sheets[0].get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        relations = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        targets = [r for r in relations if r.get('Id') == rid and r.get('TargetMode') != 'External']
        if len(targets) != 1:
            raise ValueError('Invalid worksheet relationship')
        target = targets[0].get('Target', '')
        path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
        if not path.startswith('xl/'):
            raise ValueError('Worksheet path outside workbook')
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('x:si', NS)]
        rows = []
        for row in ET.fromstring(archive.read(path)).findall('x:sheetData/x:row', NS):
            cells = {}
            for cell in row.findall('x:c', NS):
                match = re.fullmatch(r'([A-Z]+)\d+', cell.get('r', ''))
                if not match or cell.find('x:f', NS) is not None or cell.get('t') == 'e':
                    raise ValueError('Formula, error or invalid worksheet cell')
                value = cell.findtext('x:v', None, NS)
                if cell.get('t') == 's' and value is not None:
                    value = strings[int(value)]
                elif cell.get('t') == 'inlineStr':
                    value = ''.join(cell.find('x:is', NS).itertext())
                if value is not None and value.strip():
                    cells[match[1]] = value.strip()
            if cells:
                rows.append(cells)
        return rows


def parse_nyiso(data, source):
    rows = workbook_rows(data)
    headers = [i for i, r in enumerate(rows) if 'Queue Number' in r.values()]
    endings = [i for i, r in enumerate(rows) if 'End-Use Key' in r.values()]
    if len(headers) != 1 or len(endings) != 1 or headers[0] >= endings[0]:
        raise ValueError('Complete worksheet boundaries not found')
    start, end = headers[0], endings[0]
    columns = rows[start]
    if len(columns) != len(HEADERS) or set(columns.values()) != set(HEADERS):
        raise ValueError('NYISO 21-column schema changed')
    notes = ' '.join(' '.join(r.values()) for r in rows[end:])
    match = re.search(r'Project status # Key:(.*?)(?:[●•]\s*Availability of Studies|$)', notes, re.I)
    if not match:
        raise ValueError('Complete official status legend missing')
    legend = {}
    for entry in re.split(r',\s*(?=(?:\d+[A-Z]?|P)\s*=)', match[1]):
        part = re.fullmatch(r'\s*(\d+[A-Z]?|P)\s*=\s*(.*?)\s*,?\s*', entry)
        if not part:
            raise ValueError('Ambiguous status legend')
        label = ' '.join(part[2].split())
        if part[1] in legend and legend[part[1]] != label:
            raise ValueError('Conflicting duplicate status legend')
        legend[part[1]] = label
    if legend != STATUSES:
        raise ValueError('Official status meanings changed; review required')
    projects, originals, seen = [], [], set()
    for row in rows[start + 1:end]:
        if set(row) - set(columns):
            raise ValueError('Unexpected source columns')
        values = {field: row.get(column) for column, field in columns.items()}
        identity = values['Queue Number']
        if not identity or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', identity) or identity in seen:
            raise ValueError('Missing, invalid or duplicate queue ID')
        seen.add(identity)
        if values['Record Type Name'] != 'Load Interconnection' or values['Type/Fuel'] != 'L':
            raise ValueError('Changed source scope')
        status_code = values['Project Status #']
        if status_code not in STATUSES or not values['Project: Project Name']:
            raise ValueError('Unknown status or missing project name')
        raw_mw = values['Peak MW load']
        mw = None if raw_mw is None or raw_mw.lower() in ('n.a.', 'n/a', 'unknown', 'tbd') else float(raw_mw)
        if mw is not None and (not math.isfinite(mw) or mw < 0):
            raise ValueError('Invalid load MW')
        state = {'New York': 'NY'}.get(values['State'], values['State'])
        status = 'withdrawn' if status_code == '0' else 'operational' if status_code == '14' else 'active'
        eligible = status == 'active' and state in STATES
        projects.append(dict(id='NYISO::' + identity, sourceId=NYISO, sourceRecordId=identity,
                             name=values['Project: Project Name'], types=['load'], region='NYISO', state=state,
                             status=status, generationMw=None, storageMw=None, loadMw=mw,
                             capacityStatus='unknown' if mw is None else 'known', eligible=eligible,
                             exclusionReason=None if eligible else '종료 또는 본토 위치 미확인', sourceUrl=source['url'],
                             sourceAsOf=None, rawStatus=STATUSES[status_code], identityScope='source_record'))
        originals.append(values)
    if not projects or (source.get('recordCount') and len(projects) < source['recordCount'] / 2):
        raise ValueError('Empty or unexpectedly reduced full scope requires manual review')
    return projects, originals


def api_post(origin, path, payload, token):
    valid_url(origin, api=True)
    request = urllib.request.Request(origin + path, data=encode(payload), method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(request, timeout=20) as response:
        body = response.read(4 * 1024 * 1024 + 1)
        if len(body) > 4 * 1024 * 1024:
            raise ValueError('API response too large')
        return json.loads(body)


def error_summary(exc):
    # Do not persist exception URL/header/body or environment tokens.
    return ('HTTP ' + str(exc.code)) if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__ + ': acquisition/validation/API failed'


def run(args):
    registry = {s['id']: s for s in json.loads((ROOT / 'data/source-registry.json').read_text())}
    targets = list(dict.fromkeys(args.source_id or DEFAULT_SOURCES))
    if any(s not in registry for s in targets):
        raise ValueError('Unknown source ID')
    token = os.environ.get('GRID_ATLAS_ADMIN_TOKEN', '')
    origin = valid_url(args.api_url, api=True) if args.api_url else None
    if origin and not token:
        raise ValueError('GRID_ATLAS_ADMIN_TOKEN required for API writes')
    root = args.state_dir
    root.mkdir(parents=True, exist_ok=True)
    lock = (root / 'collector.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise ValueError('Another collector is already running')
    try:
        state_path = root / 'state.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        run_id = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8]
        folder = root / 'runs' / run_id
        folder.mkdir(parents=True)
        (root / 'raw').mkdir(exist_ok=True)
        report = {'id': run_id, 'startedAt': now(), 'finishedAt': None, 'cadence': args.cadence, 'status': 'running', 'results': [], 'errors': []}
        imported = False
        for source_id in targets:
            source = copy.deepcopy(registry[source_id])
            result = {'sourceId': source_id}
            try:
                if source['coverage'] == 'not_public':
                    result['status'] = 'skipped_private'
                    report['results'].append(result)
                    continue
                data, manifest = fetch(source['url'])
                def archive_raw(body, metadata):
                    path = root / 'raw' / (metadata['sha256'] + '.bin')
                    if not path.exists():
                        with path.open('xb') as stream:
                            stream.write(body)
                    elif hashlib.sha256(path.read_bytes()).hexdigest() != metadata['sha256']:
                        raise ValueError('Archived hash mismatch')
                    return str(path.relative_to(root))
                result.update(manifest=manifest, rawPath=archive_raw(data, manifest))
                if source['adapter'] == 'lbnl_active_xlsx_v1':
                    result.update(indexManifest=manifest, indexRawPath=result['rawPath'])
                    workbook_url = discover_lbnl_workbook(data, source['url'])
                    data, manifest = fetch(workbook_url)
                    result.update(manifest=manifest, rawPath=archive_raw(data, manifest))
                    projects, raw_rows = parse_lbnl(data, {**source, 'workbookUrl': workbook_url})
                    source_as_of = workbook_source_as_of(data, workbook_url)
                elif source['adapter'] == 'nyiso_xlsx_v1':
                    projects, raw_rows = parse_nyiso(data, source)
                    source_as_of = None
                else:
                    result['status'] = 'parser_review'
                    result['reason'] = 'Raw acquisition only; no validated complete-scope adapter. Dataset unchanged.'
                    report['results'].append(result)
                    continue
                if projects:
                    source.update(sourceAsOf=source_as_of, lastCheckedAt=manifest['retrievedAt'], recordCount=len(projects))
                    payload = {'sourceId': source_id, 'projects': projects, 'source': source, 'completeScope': True,
                               'retrievedAt': manifest['retrievedAt'], 'sourceSha256': manifest['sha256']}
                    write_atomic(folder / (source_id + '-source-rows.json'), raw_rows)
                    write_atomic(folder / (source_id + '-import.json'), payload)
                    result.update(status='normalized', projectCount=len(projects), eligibleCount=sum(p['eligible'] for p in projects),
                                  normalizedSha256=hashlib.sha256(encode(projects)).hexdigest(), sourceAsOf=source_as_of)
                    if origin:
                        api_post(origin, '/api/import', payload, token)
                        result['status'] = 'imported'
                        imported = True
                    state[source_id] = {'retrievedAt': manifest['retrievedAt'], 'rawSha256': manifest['sha256'],
                                        'normalizedSha256': result['normalizedSha256'], 'runId': run_id,
                                        'projectCount': len(projects), 'importedToApi': bool(origin)}
                    write_atomic(state_path, state)
            except (OSError, ValueError, KeyError, IndexError, TypeError, OverflowError, zipfile.BadZipFile, ET.ParseError, http.client.HTTPException) as exc:
                result.update(status='failed', error=error_summary(exc))
            report['results'].append(result)
        if origin and imported:
            try:
                snapshot = api_post(origin, '/api/snapshots', {'trigger': 'scheduled'}, token)
                report['snapshotId'] = snapshot.get('id') or snapshot.get('snapshot', {}).get('id')
            except (OSError, ValueError, http.client.HTTPException) as exc:
                report['errors'].append('snapshot: ' + error_summary(exc))
        done = sum(r['status'] in ('normalized', 'imported') for r in report['results'])
        report['status'] = 'success' if done == len(targets) and not report['errors'] else 'partial' if done else 'failed'
        report['finishedAt'] = now()
        if origin:
            try:
                api_post(origin, '/api/runs', {k: report[k] for k in ('id', 'startedAt', 'finishedAt', 'status')} | {
                    'details': json.dumps({'cadence': args.cadence, 'results': report['results'], 'errors': report['errors']}, ensure_ascii=False)}, token)
                report['apiRunRecorded'] = True
            except (OSError, ValueError, http.client.HTTPException) as exc:
                report['apiRunRecorded'] = False
                report['errors'].append('run-record: ' + error_summary(exc))
                report['status'] = 'partial' if done else 'failed'
        write_atomic(folder / 'report.json', report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0 if report['status'] == 'success' else 1
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-id', action='append')
    parser.add_argument('--cadence', choices=['weekly', 'monthly'], default='weekly')
    parser.add_argument('--api-url', help='Explicit API origin; bearer secret read from GRID_ATLAS_ADMIN_TOKEN')
    parser.add_argument('--state-dir', type=Path, default=ROOT / '.local/collection')
    args = parser.parse_args()
    try:
        return run(args)
    except (ValueError, OSError) as exc:
        print(json.dumps({'status': 'failed', 'error': error_summary(exc)}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
