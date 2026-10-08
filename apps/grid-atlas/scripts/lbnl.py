#!/usr/bin/env python3
"""Validated LBNL annual active transmission-queue workbook adapter (stdlib only).

The annual cutoff is a source fact, never the HTTP acquisition time.  This adapter
does not infer gate completion from the publisher's single study-phase label.
Resource MW comes from component columns: missing and negative values stay null;
known zero stays zero.  Raw component disagreements and negative values survive
in the returned originals for review.  Identity is entity + exact queue ID, not a
claim that separately submitted requests are distinct physical developments.
"""
import datetime as dt
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
import io
import math
import posixpath
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile

SOURCE_ID = 'lbnl-generation-storage-queues'
ADAPTER = 'lbnl_active_xlsx_v1'
MAX_BYTES = 32 * 1024 * 1024
XML_LIMIT = 96 * 1024 * 1024
NS = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
HEADERS = ['q_id', 'q_status', 'q_date', 'prop_date', 'on_date', 'wd_date', 'ia_date',
           'IA_phase_raw', 'IA_phase_clean', 'county', 'state', 'fips_code', 'poi_name',
           'region', 'project_name', 'utility', 'entity', 'developer', 'cluster', 'service',
           'project_type', 'type_1', 'type_2', 'type_3', 'type_clean', 'mw_1', 'mw_2',
           'mw_3', 'q_year', 'prop_year']
STATES = set('AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split())
REGIONS = {'CAISO', 'ERCOT', 'ISO-NE', 'MISO', 'NYISO', 'PJM', 'SPP', 'West', 'Southeast'}
RESOURCE_TYPES = {'Solar', 'Wind', 'Battery', 'Gas', 'Hydro', 'Coal', 'Offshore Wind',
                  'Nuclear', 'Geothermal', 'Diesel', 'Oil', 'Hydrogen', 'Other Storage', 'Other'}
STORAGE_TYPES = {'Battery', 'Other Storage'}
PHASES = {'IA Executed', 'Withdrawn', 'System Impact Study', 'Feasibility Study',
          'Facility Study', 'In Progress (unknown study)', 'Cluster Study', 'IA Pending',
          'Not Started', 'Construction', 'Suspended'}
CODEBOOK_NOTES = {
    'q_id': 'Combine with "entity" to form a unique identifier across the full dataset',
    'q_status': 'One of: active, withdrawn, suspended, or operational',
    'mw_1': 'Rated electric capacity of the generation or storage plant',
    'mw_2': 'The full report includes imputed storage capacity for hybrid and co-located generators where mw_2 and mw_3 values are missing. Those imputed values are excluded from the data reported here.',
    'mw_3': 'The full report includes imputed storage capacity for hybrid and co-located generators where mw_2 and mw_3 values are missing. Those imputed values are excluded from the data reported here.',
}


def _official_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'emp.lbl.gov' or parsed.username
            or parsed.password or parsed.fragment or parsed.query or parsed.port not in (None, 443)):
        raise ValueError('Official LBNL HTTPS URL required')
    return parsed


def _url_year(url):
    parsed = _official_url(url)
    match = re.fullmatch(r'/sites/default/files/\d{4}-\d{2}/LBNL_Ix_Queue_Data_File_thru(\d{4})\.xlsx', parsed.path)
    if not match:
        raise ValueError('Unknown LBNL workbook filename requires parser review')
    year = int(match[1])
    if not 2025 <= year <= dt.datetime.now(dt.timezone.utc).year:
        raise ValueError('Unreviewed historic or future LBNL release')
    return year


class _Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.links.extend(v for k, v in attrs if k == 'href' and v)


