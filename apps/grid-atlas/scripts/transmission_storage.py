"""Lossless, bounded-file storage for normalized operational observations.

One group metadata.json is the atomic commit point. It holds complete fragment
metadata, including source definitions and the latest coverage declarations.
Record partitions are per region and UTC ISO week of start/capturedAt. A window
crossing weeks is stored once, intact. Per-array positions preserve the original
record order on load. Content-addressed parts are written before the manifest;
old referenced parts and the legacy group.json are removed only after commit.
"""
from __future__ import annotations

from collections import defaultdict
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from transmission_common import stamp

GROUPS = ('load', 'midwest', 'northeast', 'pjm-snapshot', 'spp', 'west')
REGIONS = frozenset(('CAISO', 'ERCOT', 'PJM', 'MISO', 'SPP', 'NYISO', 'ISO-NE'))
ARRAYS = ('priceIntervals', 'priceSnapshots', 'constraintIntervals', 'constraintWindows',
          'loadIntervals', 'utilizationIntervals', 'curtailmentIntervals')
STORAGE_VERSION = 1
MAX_PART_BYTES = 16 * 1024 * 1024
PART_NAME = re.compile(r'\d{4}-W(?:0[1-9]|[1-4][0-9]|5[0-3])-\d{4}-[a-f0-9]{16}\.json')


def _paths(root, group):
    if not isinstance(group, str) or group not in GROUPS:
        raise ValueError('Unknown or unsafe transmission storage group')
    root = Path(root)
    if root.is_symlink():
        raise ValueError('Transmission storage root cannot be a symlink')
    directory, legacy = root / group, root / (group + '.json')
    if directory.is_symlink() or legacy.is_symlink():
        raise ValueError('Transmission storage group cannot be a symlink')
    return directory, legacy


def _part_path(directory, name):
    if not isinstance(name, str):
        raise ValueError('Invalid transmission partition path')
    pieces = name.split('/')
    if len(pieces) != 2 or pieces[0] not in REGIONS or not PART_NAME.fullmatch(pieces[1]):
        raise ValueError('Unsafe transmission partition path')
    parent, result = directory / pieces[0], directory / pieces[0] / pieces[1]
    if parent.is_symlink() or result.is_symlink():
        raise ValueError('Transmission partition cannot be a symlink')
    return result


def _encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True, allow_nan=False) + '\n').encode('utf-8')


def _atomic_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _fragments(document):
    fragments = document if isinstance(document, list) else [document]
    seen = set()
    for fragment in fragments:
        if not isinstance(fragment, dict) or fragment.get('region') not in REGIONS:
            raise ValueError('Invalid transmission fragment region')
        if fragment['region'] in seen:
            raise ValueError('Duplicate region within a transmission storage group')
        seen.add(fragment['region'])
        for kind in ARRAYS:
            if kind in fragment and not isinstance(fragment[kind], list):
                raise ValueError('Transmission observation collection must be an array')
    return fragments


