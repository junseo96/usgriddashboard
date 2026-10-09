#!/usr/bin/env python3
"""Rebuild NYISO load history from hash-verified archived official workbooks.

Usage: python3 scripts/build-historical-nyiso.py --archive-dir /path/to/history-nyiso
The directory contains retrieval-archives.json and raw/archive-TIMESTAMP.xlsx.
No network requests or database writes. Archive capture times are not source as-of dates.
"""
import argparse
from collections import Counter
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import posixpath
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile

from collect import NS, STATUSES, STATES

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = 'https://www.nyiso.com/documents/20142/1407078/NYISO-Interconnection-Queue.xlsx'
MODEL = 'stage-proxy-v1'
REQUIRED = {'Queue Pos.', 'Project Name', 'SP (MW)', 'WP (MW)', 'Type/ Fuel', 'State', 'S'}


def workbook_sheets(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(item.file_size for item in archive.infolist()) > 96 * 1024 * 1024:
            raise ValueError('Expanded workbook too large')
        strings = [''.join(node.itertext()) for node in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('x:si', NS)]
        relations = {r.get('Id'): r for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        result = {}
        for sheet in ET.fromstring(archive.read('xl/workbook.xml')).findall('x:sheets/x:sheet', NS):
            name = sheet.get('name')
            if name not in ('Interconnection Queue', 'Withdrawn', 'In Service'):
                continue
            relation = relations[sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
            if relation.get('TargetMode') == 'External':
                raise ValueError('External worksheet refused')
            target = relation.get('Target', '')
            path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
            if not path.startswith('xl/'):
                raise ValueError('Invalid worksheet path')
            rows = []
            for row in ET.fromstring(archive.read(path)).findall('x:sheetData/x:row', NS):
                values = {}
                for cell in row.findall('x:c', NS):
                    ref = re.fullmatch(r'([A-Z]+)\d+', cell.get('r', ''))
                    if not ref or cell.find('x:f', NS) is not None or cell.get('t') == 'e':
                        raise ValueError('Formula, error or invalid cell')
                    value = cell.findtext('x:v', None, NS)
                    if cell.get('t') == 's' and value is not None:
                        value = strings[int(value)]
                    elif cell.get('t') == 'inlineStr':
                        value = ''.join(cell.find('x:is', NS).itertext())
                    if value is not None and value.strip():
                        values[ref[1]] = value.strip()
                if values:
                    rows.append(values)
            result[name] = rows
        if set(result) != {'Interconnection Queue', 'Withdrawn', 'In Service'}:
            raise ValueError('Expected complete active, withdrawn and in-service sheets')
        return result


def validate_legend(rows):
    text = ' '.join(' '.join(row.values()) for row in rows)
    match = re.search(r'status of the project.*?Key:\s*(.*?)\s*[●•]\s*Availability of Studies', text, re.I)
    if not match:
        raise ValueError('Historical status legend missing')
    legend = {}
    for entry in re.split(r',\s*(?=(?:\d+[A-Z]?|P)\s*=)', match[1]):
        pair = re.fullmatch(r'\s*(\d+[A-Z]?|P)\s*=\s*(.*?)\s*,?\s*', entry)
        if not pair:
            raise ValueError('Ambiguous historical status legend')
        code, label = pair[1], ' '.join(pair[2].split())
        if code in legend or STATUSES.get(code) != label:
            raise ValueError('Unreviewed historical status meaning')
        legend[code] = label
    if not {str(i) for i in range(16)} <= set(legend):
        raise ValueError('Incomplete historical status legend')
    return legend


def capacity(value):
    if value is None or value.lower() in ('n/a', 'n.a.', 'unknown', 'tbd'):
        return None
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError('Invalid historical MW')
    return result


def parse_loads(data):
    sheets = workbook_sheets(data)
    rows = sheets['Interconnection Queue']
    header = rows[0]
    if not REQUIRED <= set(header.values()) or len(set(header.values())) != len(header):
        raise ValueError('Unreviewed historical queue schema')
    legend = validate_legend(rows)
    projects, seen = [], set()
    for row in rows[1:]:
        fields = {field: row.get(column) for column, field in header.items()}
        if fields['Type/ Fuel'] != 'L':
            continue
        identity, code = fields['Queue Pos.'], fields['S']
        if not identity or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', identity) or identity in seen:
            raise ValueError('Invalid or duplicate historical load ID')
        if not fields['Project Name'] or code not in legend:
            raise ValueError('Unknown historical load stage or missing name')
        seen.add(identity)
        # Match current register eligibility: only commercial operation and withdrawn are ended.
        status = 'withdrawn' if code == '0' else 'operational' if code == '14' else 'active'
        projects.append(dict(id='NYISO::' + identity, sourceId='nyiso-load-register', sourceRecordId=identity,
                             name=fields['Project Name'], region='NYISO', types=['load'], state=fields['State'],
                             status=status, eligible=status == 'active' and fields['State'] in STATES,
                             rawStatus=legend[code], sourceUrl=ORIGINAL, sourceAsOf=None,
                             loadMw=capacity(fields['SP (MW)']), winterMw=capacity(fields['WP (MW)'])))
    if not projects:
        raise ValueError('Empty historical load queue')
    # Historical ended sheets use multirow headers; their reviewed Type/Fuel column is G.
    ended = {}
    for name in ('Withdrawn', 'In Service'):
        rows = sheets[name]
        if not rows or 'Type/' not in rows[0].get('G', ''):
            raise ValueError('Unreviewed ended-sheet type column')
        ended[name] = sum(row.get('G') == 'L' for row in rows[1:])
    return projects, ended


def estimate_points(projects):
    # Execute the same versioned model used by the live dashboard; do not duplicate weights.
    script = "import {readFileSync} from 'node:fs'; import {estimateStage, STAGE_ESTIMATE_VERSION} from './shared/stage-estimate.ts'; const ps=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify({modelVersion:STAGE_ESTIMATE_VERSION,points:ps.map(p=>estimateStage(p)?.point??null)}));"
    result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps(projects),
                            text=True, capture_output=True, check=True, cwd=ROOT)
    parsed = json.loads(result.stdout)
    if parsed['modelVersion'] != MODEL or len(parsed['points']) != len(projects):
        raise ValueError('Historical scoring model version changed')
    return parsed['points']


def build_vintage(data, meta):
    match = re.fullmatch(r'archive-(\d{14})\.xlsx', meta.get('id', ''))
    if not match:
        raise ValueError('Invalid archive artifact ID')
    stamp = match[1]
    expected_url = f'https://web.archive.org/web/{stamp}id_/{ORIGINAL}'
    if meta.get('status') != 200 or meta.get('url') != expected_url or meta.get('finalUrl') != expected_url:
        raise ValueError('Archive capture URL mismatch or redirect')
    if meta.get('bytes') != len(data) or meta.get('sha256') != hashlib.sha256(data).hexdigest():
        raise ValueError('Archive bytes do not match retrieval provenance')
    captured = dt.datetime.strptime(stamp, '%Y%m%d%H%M%S').replace(tzinfo=dt.timezone.utc)
    retrieved = dt.datetime.fromisoformat(meta['retrievedAt'].replace('Z', '+00:00'))
    if retrieved.tzinfo is None or retrieved < captured:
        raise ValueError('Invalid retrieval time')
    projects, ended = parse_loads(data)
    active = [p for p in projects if p['eligible']]
    points = estimate_points(active)
    rated = [p for p in points if p is not None]
    status_counts = dict(sorted(Counter(p['rawStatus'] for p in active).items()))
    return dict(
        id='nyiso-archive-' + stamp, sourceAsOf=None, publishedAt=None, dateBasis='archive_capture',
        archiveCapturedAt=captured.isoformat(timespec='seconds').replace('+00:00', 'Z'),
        source=dict(name='Internet Archive에 보존된 NYISO 공식 원장', url=expected_url,
                    originalUrl=ORIGINAL, retrievedAt=meta['retrievedAt'], sha256=meta['sha256']),
        notes='Internet Archive 실제 캡처 당시의 공개 원장. 전체 원장 기준일·발행일은 미공개이며 캡처일은 그 대체값이 아닙니다. Interconnection Queue 탭의 Type/Fuel=L인 본토 활성 신청만 집계. 당시 S 상태를 현재 stage-proxy-v1 모형으로 재평가한 추정으로, 당시 발표된 공식 점수가 아닙니다. 용량은 구원장 SP(여름) MW이며 현재 Peak MW 정의와 차이가 있을 수 있습니다.',
        capacityDefinition='summer_mw', capacityDefinitionLabel='SP (MW) · 여름 용량',
        excludedCounts=dict(withdrawnSheet=ended['Withdrawn'], inServiceSheet=ended['In Service'],
                            ineligibleActiveSheet=len(projects) - len(active)),
        statusCounts=status_counts,
        summaries=[dict(region='NYISO', type='load', eligibleCount=len(active), ratedCount=len(rated),
                        unknownCount=len(active)-len(rated), ratingMean=sum(rated)/len(rated) if rated else None,
                        loadMw=sum(p['loadMw'] for p in active if p['loadMw'] is not None),
                        capacityUnknownCount=sum(p['loadMw'] is None for p in active),
                        winterMw=sum(p['winterMw'] for p in active if p['winterMw'] is not None))])


def build_current(bootstrap):
    source_id = 'nyiso-load-register'
    matches = [r for r in bootstrap['provenance']['sourceRefreshes'] if r['sourceId'] == source_id]
    if len(matches) != 1:
        raise ValueError('Expected one verified NYISO bootstrap refresh')
    source = matches[0]
    if source['sourceUrl'] != ORIGINAL or not re.fullmatch(r'[0-9a-f]{64}', source['sourceSha256']):
        raise ValueError('Invalid current source provenance')
    observed = dt.datetime.fromisoformat(source['retrievedAt'].replace('Z', '+00:00'))
    if observed.tzinfo is None:
        raise ValueError('Observation must have timezone')
    projects = [p for p in bootstrap['projects'] if p['sourceId'] == source_id]
    active = [p for p in projects if p['eligible'] and p['status'] == 'active']
    if not active or any(p['sourceUrl'] != ORIGINAL or p['types'] != ['load'] for p in projects):
        raise ValueError('Invalid current NYISO bootstrap scope')
    points = estimate_points(active)
    rated = [p for p in points if p is not None]
    return dict(
        id='nyiso-observation-' + observed.strftime('%Y%m%dT%H%M%SZ'),
        dateBasis='observation', observedAt=source['retrievedAt'], archiveCapturedAt=None,
        sourceAsOf=source['sourceAsOf'], publishedAt=None,
        source=dict(name='NYISO 공식 Load Projects 원장', url=ORIGINAL, originalUrl=ORIGINAL,
                    retrievedAt=source['retrievedAt'], sha256=source['sourceSha256']),
        notes='2026-10-08 실제 취득·검증한 NYISO Load Projects 원장. 전체 원장 기준일 미공개이므로 실제 관측일로 표시합니다. 현재 상태를 과거 접수일로 소급하지 않습니다. 과거 Interconnection Queue의 SP(여름) MW와 현재 Peak MW는 정의가 다르며 원장 시트 구조도 변경됐습니다. 용량 추세는 이 지점에서 선을 끊어 비교하고 점수는 동일 stage-proxy-v1 모형의 단계 추정입니다.',
        capacityDefinition='peak_mw', capacityDefinitionLabel='Peak MW load · 최대 신청 부하',
        capacityBreakBefore=True,
        excludedCounts=dict(withdrawn=sum(p['status'] == 'withdrawn' for p in projects),
                            operational=sum(p['status'] == 'operational' for p in projects),
                            ineligible=len(projects)-len(active)),
        statusCounts=dict(sorted(Counter(p['rawStatus'] for p in active).items())),
        summaries=[dict(region='NYISO', type='load', eligibleCount=len(active), ratedCount=len(rated),
                        unknownCount=len(active)-len(rated), ratingMean=sum(rated)/len(rated) if rated else None,
                        loadMw=sum(p['loadMw'] for p in active if p['loadMw'] is not None),
                        capacityUnknownCount=sum(p['loadMw'] is None for p in active))])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/history-nyiso.json')
    parser.add_argument('--bootstrap', type=Path, default=ROOT / 'data/bootstrap.json')
    args = parser.parse_args()
    metadata = json.loads((args.archive_dir / 'retrieval-archives.json').read_text())
    vintages = [build_vintage((args.archive_dir / 'raw' / m['id']).read_bytes(), m)
                for m in metadata if re.fullmatch(r'archive-\d{14}\.xlsx', m.get('id', ''))]
    if not vintages or len({v['archiveCapturedAt'] for v in vintages}) != len(vintages):
        raise ValueError('Missing or duplicate archive vintages')
    vintages.append(build_current(json.loads(args.bootstrap.read_text())))
    result = dict(schemaVersion=1, generatedAt=dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                  modelVersion=MODEL, vintages=sorted(vintages, key=lambda v: v.get('archiveCapturedAt') or v['observedAt']))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'output': str(args.output), 'vintages': len(vintages)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
