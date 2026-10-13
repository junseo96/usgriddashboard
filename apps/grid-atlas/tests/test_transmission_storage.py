import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import transmission_storage as storage


def fragment(region='MISO'):
    source = dict(id='official-source', title='Actual source', url='https://example.org/report', publisher='ISO', retrievedAt='2026-01-10T00:00:00Z', sha256='a' * 64, extraSource={'preserve': True})
    def row(start, end, **fields):
        return dict(region=region, start=start, end=end, sourceIds=[source['id']], **fields)
    result = dict(region=region, sources=[source], coverage=[dict(region=region, metric='load', status='observed', reason='Current report')], notes=['Actual retained history'], extra={'futureField': [1, None, 'value']})
    result.update({kind: [] for kind in storage.ARRAYS})
    # Deliberately not time-sorted: partitioning must not change summation order.
    result['priceIntervals'] = [row('2026-01-06T00:00:00Z', '2026-01-06T01:00:00Z', value=0.1, extraRecord={'unit': '$/MWh'}), row('2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z', value=0.2)]
    result['constraintWindows'] = [row('2026-01-04T23:55:00Z', '2026-01-06T00:00:00Z', audit='Window crosses UTC ISO weeks')]
    result['constraintIntervals'] = [row('2026-01-05T00:00:00Z', '2026-01-05T00:05:00Z', assetId='line', contingency='N-1', binding=True)]
    result['loadIntervals'] = [row('2026-01-05T00:00:00+09:00', '2026-01-05T01:00:00+09:00', mw=1234)]
    result['utilizationIntervals'] = [row('2026-01-07T00:00:00Z', '2026-01-07T01:00:00Z', assetId='line', flowMw=40, limitMw=100, value=40)]
    result['curtailmentIntervals'] = [row('2026-01-08T00:00:00Z', '2026-01-08T01:00:00Z', mwh=12, reason='transmission')]
    result['priceSnapshots'] = [dict(region=region, capturedAt='2026-01-09T00:15:00Z', observedAt=None, sourceIds=[source['id']], value=4, extraSnapshot='retained')]
    return result