def _manifest(directory, group):
    path = directory / 'metadata.json'
    if path.is_symlink():
        raise ValueError('Transmission metadata cannot be a symlink')
    document = json.loads(path.read_text())
    if not isinstance(document, dict) or document.get('storageVersion') != STORAGE_VERSION or document.get('group') != group or not isinstance(document.get('fragments'), list):
        raise ValueError('Invalid transmission storage manifest')
    seen = set()
    for item in document['fragments']:
        if not isinstance(item, dict) or not isinstance(item.get('fragment'), dict):
            raise ValueError('Invalid transmission fragment metadata')
        region = item['fragment'].get('region')
        if region not in REGIONS or region in seen:
            raise ValueError('Invalid or duplicate transmission metadata region')
        seen.add(region)
        if any(kind in item['fragment'] for kind in ARRAYS):
            raise ValueError('Observation records belong in partitions, not metadata')
        arrays = item.get('arrays')
        if not isinstance(arrays, list) or len(set(arrays)) != len(arrays) or any(kind not in ARRAYS for kind in arrays):
            raise ValueError('Invalid transmission array manifest')
        if not isinstance(item.get('parts'), list):
            raise ValueError('Invalid transmission partition manifest')
        part_names = set()
        for part in item['parts']:
            if not isinstance(part, dict):
                raise ValueError('Invalid transmission partition entry')
            path = _part_path(directory, part.get('path'))
            if path.parent.name != region or part['path'] in part_names:
                raise ValueError('Cross-region or duplicate transmission partition')
            part_names.add(part['path'])
            if not isinstance(part.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', part['sha256']):
                raise ValueError('Invalid transmission partition hash')
            if not path.name.endswith('-' + part['sha256'][:16] + '.json'):
                raise ValueError('Transmission partition name/hash mismatch')
            if not isinstance(part.get('bytes'), int) or isinstance(part['bytes'], bool) or part['bytes'] < 1:
                raise ValueError('Invalid transmission partition size')
    return document


def load_group(root: Path, group: str) -> list:
    """Read the legacy file, or reconstruct a committed partition manifest."""
    directory, legacy = _paths(root, group)
    if legacy.exists():
        return _fragments(json.loads(legacy.read_text()))
    if not (directory / 'metadata.json').exists():
        return []
    result = []
    for item in _manifest(directory, group)['fragments']:
        fragment = dict(item['fragment'])
        positioned = {kind: {} for kind in item['arrays']}
        for entry in item['parts']:
            blob = _part_path(directory, entry['path']).read_bytes()
            if len(blob) != entry['bytes'] or hashlib.sha256(blob).hexdigest() != entry['sha256']:
                raise ValueError('Transmission partition integrity mismatch')
            part = json.loads(blob)
            if part.get('storageVersion') != STORAGE_VERSION or part.get('group') != group or part.get('region') != fragment['region'] or part.get('sources') != []:
                raise ValueError('Transmission partition identity mismatch')
            positions = part.get('positions')
            if not isinstance(positions, dict) or set(positions) != {kind for kind in ARRAYS if kind in part}:
                raise ValueError('Invalid transmission partition positions')
            for kind, indexes in positions.items():
                rows = part[kind]
                if kind not in positioned or not isinstance(rows, list) or not isinstance(indexes, list) or len(rows) != len(indexes):
                    raise ValueError('Invalid transmission partition records')
                for index, row in zip(indexes, rows):
                    if not isinstance(index, int) or isinstance(index, bool) or index < 0 or index in positioned[kind]:
                        raise ValueError('Duplicate or invalid transmission record position')
                    if not isinstance(row, dict) or row.get('region') != fragment['region']:
                        raise ValueError('Cross-region transmission record')
                    positioned[kind][index] = row
        for kind, values in positioned.items():
            if set(values) != set(range(len(values))):
                raise ValueError('Missing transmission record positions')
            fragment[kind] = [values[index] for index in range(len(values))]
        result.append(fragment)
    return result


def _week(row, kind, region):
    if not isinstance(row, dict) or row.get('region') != region:
        raise ValueError('Cross-region transmission observation')
    try:
        moment = stamp(row['capturedAt'] if kind == 'priceSnapshots' else row['start'])
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError('Transmission record requires an explicit timestamp') from error
    year, week, _ = moment.isocalendar()
    return f'{year:04d}-W{week:02d}'


def _part(group, region, entries):
    result = dict(storageVersion=STORAGE_VERSION, group=group, region=region, sources=[], positions={})
    for kind, index, row in entries:
        result.setdefault(kind, []).append(row)
        result['positions'].setdefault(kind, []).append(index)
    return result


def _bounded_parts(group, region, entries):
    payload = _encode(_part(group, region, entries))
    if len(payload) <= MAX_PART_BYTES:
        yield payload
    elif len(entries) == 1:
        raise ValueError('Single transmission record exceeds partition size limit')
    else:
        midpoint = len(entries) // 2
        yield from _bounded_parts(group, region, entries[:midpoint])
        yield from _bounded_parts(group, region, entries[midpoint:])


def store_group(root: Path, group: str, fragments) -> None:
    """Atomically publish a lossless partition manifest, then remove old parts.

    Full validation/serialization occurs before writes. A failure writing a new
    part leaves the previous manifest and legacy inventory readable. Only files
    referenced by the previous owned manifest are eligible for cleanup.
    """
    directory, legacy = _paths(root, group)
    fragments = _fragments(fragments)
    old = _manifest(directory, group) if (directory / 'metadata.json').exists() else None
    old_parts = {part['path'] for item in old['fragments'] for part in item['parts']} if old else set()
    manifest = dict(storageVersion=STORAGE_VERSION, group=group, fragments=[])
    writes = {}
    for fragment in fragments:
        region = fragment['region']
        if (directory / region).is_symlink():
            raise ValueError('Transmission partition region cannot be a symlink')
        arrays = [kind for kind in ARRAYS if kind in fragment]
        item = dict(fragment={key: value for key, value in fragment.items() if key not in ARRAYS}, arrays=arrays, parts=[])
        weeks = defaultdict(list)
        for kind in arrays:
            for index, row in enumerate(fragment[kind]):
                weeks[_week(row, kind, region)].append((kind, index, row))
        for week, entries in sorted(weeks.items()):
            for index, payload in enumerate(_bounded_parts(group, region, entries), 1):
                if index > 9999:
                    raise ValueError('Too many transmission partitions in one week')
                digest = hashlib.sha256(payload).hexdigest()
                name = f'{region}/{week}-{index:04d}-{digest[:16]}.json'
                path = _part_path(directory, name)
                item['parts'].append(dict(path=name, sha256=digest, bytes=len(payload)))
                writes[name] = (path, payload)
        manifest['fragments'].append(item)
    manifest_bytes = _encode(manifest)
    # Content-addressed files never overwrite old different observations.
    for path, payload in writes.values():
        if path.exists():
            if path.read_bytes() != payload:
                raise ValueError('Transmission content-address collision')
        else:
            _atomic_write(path, payload)
    _atomic_write(directory / 'metadata.json', manifest_bytes)
    for name in old_parts - set(writes):
        path = _part_path(directory, name)
        if path.exists():
            path.unlink()
    if legacy.exists():
        legacy.unlink()


def gather_fragments(root: Path) -> list:
    """Gather only known collector groups, ignoring unrelated JSON/files."""
    return [fragment for group in GROUPS for fragment in load_group(root, group)]
