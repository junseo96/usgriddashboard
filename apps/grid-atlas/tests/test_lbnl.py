"""Semantic fixtures decoded from the 2026-05 official LBNL thru2025 release.

Source SHA256: 794582d3281c6a305e9615fcfec3fae9dc85be2165216d33760b677e976a08b6
Fixtures retain the actual tricky identities/components; no inferred progress.
"""
import copy
import io
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from lbnl import (CODEBOOK_NOTES, HEADERS, SOURCE_ID, discover_lbnl_workbook,
                  parse_lbnl, workbook_source_as_of)

URL = 'https://emp.lbl.gov/sites/default/files/2026-05/LBNL_Ix_Queue_Data_File_thru2025.xlsx'
SOURCE = {'id': SOURCE_ID, 'url': 'https://emp.lbl.gov/queues', 'workbookUrl': URL,
          'sourceAsOf': '2025-12-31', 'recordCount': 7}
REAL_ROWS = [
    {'q_id': 'Q225', 'q_status': 'active', 'IA_phase_raw': 'Project with APS Project Manager (Legacy)',
     'IA_phase_clean': 'In Progress (unknown study)', 'county': 'Maricopa', 'state': 'AZ',
     'poi_name': 'Hoodoo Wash 500kV Substation', 'region': 'West', 'entity': 'APS',
     'project_type': 'Generation', 'type_1': 'Solar', 'type_2': 'Battery', 'type_clean': 'Solar+Battery', 'mw_1': 200},
    {'q_id': 40603, 'q_status': 'active', 'IA_phase_clean': 'Cluster Study', 'county': 'Laramie',
     'state': 'WY', 'poi_name': 'CPGS substation', 'region': 'West', 'entity': 'CLPT',
     'project_type': 'Generation', 'type_1': 'Gas', 'type_clean': 'Gas', 'mw_1': 115},
    {'q_id': 'L002', 'q_status': 'active', 'IA_phase_clean': 'In Progress (unknown study)',
     'county': 'Scott', 'state': 'MN', 'poi_name': 'Unknown', 'region': 'MISO', 'entity': 'MISO',
     'project_type': 'Generation', 'type_1': 'Other', 'type_clean': 'Other', 'mw_1': -28},
    {'q_id': 1667, 'q_status': 'active', 'IA_phase_raw': 'Executed', 'IA_phase_clean': 'IA Executed',
     'county': 'Imperial', 'state': 'CA', 'poi_name': 'Imperial Valley Substation 230 kV',
     'region': 'CAISO', 'project_name': 'SUNRISE BUTTE', 'entity': 'CAISO', 'project_type': 'Generation',
     'type_1': 'Solar', 'type_2': 'Battery', 'type_clean': 'Solar+Battery', 'mw_1': 0, 'mw_2': 150},
    {'q_id': 'R5066', 'q_status': 'active', 'county': 'Columbia', 'state': 'WI', 'poi_name': 'Columbia',
     'region': 'MISO', 'project_name': 'Replacing 20 MW of solar with storage; J1746', 'entity': 'MISO',
     'project_type': 'Generation', 'type_1': 'Battery', 'type_2': 'Other Storage',
     'type_clean': 'Battery+Other Storage', 'mw_1': 20.2},
    {'q_id': 'J4183', 'q_status': 'active', 'region': 'MISO', 'entity': 'MISO', 'project_type': 'Generation',
     'type_1': 'Other', 'type_clean': 'Other', 'mw_1': 99.9},
    {'q_id': 1660, 'q_status': 'active', 'IA_phase_clean': 'IA Executed', 'state': 'MX',
     'poi_name': 'East County Substation 230 kV', 'region': 'CAISO', 'project_name': 'CIMARRON WIND',
     'entity': 'CAISO', 'project_type': 'Generation', 'type_1': 'Wind', 'type_clean': 'Wind', 'mw_1': 300},
]
NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def col(index):
    return chr(65 + index) if index < 26 else 'A' + chr(65 + index - 26)


