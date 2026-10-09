import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('historical_nyiso', ROOT / 'scripts/build-historical-nyiso.py')
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)
X = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def fixture(legend_change=False, formula=False):
    header = {'A': 'Queue Pos.', 'B': 'Project Name', 'C': 'SP (MW)', 'D': 'WP (MW)',
              'E': 'Type/ Fuel', 'F': 'State', 'G': 'S'}
    active = [header,
              {'A': 'L1', 'B': 'Construction example', 'C': '576', 'D': '507', 'E': 'L', 'F': 'NY', 'G': '12'},
              {'A': 'L2', 'B': 'Rejected cost allocation', 'C': 'N/A', 'D': 'N/A', 'E': 'L', 'F': 'NY', 'G': '8'},
              {'A': 'L3', 'B': 'Outside mainland', 'C': '500', 'D': '500', 'E': 'L', 'F': 'QC', 'G': '4'},
              {'A': 'L4', 'B': 'Withdrawn example', 'C': '100', 'D': '100', 'E': 'L', 'F': 'NY', 'G': '0'},
              {'A': 'G1', 'B': 'Generation excluded', 'C': '900', 'D': '900', 'E': 'S', 'F': 'NY', 'G': '12'}]
    legend = ', '.join(f'{i}={MOD.STATUSES[str(i)]}' for i in range(16))
    if legend_change:
        legend = legend.replace('12=Under Construction', '12=Not Under Construction')
    active.append({'A': f"● The column labeled 'S' refers to the status of the project. Key: {legend} ● Availability of Studies Key: None=Not Available"})
    table_rows = {'Interconnection Queue': active, 'Withdrawn': [{'G': 'Type/ Fuel'}, {'G': 'L'}],
                  'In Service': [{'G': 'Type/'}, {'G': 'L'}, {'G': 'L'}]}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        workbook = ET.Element(f'{{{X}}}workbook')
        sheets = ET.SubElement(workbook, f'{{{X}}}sheets')
        rels = ET.Element('Relationships')
        for index, (name, rows) in enumerate(table_rows.items(), 1):
            ET.SubElement(sheets, f'{{{X}}}sheet', {'name': name, f'{{{R}}}id': f'rId{index}'})
            ET.SubElement(rels, 'Relationship', {'Id': f'rId{index}', 'Target': f'worksheets/sheet{index}.xml'})
            sheet = ET.Element(f'{{{X}}}worksheet')
            sheet_data = ET.SubElement(sheet, f'{{{X}}}sheetData')
            for row_index, row in enumerate(rows, 1):
                node = ET.SubElement(sheet_data, f'{{{X}}}row')
                for column, value in row.items():
                    cell = ET.SubElement(node, f'{{{X}}}c', {'r': f'{column}{row_index}', 't': 'inlineStr'})
                    inline = ET.SubElement(cell, f'{{{X}}}is')
                    ET.SubElement(inline, f'{{{X}}}t').text = value
                    if formula and index == 1 and row_index == 2 and column == 'C':
                        ET.SubElement(cell, f'{{{X}}}f').text = '1+1'
            archive.writestr(f'xl/worksheets/sheet{index}.xml', ET.tostring(sheet))
        archive.writestr('xl/workbook.xml', ET.tostring(workbook))
        archive.writestr('xl/_rels/workbook.xml.rels', ET.tostring(rels))
        archive.writestr('xl/sharedStrings.xml', f'<sst xmlns="{X}"/>')
    return buffer.getvalue()


def metadata(data):
    url = f'https://web.archive.org/web/20231102050214id_/{MOD.ORIGINAL}'
    return dict(id='archive-20231102050214.xlsx', status=200, url=url, finalUrl=url,
                retrievedAt='2026-10-09T04:40:22.707944+00:00', bytes=len(data),
                sha256=hashlib.sha256(data).hexdigest())


class HistoricalNyisoTests(unittest.TestCase):
    def test_archive_capture_is_not_a_queue_asof_or_submission_date(self):
        data = fixture()
        value = MOD.build_vintage(data, metadata(data))
        self.assertEqual(value['dateBasis'], 'archive_capture')
        self.assertEqual(value['archiveCapturedAt'], '2023-11-02T05:02:14Z')
        self.assertIsNone(value['sourceAsOf'])
        self.assertIsNone(value['publishedAt'])
        summary = value['summaries'][0]
        self.assertEqual((summary['eligibleCount'], summary['ratedCount'], summary['unknownCount']), (2, 1, 1))
        self.assertEqual(summary['ratingMean'], 25)
        self.assertEqual(summary['loadMw'], 576)
        self.assertEqual(summary['winterMw'], 507)
        self.assertEqual(summary['capacityUnknownCount'], 1)
        self.assertEqual(value['capacityDefinition'], 'summer_mw')
        self.assertEqual(value['excludedCounts'], {'withdrawnSheet': 1, 'inServiceSheet': 2, 'ineligibleActiveSheet': 2})

    def test_changed_status_legend_and_formula_cells_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'status meaning'):
            MOD.parse_loads(fixture(legend_change=True))
        with self.assertRaisesRegex(ValueError, 'Formula'):
            MOD.parse_loads(fixture(formula=True))

    def test_wrong_hash_capture_redirect_or_retrieval_before_capture_rejected(self):
        data = fixture()
        original = metadata(data)
        for field, value in [('sha256', '0' * 64), ('finalUrl', original['url'].replace('20231102', '20251102')),
                             ('retrievedAt', '2022-01-01T00:00:00Z')]:
            meta = copy.deepcopy(original)
            meta[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                MOD.build_vintage(data, meta)

    def test_published_artifact_retains_actual_vintages_and_capacity_break(self):
        value = json.loads((ROOT / 'data/history-nyiso.json').read_text())
        self.assertEqual(value['modelVersion'], MOD.MODEL)
        vintages = value['vintages']
        self.assertEqual([v['summaries'][0]['eligibleCount'] for v in vintages], [10, 19, 31, 47, 53])
        self.assertEqual([v['summaries'][0]['loadMw'] for v in vintages], [1846.2, 3182.5, 6805.1, 11756.1, 14232.9])
        self.assertTrue(all(v['sourceAsOf'] is None for v in vintages))
        self.assertEqual(vintages[-1]['observedAt'], '2026-10-08T03:59:18.332Z')
        self.assertEqual(vintages[-1]['dateBasis'], 'observation')
        self.assertEqual(vintages[-1]['capacityDefinition'], 'peak_mw')
        self.assertTrue(vintages[-1]['capacityBreakBefore'])
        self.assertEqual(vintages[-1]['summaries'][0]['unknownCount'], 1)
        self.assertAlmostEqual(vintages[-1]['summaries'][0]['ratingMean'], 75.38461538461539)


if __name__ == '__main__':
    unittest.main()