def discover_lbnl_workbook(index_bytes, index_url):
    """Select the newest explicitly linked, official, supported annual workbook.

    Do not synthesize URLs, follow third-party lookalikes, or silently select one
    of two same-year releases.  A changed filename or missing link needs review.
    """
    _official_url(index_url)
    if not index_bytes or len(index_bytes) > MAX_BYTES:
        raise ValueError('Empty or oversized LBNL index')
    parser = _Links()
    parser.feed(index_bytes.decode('utf-8-sig'))
    candidates = {}
    for href in parser.links:
        if 'LBNL_Ix_Queue_Data_File_thru' not in href:
            continue
        url = urllib.parse.urljoin(index_url, href)
        year = _url_year(url)
        candidates.setdefault(year, set()).add(url)
    if not candidates:
        raise ValueError('No supported official LBNL workbook link')
    newest = candidates[max(candidates)]
    if len(newest) != 1:
        raise ValueError('Ambiguous latest LBNL workbook links')
    return next(iter(newest))


class _Workbook:
    def __init__(self, data):
        if not data or len(data) > MAX_BYTES:
            raise ValueError('Empty or oversized LBNL workbook')
        self.archive = zipfile.ZipFile(io.BytesIO(data))
        entries = self.archive.infolist()
        if len(entries) > 4096 or sum(e.file_size for e in entries) > XML_LIMIT:
            raise ValueError('Expanded workbook too large')
        if len({e.filename for e in entries}) != len(entries):
            raise ValueError('Duplicate workbook archive entries')
        self.book = self.xml('xl/workbook.xml')
        properties = self.book.find('x:workbookPr', NS)
        if properties is not None and properties.get('date1904', '0') not in ('0', 'false'):
            raise ValueError('Changed Excel date epoch requires review')
        self.relations = self.xml('xl/_rels/workbook.xml.rels')
        self.strings = []
        if 'xl/sharedStrings.xml' in self.archive.namelist():
            self.strings = [''.join(t.text or '' for t in s.findall('.//x:t', NS))
                            for s in self.xml('xl/sharedStrings.xml').findall('x:si', NS)]
        self.styles = [0]
        if 'xl/styles.xml' in self.archive.namelist():
            xfs = self.xml('xl/styles.xml').find('x:cellXfs', NS)
            if xfs is not None:
                self.styles = [int(x.get('numFmtId', '0')) for x in xfs]

    def xml(self, path):
        value = self.archive.read(path)
        if b'<!DOCTYPE' in value or b'<!ENTITY' in value:
            raise ValueError('Workbook XML declarations refused')
        return ET.fromstring(value)

    def sheet(self, name):
        sheets = [s for s in self.book.findall('x:sheets/x:sheet', NS) if s.get('name') == name]
        if len(sheets) != 1:
            raise ValueError('Required unique LBNL sheet missing: ' + name)
        rid = sheets[0].get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        targets = [r for r in self.relations if r.get('Id') == rid and r.get('TargetMode') != 'External']
        if len(targets) != 1:
            raise ValueError('Invalid workbook relationship')
        target = targets[0].get('Target', '')
        path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
        if not path.startswith('xl/'):
            raise ValueError('Worksheet path outside workbook')
        rows = []
        for row in self.xml(path).findall('x:sheetData/x:row', NS):
            cells = {}
            for cell in row.findall('x:c', NS):
                match = re.fullmatch(r'([A-Z]+)\d+', cell.get('r', ''))
                if not match or cell.find('x:f', NS) is not None or cell.get('t') == 'e':
                    raise ValueError('Formula, error or invalid source cell')
                if match[1] in cells:
                    raise ValueError('Duplicate worksheet column')
                value = cell.findtext('x:v', None, NS)
                kind = cell.get('t', 'n')
                if kind == 's' and value is not None:
                    index = int(value)
                    if not 0 <= index < len(self.strings):
                        raise ValueError('Invalid shared string')
                    value = self.strings[index]
                elif kind == 'inlineStr':
                    value = ''.join(t.text or '' for t in cell.findall('x:is//x:t', NS))
                elif value is not None and kind == 'n':
                    try:
                        number = Decimal(value)
                    except InvalidOperation as exc:
                        raise ValueError('Invalid source number') from exc
                    if not number.is_finite():
                        raise ValueError('Nonfinite source number')
                    style = int(cell.get('s', '0'))
                    if not 0 <= style < len(self.styles):
                        raise ValueError('Invalid cell style')
                    number_format = self.styles[style]
                    if number_format == 14:
                        # The nine CLPT IDs in the 2025 release are Excel dates.
                        # Exact ISO dates preserve their official displayed identity.
                        if number != int(number) or not 61 <= number <= 120000:
                            raise ValueError('Unsupported date-valued queue ID')
                        value = (dt.date(1899, 12, 30) + dt.timedelta(days=int(number))).isoformat()
                    elif number_format in (15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47) or number_format >= 167:
                        raise ValueError('Unreviewed date or custom format in source sheet')
                    else:
                        # Integer queue IDs must not pass through binary float:
                        # large IDs would silently round and change identity.
                        value = int(number) if number == int(number) else float(number)
                        if isinstance(value, float) and not math.isfinite(value):
                            raise ValueError('Nonfinite source number')
                elif value is not None and kind not in ('s', 'str', 'inlineStr'):
                    raise ValueError('Unsupported source cell type')
                if isinstance(value, str):
                    value = value.strip() or None
                if value is not None:
                    cells[match[1]] = value
            if cells:
                rows.append(cells)
        return rows

    def close(self):
        self.archive.close()


