import importlib.util
import json
from pathlib import Path
import sys
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import transmission_pjm_snapshot as pjm


def payload(values):
    return json.dumps(dict(fields=[dict(name=name) for name in ['ZONE_OPS_KEY', 'OPS_ZONE_NAME', 'MCC_VALUE', 'PRICE', 'MLC_VALUE']],
                           features=[dict(attributes=dict(ZONE_OPS_KEY=i, OPS_ZONE_NAME=f'ZONE-{i}', MCC_VALUE=value, PRICE=1000+i, MLC_VALUE=-20)) for i, value in enumerate(values)] )).encode()


class PublicPjmSnapshotTests(unittest.TestCase):
    def test_signed_mcc_not_total_lmp_and_no_manufactured_operating_time(self):
        row = pjm.parse_snapshot(payload([-20, -10, 0, 10, 20]), 'public-source', '2026-10-13T10:55:00Z')
        self.assertAlmostEqual(row['value'], 32)
        self.assertEqual((row['min'], row['max']), (-20, 20))
        self.assertIsNone(row['sourceObservedAt'])
        self.assertEqual(row['capturedAt'], '2026-10-13T10:55:00Z')
        self.assertNotIn('start', row)
        self.assertNotIn('end', row)

    def test_missing_mcc_stays_missing_and_quantile_can_miss_one_localized_zone(self):
        row = pjm.parse_snapshot(payload([-.69] + [.04]*20 + [None]), 'source', '2026-10-13T10:55:00Z')
        self.assertEqual(row['value'], 0)
        self.assertEqual((row['nodeCount'], row['candidateNodeCount']), (21, 22))
        self.assertAlmostEqual(row['max']-row['min'], .73)

    def test_changed_schema_truncation_duplicate_and_nonfinite_values_fail(self):
        for change in [lambda data: data.update(exceededTransferLimit=True),
                       lambda data: data.update(fields=[]),
                       lambda data: data['features'].append(data['features'][0]),
                       lambda data: data['features'][0]['attributes'].update(MCC_VALUE=float('nan'))]:
            data = json.loads(payload([1, 2, 3]))
            change(data)
            with self.assertRaises(ValueError):
                pjm.parse_snapshot(json.dumps(data).encode(), 'source', '2026-10-13T10:55:00Z')


if __name__ == '__main__':
    unittest.main()
