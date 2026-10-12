#!/usr/bin/env python3
"""Discover facilities through source parsers, validate, and preserve real observations.

The output is a public facility inventory, not a verified grid-application queue.
Parsers fetch official indexes/lists anew; byte-only monitoring is not used here.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

APP = Path(__file__).resolve().parents[1]
GROUPS = ('operators', 'hyperscale', 'industrial')
STATUSES = {'planned', 'construction', 'operating', 'paused', 'cancelled', 'unknown'}
TIMED_FIELDS = ('name', 'operator', 'sector', 'region', 'state', 'county', 'city', 'lat', 'lon',
                'identityKind', 'parentId', 'lifecycle', 'asOf', 'capacityFacts', 'gridEvidence', 'events')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(path)


def publish_checked(files):
    """Stage every validated public file before replacing any, with rollback."""
    prepared, originals, applied = {}, {}, []
    try:
        for path, value in files.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            originals[path] = path.read_bytes() if path.exists() else None
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as handle:
                handle.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
                prepared[path] = Path(handle.name)
        for path, staged in prepared.items():
            staged.replace(path)
            applied.append(path)
    except OSError:
        for path in reversed(applied):
            if originals[path] is None:
                path.unlink(missing_ok=True)
            else:
                path.write_bytes(originals[path])
        raise
    finally:
        for staged in prepared.values():
            staged.unlink(missing_ok=True)


def validate_fragment(fragment, group, previous=None, decisions=()):
    """Reject empty/error pages, fabricated retrieval metadata, and silent deletions.

    The application builder performs the complete shared-schema validation too.
    """
    if not isinstance(fragment, dict) or fragment.get('schemaVersion') != 1 or fragment.get('id') != group:
        raise ValueError('Invalid source fragment identity/schema')
    if not isinstance(fragment.get('facilities'), list) or not fragment['facilities']:
        raise ValueError('A successful source group must contain facilities')
    if not isinstance(fragment.get('sources'), list) or not fragment['sources']:
        raise ValueError('Source group has no acquired evidence')
    sources = {}
    for source in fragment['sources']:
        if not isinstance(source, dict) or not isinstance(source.get('id'), str) or source['id'] in sources:
            raise ValueError('Duplicate or malformed source identity')
        url = urlsplit(source.get('url', ''))
        if url.scheme != 'https' or not url.hostname or url.username or url.password:
            raise ValueError('Non-public source URL')
        sha = source.get('sha256', '')
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in '0123456789abcdef' for c in sha):
            raise ValueError('Missing actual source digest')
        try:
            instant = dt.datetime.fromisoformat(source['retrievedAt'].replace('Z', '+00:00'))
            if instant.tzinfo is None or instant > dt.datetime.now(dt.timezone.utc):
                raise ValueError('Invalid source retrieval time')
        except (KeyError, TypeError, AttributeError):
            raise ValueError('Missing actual source retrieval time') from None
        sources[source['id']] = source
    ids = set()
    for facility in fragment['facilities']:
        if not isinstance(facility, dict):
            raise ValueError('Malformed facility record')
        identifier = facility.get('id')
        if not isinstance(identifier, str) or not identifier or identifier in ids:
            raise ValueError('Duplicate or missing facility identity')
        ids.add(identifier)
        if facility.get('lifecycle') not in STATUSES:
            raise ValueError('Unknown facility lifecycle')
        evidence = facility.get('sourceIds')
        if not isinstance(evidence, list) or not evidence or any(v not in sources for v in evidence):
            raise ValueError('Facility has no exact source references')
    if previous:
        missing = {f['id'] for f in previous['facilities']} - ids
        # Only a reviewed same-entity decision can remove an old row, and its
        # canonical facility must survive in this candidate. Ordinary aliases,
        # possible duplicates and missing canonical rows are not permission.
        # The shared builder still validates every decision's source evidence.
        for decision in decisions:
            members = decision.get('facilityIds', [])
            if decision.get('kind') == 'same_entity' and len(members) >= 2 and members[0] in ids:
                missing.difference_update(members[1:])
        if missing:
            raise ValueError(f'Source parser dropped {len(missing)} previous facilities; retain and review absent rows')


def field_value(facility, key):
    value = facility.get(key)
    if key in ('capacityFacts', 'gridEvidence', 'events') and isinstance(value, list):
        # A parser can version its evidence IDs after reacquisition. Repeated
        # observations of the same facts are not new progress events.
        value = sorted(({k: v for k, v in item.items() if k not in ('id', 'sourceIds')} for item in value), key=canonical)
    return canonical(value)


def observed_changes(group, previous, current, observed_at):
    """Record when a difference was observed; never turn it into an event date."""
    before = {f['id']: f for f in (previous or {}).get('facilities', [])}
    changes = []
    for facility in current['facilities']:
        old = before.get(facility['id'])
        if old is None:
            kind, changed = 'facility_discovered', ['facility']
        else:
            changed = [key for key in TIMED_FIELDS if field_value(old, key) != field_value(facility, key)]
            # New provenance hashes or retrieval times alone are not project progress.
            if not changed:
                continue
            kind = 'lifecycle_changed' if 'lifecycle' in changed else 'facility_details_changed'
        change = {'sourceGroup': group, 'facilityId': facility['id'], 'observedAt': observed_at,
                  'kind': kind, 'changedFields': changed,
                  'previousLifecycle': old.get('lifecycle') if old else None,
                  'lifecycle': facility['lifecycle'], 'sourceAsOf': facility.get('asOf'),
                  'sourceIds': facility['sourceIds'],
                  'note': 'Actual acquisition comparison; observedAt is not the date construction, operation, or application began.'}
        change['id'] = 'facility-observation:' + hashlib.sha256(canonical(change).encode()).hexdigest()[:24]
        changes.append(change)
    return changes


def execute(command, *, timeout):
    return subprocess.run(command, cwd=APP, capture_output=True, text=True, timeout=timeout, check=False)


def collect(args, runner=execute):
    args.state_dir.mkdir(parents=True, exist_ok=True)
    with (args.state_dir / 'collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another facility collection is already using this state directory') from None
        return collect_locked(args, runner)


def collect_locked(args, runner):
    started = now()
    run_id = started.replace(':', '').replace('-', '').replace('.', '')
    run_dir = args.state_dir / 'runs' / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    groups = list(GROUPS) if args.source == 'all' else [args.source]
    report = {'schemaVersion': 1, 'runId': run_id, 'startedAt': started, 'finishedAt': None,
              'status': 'running', 'mode': 'official_source_facility_discovery',
              'sourceGroups': [], 'discoveredCount': 0, 'lifecycleChangeCount': 0,
              'detailChangeCount': 0, 'publishedFilesUpdated': False,
              'limitations': ['Facility discovery does not establish a grid application or nationwide completeness.',
                              'Missing/failed sources preserve previous records; no facility is retired merely because a listing disappears.',
                              'Observation time is distinct from a dated source milestone.']}
    previous_observations = read(args.observations) if args.observations.exists() else {'schemaVersion': 1, 'observations': []}
    if previous_observations.get('schemaVersion') != 1 or not isinstance(previous_observations.get('observations'), list):
        raise ValueError('Invalid preserved facility observations')
    adopted = {}
    updates = []
    with tempfile.TemporaryDirectory(prefix='grid-atlas-facilities-', dir=run_dir) as temporary:
        stage = Path(temporary)
        fragments = stage / 'fragments'
        fragments.mkdir()
        for old in sorted(args.fragments.glob('*.json')):
            shutil.copy2(old, fragments / old.name)
        for group in groups:
            item = {'id': group, 'status': 'failed', 'previousCount': 0, 'facilityCount': 0,
                    'discoveredCount': 0, 'lifecycleChangeCount': 0, 'detailChangeCount': 0}
            group_dir = run_dir / group
            group_dir.mkdir()
            destination = fragments / (group + '.json')
            previous = read(destination) if destination.exists() else None
            item['previousCount'] = len(previous['facilities']) if previous else 0
            began = time.monotonic()
            try:
                script = APP / 'scripts/facility-sources' / (group + '.py')
                if not script.is_file():
                    raise ValueError('Source parser is not installed')
                result = runner(['python3', str(script), '--output', str(destination), '--state-dir', str(group_dir)], timeout=args.parser_timeout)
                # Preserve the exact, still-unvalidated parser output before the
                # staging directory is cleaned or a failed candidate rolled back.
                if destination.is_file():
                    shutil.copy2(destination, group_dir / 'normalized-fragment.json')
                (group_dir / 'stdout.log').write_text(result.stdout[-65536:])
                (group_dir / 'stderr.log').write_text(result.stderr[-65536:])
                parser_report = read(group_dir / 'report.json')
                item['sourceReport'] = parser_report
                if result.returncode != 0 or not isinstance(parser_report, dict) or parser_report.get('status') not in ('success', 'partial'):
                    raise ValueError('Source parser reported failure; previous fragment retained')
                candidate = read(destination)
                decisions_path = APP / 'data/large-load-facility-decisions.json'
                decisions = read(decisions_path).get('decisions', []) if decisions_path.exists() else []
                validate_fragment(candidate, group, previous, decisions)
                changes = observed_changes(group, previous, candidate, now())
                item.update(status=parser_report['status'], facilityCount=len(candidate['facilities']),
                            discoveredCount=sum(e['kind'] == 'facility_discovered' for e in changes),
                            lifecycleChangeCount=sum(e['kind'] == 'lifecycle_changed' for e in changes),
                            detailChangeCount=sum(e['kind'] == 'facility_details_changed' for e in changes))
                adopted[group] = candidate
                updates.extend(changes)
            except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
                item['error'] = type(error).__name__ + ': ' + str(error)[:1500]
                item['facilityCount'] = item['previousCount']
                if previous is not None:
                    write(destination, previous)
                else:
                    destination.unlink(missing_ok=True)
            item['durationSeconds'] = round(time.monotonic() - began, 3)
            report['sourceGroups'].append(item)
        if adopted:
            try:
                dataset = stage / 'large-load-facilities.json'
                command = ['node', 'scripts/build-large-load-facilities.ts', '--input-dir', str(fragments),
                           '--manifest-input-dir', str(args.fragments.resolve()), '--output', str(dataset)]
                if args.output.exists():
                    command += ['--previous', str(args.output)]
                result = runner(command, timeout=180)
                (run_dir / 'builder-stdout.log').write_text(result.stdout[-65536:])
                (run_dir / 'builder-stderr.log').write_text(result.stderr[-65536:])
                if result.returncode != 0 or not dataset.is_file():
                    raise ValueError('Shared facility builder rejected staged data; all published files retained')
                # All parsing and shared validation finishes before changing public data.
                built = read(dataset)
                observations = {**previous_observations, 'generatedAt': now(),
                                'observations': previous_observations['observations'] + updates}
                publish_checked({**{args.fragments / (group + '.json'): candidate for group, candidate in adopted.items()},
                                 args.output: built, args.observations: observations})
                report['publishedFilesUpdated'] = True
                report['discoveredCount'] = sum(e['kind'] == 'facility_discovered' for e in updates)
                report['lifecycleChangeCount'] = sum(e['kind'] == 'lifecycle_changed' for e in updates)
                report['detailChangeCount'] = sum(e['kind'] == 'facility_details_changed' for e in updates)
                report['status'] = 'success' if all(g['status'] == 'success' for g in report['sourceGroups']) else 'partial'
            except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
                report.update(status='failed', error=type(error).__name__ + ': ' + str(error)[:1500])
        else:
            report['status'] = 'failed'
    report['finishedAt'] = now()
    write(run_dir / 'report.json', report)
    write(args.report, report)
    print(canonical({key: report[key] for key in ('status', 'runId', 'discoveredCount', 'lifecycleChangeCount', 'detailChangeCount', 'publishedFilesUpdated')}))
    return 0 if report['publishedFilesUpdated'] else 1


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=('all', *GROUPS), default='all')
    parser.add_argument('--fragments', type=Path, default=APP / 'data/large-load-facility-fragments')
    parser.add_argument('--output', type=Path, default=APP / 'data/large-load-facilities.json')
    parser.add_argument('--observations', type=Path, default=APP / 'data/large-load-facility-observations.json')
    parser.add_argument('--report', type=Path, default=APP / 'data/large-load-facility-collection.json')
    parser.add_argument('--state-dir', type=Path, default=APP / '.local/facility-collection')
    parser.add_argument('--parser-timeout', type=int, default=720)
    args = parser.parse_args()
    if not 1 <= args.parser_timeout <= 1200:
        parser.error('--parser-timeout must be 1..1200 seconds')
    return args


if __name__ == '__main__':
    raise SystemExit(collect(arguments()))