def fixture(rows=None, *, headers=None, cutoff=2025, notes=None, formula=False):
    """Small XLSX envelope containing real decoded records and publisher metadata."""
    rows = copy.deepcopy(REAL_ROWS if rows is None else rows)
    notes = CODEBOOK_NOTES if notes is None else notes
    intro = [['Summarized Data Files, through ' + str(cutoff)]]
    methods = [[f'Includes requests submitted to queues through the end of {cutoff}'],
               ['Includes projects that connect to the bulk-power system, not distribution-connected or behind-the-meter'],
               ['Does not include load interconnection; may include generators co-located with load if the generator is transmission-connected']]
    codebook = [['Field Name', 'Description', 'Notes']] + [[h, h, notes.get(h)] for h in HEADERS]
    data = [['RETURN TO CONTENTS'], HEADERS if headers is None else headers] + [[r.get(h) for h in HEADERS] for r in rows]
    sheets = [('Introduction', intro), ('00. Background + Methods', methods),
              ('04. Data Codebook', codebook), ('03. Complete Queue Data', data)]
    book = ET.Element('workbook', {'xmlns': NS, 'xmlns:r': REL})
    sheet_nodes = ET.SubElement(book, 'sheets')
    relations = ET.Element('Relationships', {'xmlns': 'http://schemas.openxmlformats.org/package/2006/relationships'})
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as archive:
        for i, (name, values) in enumerate(sheets, 1):
            ET.SubElement(sheet_nodes, 'sheet', {'name': name, 'sheetId': str(i), 'r:id': 'rId' + str(i)})
            ET.SubElement(relations, 'Relationship', {'Id': 'rId' + str(i), 'Target': f'worksheets/sheet{i}.xml', 'Type': REL + '/worksheet'})
            xml = ET.Element('worksheet', {'xmlns': NS})
            sheet_data = ET.SubElement(xml, 'sheetData')
            for r, values_row in enumerate(values, 1):
                row = ET.SubElement(sheet_data, 'row', {'r': str(r)})
                for c, value in enumerate(values_row):
                    if value is None:
                        continue
                    attrs = {'r': col(c) + str(r)}
                    if i == 4 and r >= 3 and c == 0 and rows[r - 3].get('entity') == 'CLPT':
                        attrs['s'] = '1'  # official CLPT date-valued queue identifiers
                    if isinstance(value, str):
                        attrs['t'] = 'inlineStr'
                    cell = ET.SubElement(row, 'c', attrs)
                    if isinstance(value, str):
                        ET.SubElement(ET.SubElement(cell, 'is'), 't').text = value
                    else:
                        ET.SubElement(cell, 'v').text = str(value)
                    if formula and i == 4 and r == 3 and c == 25:
                        ET.SubElement(cell, 'f').text = '100+100'
            archive.writestr(f'xl/worksheets/sheet{i}.xml', ET.tostring(xml))
        archive.writestr('xl/workbook.xml', ET.tostring(book))
        archive.writestr('xl/_rels/workbook.xml.rels', ET.tostring(relations))
        archive.writestr('xl/styles.xml', f'<styleSheet xmlns="{NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
    return out.getvalue()


class LbnlTest(unittest.TestCase):
    def test_real_components_do_not_impute_missing_storage(self):
        projects, originals = parse_lbnl(fixture(), SOURCE)
        p = {r['id']: r for r in projects}
        self.assertEqual(len(p), 7)
        self.assertEqual(p['APS::Q225']['types'], ['generation', 'storage'])
        self.assertEqual(p['APS::Q225']['generationMw'], 200)
        self.assertIsNone(p['APS::Q225']['storageMw'])
        self.assertEqual(p['APS::Q225']['capacityStatus'], 'partial')
        self.assertEqual(p['MISO::R5066']['storageMw'], 20.2)
        self.assertEqual(p['MISO::R5066']['capacityStatus'], 'partial')
        self.assertTrue(all(len(x) == 31 for x in originals))
        self.assertNotIn('assessments', p['APS::Q225'])

    def test_zero_and_negative_have_distinct_meanings(self):
        projects, originals = parse_lbnl(fixture(), SOURCE)
        p = {r['id']: r for r in projects}
        self.assertEqual(p['CAISO::1667']['generationMw'], 0)
        self.assertEqual(p['CAISO::1667']['storageMw'], 150)
        self.assertEqual(p['CAISO::1667']['types'], ['generation', 'storage'])
        self.assertEqual(p['CAISO::1667']['capacityStatus'], 'known')
        self.assertIsNone(p['MISO::L002']['generationMw'])
        self.assertEqual(p['MISO::L002']['capacityStatus'], 'unknown')
        raw = next(x for x in originals if x['q_id'] == 'L002')
        self.assertEqual(raw['mw_1'], -28)
        self.assertIn('negative_mw_1_not_project_capacity', raw['_qualityFlags'])

    def test_exact_id_qualification_including_excel_date(self):
        projects, _ = parse_lbnl(fixture(), SOURCE)
        p = {r['id']: r for r in projects}
        self.assertEqual(p['CLPT::2011-03-01']['sourceRecordId'], 'CLPT::2011-03-01')
        self.assertIn('CAISO::1667', p)
        duplicate_number = copy.deepcopy(REAL_ROWS[3])
        duplicate_number.update(entity='SPP', region='SPP')
        projects, _ = parse_lbnl(fixture(REAL_ROWS + [duplicate_number]), SOURCE)
        self.assertEqual(len(projects), 8)

    def test_numeric_identifier_never_rounds_through_binary_float(self):
        records = copy.deepcopy(REAL_ROWS)
        records[3]['q_id'] = 9007199254740993
        projects, _ = parse_lbnl(fixture(records), SOURCE)
        self.assertIn('CAISO::9007199254740993', {r['id'] for r in projects})

    def test_mainland_location_exclusions_do_not_delete_source_records(self):
        projects, _ = parse_lbnl(fixture(), SOURCE)
        p = {r['id']: r for r in projects}
        self.assertFalse(p['MISO::J4183']['eligible'])
        self.assertIsNone(p['MISO::J4183']['state'])
        self.assertFalse(p['CAISO::1660']['eligible'])
        self.assertEqual(p['CAISO::1660']['state'], 'MX')
        self.assertEqual(sum(x['eligible'] for x in projects), 5)

    def test_cutoff_is_publisher_year_not_acquisition_date(self):
        self.assertEqual(workbook_source_as_of(fixture(), URL), '2025-12-31')
        projects, _ = parse_lbnl(fixture(), SOURCE)
        self.assertEqual({r['sourceAsOf'] for r in projects}, {'2025-12-31'})
        self.assertEqual({r['sourceUrl'] for r in projects}, {URL})
        with self.assertRaisesRegex(ValueError, 'title'):
            workbook_source_as_of(fixture(cutoff=2024), URL)
        with self.assertRaisesRegex(ValueError, 'predates'):
            parse_lbnl(fixture(), {**SOURCE, 'sourceAsOf': '2026-12-31'})

    def test_duplicate_id_and_incomplete_active_scope_refused(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate active'):
            parse_lbnl(fixture(REAL_ROWS + [REAL_ROWS[0]]), SOURCE)
        with self.assertRaisesRegex(ValueError, 'reduced'):
            parse_lbnl(fixture(REAL_ROWS[:1]), SOURCE)

    def test_closed_and_unknown_records_do_not_enter_active_denominator(self):
        records = copy.deepcopy(REAL_ROWS)
        records[0]['q_status'] = 'withdrawn'
        records[1]['q_status'] = 'operational'
        records[2]['q_status'] = 'unknown'
        projects, _ = parse_lbnl(fixture(records), SOURCE)
        self.assertEqual(len(projects), 4)
        self.assertNotIn('APS::Q225', {r['id'] for r in projects})
        records[0]['q_status'] = 'new undefined status'
        with self.assertRaisesRegex(ValueError, 'queue status'):
            parse_lbnl(fixture(records), SOURCE)

    def test_schema_and_source_meaning_changes_require_review(self):
        changed_headers = list(HEADERS)
        changed_headers[25] = 'mva_1'
        with self.assertRaisesRegex(ValueError, '30-column'):
            parse_lbnl(fixture(headers=changed_headers), SOURCE)
        changed_notes = {**CODEBOOK_NOTES, 'mw_2': 'Missing storage has been imputed.'}
        with self.assertRaisesRegex(ValueError, 'semantics'):
            parse_lbnl(fixture(notes=changed_notes), SOURCE)
        with self.assertRaisesRegex(ValueError, 'Formula'):
            parse_lbnl(fixture(formula=True), SOURCE)

    def test_untyped_capacity_or_unknown_resource_refused(self):
        records = copy.deepcopy(REAL_ROWS)
        records[0]['mw_3'] = 50
        with self.assertRaisesRegex(ValueError, 'without a resource'):
            parse_lbnl(fixture(records), SOURCE)
        records[0]['mw_3'] = None
        records[0]['type_1'] = 'future ambiguous type'
        with self.assertRaisesRegex(ValueError, 'resource type'):
            parse_lbnl(fixture(records), SOURCE)

    def test_known_component_capacity_wins_over_conflicting_combined_label(self):
        # Official ERCOT::21INR0029 has Battery 50 + Battery null but a
        # standardized Solar+Battery label. Keep the actual capacity attribution.
        record = {'q_id': '21INR0029', 'entity': 'ERCOT', 'region': 'ERCOT', 'state': 'TX',
                  'q_status': 'active', 'type_1': 'Battery', 'type_2': 'Battery',
                  'type_clean': 'Solar+Battery', 'mw_1': 50}
        projects, originals = parse_lbnl(fixture([record]), {**SOURCE, 'recordCount': 1})
        self.assertEqual(projects[0]['types'], ['storage'])
        self.assertEqual(projects[0]['storageMw'], 50)
        self.assertIsNone(projects[0]['generationMw'])
        self.assertEqual(projects[0]['capacityStatus'], 'partial')
        self.assertIn('type_clean_disagrees_with_capacity_components', originals[0]['_qualityFlags'])

    def test_discovery_uses_explicit_official_link(self):
        page = ('<a href="' + URL + '">Download</a>').encode()
        self.assertEqual(discover_lbnl_workbook(page, 'https://emp.lbl.gov/queues'), URL)
        relative = URL.replace('https://emp.lbl.gov', '')
        self.assertEqual(discover_lbnl_workbook(f'<a href="{relative}">file</a>'.encode(), SOURCE['url']), URL)
        for bad in [URL.replace('emp.lbl.gov', 'example.org'), URL.replace('https:', 'http:'),
                    URL.replace('emp.lbl.gov', 'user:secret@emp.lbl.gov'), URL + '?copy=1']:
            with self.assertRaises(ValueError):
                discover_lbnl_workbook(f'<a href="{bad}">file</a>'.encode(), SOURCE['url'])
        with self.assertRaises(ValueError):
            discover_lbnl_workbook(b'<p>File unavailable</p>', SOURCE['url'])

    def test_ambiguous_release_link_refused(self):
        other = URL.replace('/2026-05/', '/2026-06/')
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            discover_lbnl_workbook(f'<a href="{URL}">a</a><a href="{other}">b</a>'.encode(), SOURCE['url'])


if __name__ == '__main__':
    unittest.main()