def _validate_metadata(book, workbook_url):
    year = _url_year(workbook_url)
    introduction = [str(v) for row in book.sheet('Introduction') for v in row.values()]
    methods = [str(v) for row in book.sheet('00. Background + Methods') for v in row.values()]
    if f'Summarized Data Files, through {year}' not in introduction:
        raise ValueError('Workbook title and annual URL disagree')
    for required in [f'Includes requests submitted to queues through the end of {year}',
                     'Includes projects that connect to the bulk-power system, not distribution-connected or behind-the-meter',
                     'Does not include load interconnection; may include generators co-located with load if the generator is transmission-connected']:
        if required not in methods:
            raise ValueError('LBNL cutoff or source scope changed')
    codebook = book.sheet('04. Data Codebook')
    fields = [row.get('A') for row in codebook if row.get('A') in HEADERS]
    if fields != HEADERS:
        raise ValueError('LBNL codebook field contract changed')
    for field, note in CODEBOOK_NOTES.items():
        matches = [row for row in codebook if row.get('A') == field]
        if len(matches) != 1 or matches[0].get('C') != note:
            raise ValueError('LBNL identity/status/capacity semantics changed')
    return f'{year}-12-31'


def workbook_source_as_of(data, workbook_url):
    book = _Workbook(data)
    try:
        return _validate_metadata(book, workbook_url)
    finally:
        book.close()