class TransmissionStorageTests(unittest.TestCase):
    def test_lossless_roundtrip_all_arrays_extra_fields_order_and_source_references(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            rows = [fragment('MISO'), fragment('PJM')]
            original = copy.deepcopy(rows)
            storage.store_group(root, 'midwest', rows)
            self.assertEqual(rows, original, 'Storage must not mutate normalized inputs')
            self.assertEqual(storage.load_group(root, 'midwest'), original)
            manifest = json.loads((root / 'midwest/metadata.json').read_text())
            self.assertEqual(len(manifest['fragments']), 2)
            for item in manifest['fragments']:
                self.assertEqual(item['fragment']['sources'], original[0]['sources'])
                self.assertFalse(any(key in item['fragment'] for key in storage.ARRAYS))
                self.assertEqual({Path(part['path']).name[:8] for part in item['parts']}, {'2026-W01', '2026-W02'})
                for entry in item['parts']:
                    part = json.loads((root / 'midwest' / entry['path']).read_text())
                    self.assertEqual(part['sources'], [])
                    self.assertNotIn('coverage', part)
                    self.assertNotIn('notes', part)
                    for kind in storage.ARRAYS:
                        for row in part.get(kind, []):
                            self.assertEqual(row['sourceIds'], ['official-source'])
            # Offset time is bucketed by UTC week without rewriting its timestamp.
            week1 = [entry for entry in manifest['fragments'][0]['parts'] if '2026-W01' in entry['path']]
            self.assertEqual(sum(len(json.loads((root / 'midwest' / e['path']).read_text()).get('loadIntervals', [])) for e in week1), 1)

    def test_iso_ne_safe_slug_and_empty_arrays_remain_lossless(self):
        with tempfile.TemporaryDirectory() as temp:
            row = dict(region='ISO-NE', sources=[], notes=[], coverage=[], priceSnapshots=[], loadIntervals=[])
            storage.store_group(Path(temp), 'northeast', [row])
            self.assertEqual(storage.load_group(Path(temp), 'northeast'), [row])
            self.assertEqual(list((Path(temp) / 'northeast').rglob('*-W*.json')), [])

    def test_legacy_migration_then_latest_coverage_replaces_old_and_only_owned_parts_purged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = fragment()
            legacy = root / 'midwest.json'
            legacy.write_text(json.dumps([old]))
            self.assertEqual(storage.load_group(root, 'midwest'), [old])
            storage.store_group(root, 'midwest', [old])
            self.assertFalse(legacy.exists())
            previous_parts = set((root / 'midwest').glob('*/*-W*.json'))
            unrelated = root / 'midwest/MISO/review-notes.json'
            unrelated.write_text('{"doNotDelete":true}')
            fresh = copy.deepcopy(old)
            fresh['coverage'] = [dict(region='MISO', metric='load', status='partial', reason='Newest collection failed')]
            fresh['notes'] = ['Newest declaration only']
            fresh['priceIntervals'] = fresh['priceIntervals'][:1]
            storage.store_group(root, 'midwest', [fresh])
            self.assertEqual(storage.load_group(root, 'midwest'), [fresh])
            manifest = json.loads((root / 'midwest/metadata.json').read_text())
            current = {root / 'midwest' / part['path'] for item in manifest['fragments'] for part in item['parts']}
            self.assertTrue(all(not path.exists() for path in previous_parts - current))
            self.assertTrue(unrelated.exists())

    def test_partition_limit_chunks_large_week_and_reassembles_exact_order(self):
        with tempfile.TemporaryDirectory() as temp:
            row = fragment()
            row['loadIntervals'] *= 20
            with patch.object(storage, 'MAX_PART_BYTES', 1800):
                storage.store_group(Path(temp), 'midwest', [row])
            parts = list((Path(temp) / 'midwest').glob('*/*-W*.json'))
            self.assertGreater(len(parts), 2)
            self.assertTrue(all(part.stat().st_size <= 1800 for part in parts))
            self.assertEqual(storage.load_group(Path(temp), 'midwest'), [row])

    def test_failed_manifest_write_keeps_previous_state_and_legacy_readable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old, fresh = fragment(), fragment()
            storage.store_group(root, 'midwest', [old])
            before = (root / 'midwest/metadata.json').read_bytes()
            fresh['priceIntervals'][0]['value'] = 777
            real_write = storage._atomic_write
            def fail_manifest(path, payload):
                if path.name == 'metadata.json':
                    raise OSError('Simulated publication failure')
                real_write(path, payload)
            with patch.object(storage, '_atomic_write', side_effect=fail_manifest):
                with self.assertRaisesRegex(OSError, 'publication failure'):
                    storage.store_group(root, 'midwest', [fresh])
            self.assertEqual((root / 'midwest/metadata.json').read_bytes(), before)
            self.assertEqual(storage.load_group(root, 'midwest'), [old])
            legacy = root / 'midwest.json'
            legacy.write_text(json.dumps([old]))
            with patch.object(storage, '_atomic_write', side_effect=fail_manifest):
                with self.assertRaises(OSError):
                    storage.store_group(root, 'midwest', [fresh])
            self.assertTrue(legacy.exists())
            self.assertEqual(storage.load_group(root, 'midwest'), [old])

    def test_unsafe_groups_regions_manifest_paths_symlinks_and_tampering_reject(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for group in ('../escape', 'midwest/../../escape', 'unrelated', '/tmp/escape'):
                with self.assertRaises(ValueError):
                    storage.store_group(root, group, [fragment()])
            for region in ('../PJM', 'NYISO/../../escape', 'unknown'):
                with self.assertRaises(ValueError):
                    storage.store_group(root, 'midwest', [dict(region=region)])
            storage.store_group(root, 'midwest', [fragment()])
            meta = root / 'midwest/metadata.json'
            document = json.loads(meta.read_text())
            part_path = root / 'midwest' / document['fragments'][0]['parts'][0]['path']
            part_path.write_bytes(part_path.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, 'integrity'):
                storage.load_group(root, 'midwest')
            document['fragments'][0]['parts'][0]['path'] = '../../outside.json'
            meta.write_text(json.dumps(document))
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                storage.load_group(root, 'midwest')
            (root / 'west').symlink_to(root / 'midwest', target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symlink'):
                storage.load_group(root, 'west')

    def test_gather_mixed_legacy_partitioned_groups_ignores_unrelated_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            midwest, iso_ne = fragment(), fragment('ISO-NE')
            storage.store_group(root, 'midwest', [midwest])
            (root / 'northeast.json').write_text(json.dumps(iso_ne))
            (root / 'report.json').write_text('not even JSON')
            (root / 'unrelated').mkdir()
            (root / 'unrelated/metadata.json').write_text('not a manifest')
            self.assertEqual(storage.gather_fragments(root), [midwest, iso_ne])
            self.assertEqual(storage.load_group(root, 'spp'), [])


if __name__ == '__main__':
    unittest.main()
