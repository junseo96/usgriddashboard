"""Safeguards for load evidence scope, provenance and electrical units."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

APP = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('load_pipeline_builder', APP / 'scripts/build-load-pipeline.py')
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bootstrap = json.loads((APP / 'data/bootstrap.json').read_text())
        cls.output = json.loads((APP / 'public/data/load-pipeline.json').read_text())
        cls.by_id = {p['id']: p for p in cls.output['projects']}
        cls.aggregates = {p['id']: p for p in cls.output['aggregates']}

    def test_public_checkout_rebuilds_without_archive_or_network(self):
        before = copy.deepcopy(self.bootstrap)
        self.assertEqual(pipeline.build(self.bootstrap, self.output['generatedAt']), self.output)
        self.assertEqual(self.bootstrap, before)

    def test_nyiso_links_all_statuses_without_duplicate_score_records(self):
        originals = [p for p in self.bootstrap['projects'] if p['sourceId'] == 'nyiso-load-register']
        for p in originals:
            row = self.by_id['register:' + p['id']]
            self.assertEqual(row['linkedProjectId'], p['id'])
            self.assertEqual(row['classification'], 'application')
            self.assertEqual(row['capacityMw'], p['loadMw'])
        self.assertEqual(sum(p['eligible'] for p in originals), 53)
        self.assertTrue(any(self.by_id['register:' + p['id']]['status'] == 'withdrawn' for p in originals))

    def test_closed_screens_and_transmission_milestones_are_not_operations(self):
        p = {'rawStatus': 'Tariff Closed', 'status': 'reference'}
        self.assertEqual(pipeline.record_status(p, 'california-sdge-register'), 'unknown')
        p = {'rawStatus': 'ENERGIZED', 'status': 'operational'}
        self.assertEqual(pipeline.record_status(p, 'bpa-ll-register'), 'unknown')

    def test_isone_formal_study_rows_do_not_turn_negated_construction_into_progress(self):
        records = [row for row in self.bootstrap['projects'] if row['sourceId'] == 'isone-selected-forecast']
        self.assertEqual(len(records), 2)
        for original in records:
            with self.subTest(project=original['id']):
                self.assertIn('not under construction', original['rawStatus'].lower())
                self.assertEqual(pipeline.record_status(original, original['sourceId']), 'active')
                projected = self.by_id['register:' + original['id']]
                self.assertEqual(projected['status'], 'active')
                self.assertIn(original['rawStatus'], projected['evidence'])
        affirmative = [row for row in self.bootstrap['projects'] if row['sourceId'] == 'nyiso-load-register' and row.get('rawStatus') == 'Under Construction']
        self.assertEqual(len(affirmative), 4)
        for original in affirmative:
            self.assertEqual(pipeline.record_status(original, original['sourceId']), 'construction')
            self.assertEqual(self.by_id['register:' + original['id']]['status'], 'construction')

    def test_negated_or_administrative_status_does_not_establish_physical_completion(self):
        for raw in ('Not under construction', 'Not yet under construction', 'Not cancelled'):
            with self.subTest(raw=raw):
                self.assertEqual(pipeline.record_status({'rawStatus': raw, 'status': 'active'}, 'nyiso-load-register'), 'active')
        for raw in ('Not operating', 'Not energized', 'Not yet in service', 'Tariff - Closed'):
            with self.subTest(raw=raw):
                self.assertEqual(pipeline.record_status({'rawStatus': raw, 'status': 'operational'}, 'nyiso-load-register'), 'unknown')
        self.assertEqual(pipeline.record_status({'rawStatus': 'ENERGIZED', 'status': 'reference'}, 'pjm-aes-contract-table'), 'unknown')
        self.assertEqual(pipeline.record_status({'rawStatus': 'Under Construction', 'status': 'withdrawn'}, 'nyiso-load-register'), 'withdrawn')
        self.assertEqual(pipeline.record_status({'rawStatus': 'Formal study agreement; not under construction', 'status': 'withdrawn'}, 'isone-selected-forecast'), 'withdrawn')
        self.assertEqual(pipeline.record_status({'rawStatus': 'Tariff - Cancelled', 'status': 'reference'}, 'california-pge-industrial-register'), 'withdrawn')

    def test_bpa_and_spp_support_capacity_not_customer_queue_capacity(self):
        records = [p for p in self.output['projects'] if p['classification'] == 'grid_support']
        self.assertGreater(len(records), 400)
        self.assertTrue(all(p['capacityMw'] is None and p['capacityBasis'] == 'unknown' for p in records))
        self.assertFalse(any('DPA-' in p['id'] for p in self.output['projects']))
        summary = self.aggregates['register-summary:spp-dpa-history']
        self.assertIsNone(summary['capacityMw'])
        self.assertIn('현재 대기', summary['scope'])

    def test_mva_compute_equipment_and_historical_estimates_not_grid_requests(self):
        for key in ('ercot-cnp-baytown-hydrogen', 'NAMED_META_HYPERION_LOUISIANA',
                    'NAMED_AVH1_CA', 'ercot-freeport-lng', 'ercot-cmc-seguin',
                    'southeast-industrial-plug-woodbine', 'southeast-industrial-fpl-cavendish'):
            p = self.by_id['named:' + key]
            self.assertIsNone(p['capacityMw'], key)
            self.assertEqual(p['capacityBasis'], 'unknown', key)
        self.assertEqual(self.by_id['named:NAMED_ORACLE_JUPITER_NM']['capacityBasis'], 'generation_mw')
        self.assertEqual(self.by_id['named:NAMED_ERCOT_IREN_CHILDRESS_MICROSOFT']['capacityBasis'], 'it_mw')

    def test_disclosed_service_application_does_not_invent_queue_link(self):
        google = self.by_id['named:NAMED_GOOGLE_DISK_DRIVE_CA']
        self.assertEqual((google['classification'], google['capacityMw'], google['capacityBasis']), ('application', 250, 'requested_grid_mw'))
        self.assertIsNone(google['linkedProjectId'])
        self.assertEqual(google['status'], 'planned')
        self.assertIn('최종 표결 전', google['evidence'])

    def test_unknown_factories_and_distinct_micron_sites_are_retained(self):
        for key in ('ercot-samsung-taylor', 'southeast-industrial-rivian-georgia',
                    'southeast-industrial-ford-tennessee', 'southeast-industrial-toyota-nc'):
            row = self.by_id['named:' + key]
            self.assertEqual(row['sector'], 'manufacturing')
            self.assertIsNone(row['capacityMw'])
        micron = self.by_id['register:IPUC::IPC-E-24-44']
        self.assertIsNone(micron['capacityMw'])
        self.assertEqual(micron['sector'], 'manufacturing')
        self.assertIn('register:NYISO::1627', self.by_id)
        self.assertIn('register:NYISO::1765', self.by_id)

    def test_aggregate_qualifiers_and_overlapping_population_counts(self):
        ercot = self.aggregates['disclosure:ERCOT_LARGE_LOAD_REQUESTS_20260618']
        self.assertEqual((ercot['capacityMw'], ercot['capacityQualifier']), (438000, 'greater_than'))
        self.assertIsNone(ercot['sourceAsOf'])  # Publication date is not a known extraction date.
        self.assertIsNone(ercot['projectCount'])
        mixed = self.aggregates['disclosure:ERCOT_LLWG_ALL_LOAD_STATUS_20260618']
        self.assertEqual(mixed['capacityBasis'], 'mixed_mw')
        self.assertIn('운영', mixed['scope'])
        dc = self.aggregates['disclosure:ERCOT_ONCOR_DC_REQUESTS_2026Q2']
        self.assertIsNone(dc['projectCount'])
        count = self.aggregates['disclosure:ERCOT_ONCOR_REQUEST_COUNT_2026Q2']
        self.assertEqual(count['projectCount'], 737)
        self.assertIsNone(count['capacityMw'])

    def test_regeneration_does_not_refresh_original_check_dates(self):
        regenerated = pipeline.build(self.bootstrap, '2030-01-01T00:00:00Z')
        original = {p['id']: (p['sourceAsOf'], p['checkedAt']) for p in self.output['projects']}
        for row in regenerated['projects']:
            self.assertEqual((row['sourceAsOf'], row['checkedAt']), original[row['id']])
        pge = next(p for p in regenerated['projects'] if p['id'].startswith('register:PG&E::'))
        self.assertEqual(pge['sourceAsOf'], '2025-06-30')
        self.assertEqual(pge['checkedAt'], '2026-10-03')
        samsung = self.by_id['named:ercot-samsung-taylor']
        self.assertEqual(samsung['sourceAsOf'], '2026-10-07')
        self.assertTrue(samsung['checkedAt'].startswith('2026-10-08T'))

    def test_duplicate_identifiers_invalid_units_and_false_precision_rejected(self):
        for collection in ('projects', 'aggregates'):
            d = copy.deepcopy(self.output)
            d[collection].append(d[collection][0])
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                pipeline.validate(d)
        for value in (-1, float('nan'), float('inf'), True):
            d = copy.deepcopy(self.output)
            d['projects'][0]['capacityMw'] = value
            with self.assertRaisesRegex(ValueError, 'Invalid MW'):
                pipeline.validate(d)
        d = copy.deepcopy(self.output)
        d['projects'][0]['capacityMw'] = 500
        d['projects'][0]['capacityBasis'] = 'unknown'
        with self.assertRaisesRegex(ValueError, 'Capacity basis'):
            pipeline.validate(d)

    def test_bad_dates_and_non_public_sources_rejected(self):
        for field, value in (('checkedAt', '2026-02-30'), ('sourceAsOf', '2026-13'), ('sourceUrl', 'javascript:alert(1)')):
            d = copy.deepcopy(self.output)
            d['projects'][0][field] = value
            with self.assertRaises(ValueError):
                pipeline.validate(d)

    def test_regional_coverage_covers_seven_explicit_non_additive_scopes(self):
        coverage = {row['region']: row for row in self.output['regionalCoverage']}
        self.assertEqual(set(coverage), set(pipeline.MARKET_REGIONS))
        self.assertEqual(coverage['ERCOT']['coverage'], 'operator_requests')
        self.assertEqual(coverage['NYISO']['coverage'], 'register_only')
        self.assertEqual(coverage['CAISO']['coverage'], 'regional_aggregate')
        for region in ('ISO-NE', 'MISO', 'PJM', 'SPP'):
            self.assertEqual(coverage[region]['coverage'], 'partial_pipeline')
        self.assertEqual(self.aggregates[coverage['MISO']['headlineAggregateId']]['capacityMw'], 26600)
        self.assertIn('disclosure:MISO_MTEP26_EPR_LOAD_20260817', coverage['MISO']['additionalAggregateIds'])
        self.assertEqual(self.aggregates[coverage['PJM']['headlineAggregateId']]['capacityQualifier'], 'greater_than')
        self.assertNotIn('totalMw', self.output)

    def test_cec_mixed_scope_keeps_rounding_provenance_and_pge_separate(self):
        row = next(item for item in self.output['regionalCoverage'] if item['region'] == 'CAISO')
        head = self.aggregates[row['headlineAggregateId']]
        parts = [self.aggregates[key] for key in row['additionalAggregateIds']]
        self.assertEqual((head['capacityMw'], head['capacityBasis'], head['projectCount']), (23278, 'mixed_mw', None))
        self.assertEqual((head['sourceAsOf'], head['publishedAt'], head['checkedAt']),
                         ('2025-12', '2026-08-12', '2026-10-11T23:20:32.686Z'))
        self.assertEqual(head['sourceSha256'], '3eba089b3020de5c1a7f9775e1f6cc7e7157f5b7247a1f857012dc5d17bafb73')
        self.assertEqual([part['capacityMw'] for part in parts], [5086, 9587, 8604, 12710])
        self.assertEqual(sum(part['capacityMw'] for part in parts[:3]), head['capacityMw'] - 1)
        self.assertEqual(parts[3]['sourceAsOf'], '2026-06-30')
        regenerated = pipeline.build(self.bootstrap, '2030-01-01T00:00:00Z')
        self.assertEqual(next(item for item in regenerated['aggregates'] if item['id'] == head['id']), head)

    def test_regulator_coverage_requires_reviewed_source_id_url_and_mixed_basis(self):
        for mutation in ('utility', 'region', 'url', 'path', 'basis', 'missing_mw', 'source_hash'):
            data = copy.deepcopy(self.output)
            row = next(item for item in data['regionalCoverage'] if item['region'] == 'CAISO')
            head = next(item for item in data['aggregates'] if item['id'] == row['headlineAggregateId'])
            if mutation == 'utility':
                row['headlineAggregateId'] = 'disclosure:WEST-PGE-20260630-DC-PIPELINE'
                row['additionalAggregateIds'] = []
            elif mutation == 'region': next(item for item in data['regionalCoverage'] if item['region'] == 'PJM')['coverage'] = 'regional_aggregate'
            elif mutation == 'url': head['sourceUrl'] = 'https://www.energy.ca.gov.example.org/source.pdf'
            elif mutation == 'path': head['sourceUrl'] = 'https://www.energy.ca.gov/unreviewed.pdf'
            elif mutation == 'basis': head['capacityBasis'] = 'requested_grid_mw'
            elif mutation == 'missing_mw': head['capacityMw'], head['capacityBasis'] = None, 'unknown'
            elif mutation == 'source_hash': head['sourceSha256'] = 'unverified'
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                pipeline.validate(data)

    def test_caiso_boundary_correction_changes_source_scope_without_refreshing_customer_data(self):
        registry = {row['id']: row for row in json.loads((APP / 'data/source-registry.json').read_text())}
        sources = {row['id']: row for row in self.bootstrap['sources']}
        corrections = {row['sourceId']: row for row in self.bootstrap['provenance']['sourceScopeCorrections']}
        for sid in ('california-ladwp', 'california-smud'):
            self.assertFalse(any(row['sourceId'] == sid for row in self.bootstrap['projects']))
            self.assertEqual(sources[sid], registry[sid])
            self.assertEqual(sources[sid]['region'], 'West')
            self.assertEqual(sources[sid]['lastCheckedAt'], '2026-10-03')
            self.assertEqual(corrections[sid]['scope'], 'source_metadata_only')
            self.assertEqual(corrections[sid]['projectRowsChanged'], 0)
            self.assertEqual(corrections[sid]['evidence']['retrievedAt'], '2026-10-11T23:16:42.634Z')
            self.assertEqual(corrections[sid]['evidence']['sourceSha256'], '6a8af55292efc937c391843fa1d0600601a664dc00c196524fcb53e1a6099b57')

    def test_nyiso_summary_uses_only_eligible_active_public_register_and_original_provenance(self):
        summary = self.aggregates['register-summary:nyiso-active-load']
        source = next(row for row in self.bootstrap['sources'] if row['id'] == 'nyiso-load-register')
        self.assertEqual((summary['capacityMw'], summary['projectCount']), (14232.9, 53))
        self.assertEqual((summary['sourceUrl'], summary['sourceAsOf'], summary['checkedAt']), (source['url'], source['sourceAsOf'], source['lastCheckedAt']))
        changed = copy.deepcopy(self.bootstrap)
        eligible = next(row for row in changed['projects'] if row['sourceId'] == 'nyiso-load-register' and row['eligible'])
        excluded = copy.deepcopy(eligible); excluded.update(id='NYISO::test-excluded', eligible=False, loadMw=999999)
        operating = copy.deepcopy(eligible); operating.update(id='NYISO::test-operating', status='operational', loadMw=999999)
        other = copy.deepcopy(eligible); other.update(id='OTHER::test', sourceId='another-source', loadMw=999999)
        changed['projects'] += [excluded, operating, other]
        self.assertEqual(pipeline.nyiso_active_register_summary(changed)['capacityMw'], 14232.9)
        self.assertEqual(pipeline.nyiso_active_register_summary(changed)['projectCount'], 53)
        missing = eligible['loadMw']; eligible['loadMw'] = None
        result = pipeline.nyiso_active_register_summary(changed)
        self.assertAlmostEqual(result['capacityMw'], 14232.9 - missing)
        self.assertEqual(result['projectCount'], 53)
        self.assertIn('미공개 1행', result['caveats'][0])

    def test_broken_regional_references_and_scope_promotions_fail_build(self):
        for mutation in ('missing', 'wrong_region', 'duplicate_region', 'duplicate_reference', 'operator_promotion', 'register_promotion'):
            coverage = copy.deepcopy(self.output['regionalCoverage'])
            row = next(item for item in coverage if item['region'] == 'PJM')
            if mutation == 'missing': row['headlineAggregateId'] = 'missing:row'
            elif mutation == 'wrong_region': row['additionalAggregateIds'].append('disclosure:ERCOT_LARGE_LOAD_REQUESTS_20260618')
            elif mutation == 'duplicate_region': coverage[-1] = copy.deepcopy(row)
            elif mutation == 'duplicate_reference': row['additionalAggregateIds'].append(row['headlineAggregateId'])
            elif mutation == 'operator_promotion': row['coverage'] = 'operator_requests'
            elif mutation == 'register_promotion': row['coverage'] = 'register_only'
            with self.subTest(mutation=mutation):
                with self.assertRaises(ValueError):
                    pipeline.build(self.bootstrap, self.output['generatedAt'], coverage)

    def test_new_primary_disclosures_keep_dates_qualifiers_and_stage_limits(self):
        isone = self.aggregates['disclosure:ISONE_CELT_SELECTED_LARGE_LOADS_20260327']
        miso = self.aggregates['disclosure:MISO_MTEP26_RECOMMENDED_LOAD_20261007']
        ercot = self.aggregates['disclosure:ERCOT_BATCHZERO_CONDITIONAL_BASE_20260903']
        self.assertEqual((isone['capacityMw'], isone['projectCount'], isone['sourceAsOf']), (285, 2, '2026-03-27'))
        self.assertIn('전체 접속 신청 명부가 아닙니다', isone['scope'])
        self.assertEqual((miso['capacityMw'], miso['projectCount'], miso['capacityQualifier'], miso['sourceAsOf']), (26600, None, 'approximate', '2026-08-19'))
        self.assertIn('532는 송전사업 수', ' '.join(miso['caveats']))
        self.assertEqual((ercot['capacityMw'], ercot['projectCount'], ercot['capacityBasis'], ercot['sourceAsOf']), (66400, 204, 'mixed_mw', '2026-09-03'))
        self.assertIn('이미 통전', ' '.join(ercot['caveats']))
        before = len(self.output['projects'])
        self.assertEqual(len(pipeline.build(self.bootstrap, '2030-01-01T00:00:00Z')['projects']), before)

    def test_multi_site_aws_and_alaska_not_individual_lower48_projects(self):
        self.assertNotIn('named:NAMED_DONLIN_GOLD_AK', self.by_id)
        self.assertNotIn('named:NAMED_AWS_NIPSCO_NORTHERN_INDIANA', self.by_id)
        aws = self.aggregates['disclosure:AWS_NIPSCO_NORTHERN_INDIANA']
        self.assertIsNone(aws['projectCount'])
        self.assertEqual(aws['capacityMw'], 2400)


if __name__ == '__main__':
    unittest.main()