def _capacity(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('Unknown LBNL MW representation')
    # A reported negative change is not nonnegative project capacity. Keep the
    # original field and flag; never net it against another project's MW.
    return value if value >= 0 else None


def parse_lbnl(data, source):
    """Return (active normalized projects, raw active rows), matching parse_nyiso.

    source.workbookUrl is the URL actually acquired; source.url remains the
    discovery index in the source registry. All 30 original fields are preserved.
    """
    if source.get('id') != SOURCE_ID:
        raise ValueError('LBNL source ID required')
    workbook_url = source.get('workbookUrl', source.get('url', ''))
    book = _Workbook(data)
    try:
        cutoff = _validate_metadata(book, workbook_url)
        rows = book.sheet('03. Complete Queue Data')
    finally:
        book.close()
    if source.get('sourceAsOf') and cutoff < source['sourceAsOf']:
        raise ValueError('LBNL release predates existing source cutoff')
    headers = [i for i, row in enumerate(rows) if row.get('A') == 'q_id']
    if len(headers) != 1:
        raise ValueError('Unique LBNL data header missing')
    start = headers[0]
    columns = rows[start]
    expected_columns = [chr(65 + i) if i < 26 else 'A' + chr(65 + i - 26) for i in range(30)]
    if [columns.get(c) for c in expected_columns] != HEADERS or len(columns) != 30:
        raise ValueError('LBNL 30-column schema changed')
    projects, originals, seen = [], [], set()
    for row in rows[start + 1:]:
        if set(row) - set(columns):
            raise ValueError('Unexpected columns after LBNL header')
        values = {field: row.get(column) for column, field in columns.items()}
        # Ten literal "unknown" historical statuses occur in the official 2025
        # release; they are not active and never become active by inference.
        if values['q_status'] not in ('active', 'withdrawn', 'operational', 'suspended', 'unknown'):
            raise ValueError('Unrecognized LBNL queue status')
        if values['q_status'] != 'active':
            continue
        if values['q_id'] is None or not isinstance(values['entity'], str):
            raise ValueError('Missing active queue ID or entity')
        queue_id, entity = str(values['q_id']), values['entity']
        if not queue_id or '::' in queue_id or not entity or '::' in entity:
            raise ValueError('Invalid source-qualified queue identity')
        identity = entity + '::' + queue_id
        if identity in seen:
            raise ValueError('Duplicate active source-qualified queue identity')
        seen.add(identity)
        if values['region'] not in REGIONS or values['IA_phase_clean'] not in PHASES | {None}:
            raise ValueError('Unrecognized LBNL region or study phase')
        if values['project_type'] not in {'Generation', 'Surplus', 'Upgrade', 'Replacement', None}:
            raise ValueError('Changed request-type scope')
        generation, storage, flags, component_types = [], [], [], []
        for i in (1, 2, 3):
            kind, raw_mw = values[f'type_{i}'], values[f'mw_{i}']
            if kind is None:
                if raw_mw is not None:
                    raise ValueError('MW without a resource component')
                continue
            if kind not in RESOURCE_TYPES:
                raise ValueError('Unknown LBNL resource type')
            component_types.append(kind)
            mw = _capacity(raw_mw)
            if raw_mw is not None and mw is None:
                flags.append(f'negative_mw_{i}_not_project_capacity')
            (storage if kind in STORAGE_TYPES else generation).append(mw)
        if not component_types:
            raise ValueError('Active queue request has no resource component')
        if not isinstance(values['type_clean'], str) or not set(values['type_clean'].split('+')) <= RESOURCE_TYPES:
            raise ValueError('Unknown standardized LBNL resource type')
        if set(values['type_clean'].split('+')) != set(component_types):
            flags.append('type_clean_disagrees_with_capacity_components')
        sum_known = lambda parts: sum(p for p in parts if p is not None) if any(p is not None for p in parts) else None
        generation_mw, storage_mw = sum_known(generation), sum_known(storage)
        capacity_status = 'unknown' if generation_mw is None and storage_mw is None else 'partial' if None in generation + storage else 'known'
        state = values['state']
        if state is not None and (not isinstance(state, str) or not re.fullmatch('[A-Z]{2}', state)):
            raise ValueError('Unrecognized state representation')
        eligible = state in STATES
        projects.append(dict(id=identity, sourceId=SOURCE_ID, sourceRecordId=identity,
                             name=str(values['project_name'] or values['poi_name'] or identity),
                             types=(['generation'] if generation else []) + (['storage'] if storage else []),
                             region=values['region'], state=state, status='active',
                             generationMw=generation_mw, storageMw=storage_mw, loadMw=None,
                             capacityStatus=capacity_status, eligible=eligible,
                             exclusionReason=None if eligible else '미국 본토 48주/DC 위치 미확인 또는 범위 밖',
                             sourceUrl=workbook_url, sourceAsOf=cutoff,
                             rawStatus=str(values['IA_phase_clean'] or values['IA_phase_raw'] or 'active'),
                             identityScope='source_record'))
        originals.append({**values, '_qualityFlags': flags})
    if not projects or (source.get('recordCount') and len(projects) < source['recordCount'] / 2):
        raise ValueError('Empty or unexpectedly reduced active scope requires manual review')
    return projects, originals
