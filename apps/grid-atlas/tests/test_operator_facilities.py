"""Regression cases for advertised capacity versus actual facility lifecycle."""
import importlib.util
import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts' / 'facility-sources'))
SPEC = importlib.util.spec_from_file_location('operator_facilities', ROOT / 'scripts' / 'facility-sources' / 'operators.py')
COLLECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COLLECTOR)


def receipt(slug):
    return {'url': 'https://q.com/data-centers/' + slug + '/', 'retrievedAt': '2026-10-12T08:00:00.000Z', 'sha256': 'a' * 64}


class OperatorLifecycleTests(unittest.TestCase):
    def test_neighboring_operating_buildings_do_not_open_future_iad4(self):
        facility = {'notes': []}
        COLLECTOR.describe_lifecycle(facility, 'IAD4 will join the two existing facilities (IAD1, IAD3) already in operation. IAD4 will provide 20MW.')
        self.assertEqual(facility['lifecycle'], 'planned')

    def test_partial_completion_does_not_complete_entire_property(self):
        facility = {'notes': []}
        COLLECTOR.describe_lifecycle(facility, 'This property currently under construction. The first phase is substantially complete. Construction of the second phase is currently under way.')
        self.assertEqual(facility['lifecycle'], 'construction')

    def test_actual_opening_beats_narrative_final_building_to_be_built(self):
        facility = {'notes': []}
        COLLECTOR.describe_lifecycle(facility, 'SLC6 is the final data center to be built on the campus. SLC6 opened in 2023 and will feature ample raised flooring.')
        self.assertEqual(facility['lifecycle'], 'operating')

    def test_listing_is_marked_as_inferred_and_has_no_grid_event(self):
        facility = {'notes': []}
        COLLECTOR.describe_lifecycle(facility, 'The data center offers carrier-neutral colocation services.')
        self.assertEqual(facility['lifecycle'], 'operating')
        self.assertTrue(any('운영 추정:' in note and '통전 완료' in note for note in facility['notes']))

    def test_own_building_description_beats_template_hours_of_operation(self):
        page = '<h1>South Fulton Data Center</h1><p>(ATL4) 200 Selig Dr SW - Atlanta, GA 30336</p><p>ATL4 will deliver 40MW of critical IT load.</p><p>212,710 IT Square Feet 40MW Critical IT Load Support 7x24x365 Hours of Operation</p>'
        facility, _ = COLLECTOR.databank(page, receipt('atl4'))
        self.assertEqual(facility['lifecycle'], 'planned')

    def test_conflicting_undated_site_video_is_not_definite_operation(self):
        page = '<h1>Lithia Springs Campus Data Center</h1><p>(ATL5) 4764 Bakers Ferry Rd. SW - South Fulton, GA 30336</p><p>ATL5 is the first facility deployed.</p><p>160,200 IT Square Feet 48MW Critical IT Load</p><p>Currently under construction, this campus will feature ATL5 and ATL6.</p>'
        facility, evidence = COLLECTOR.databank(page, receipt('atl5'))
        self.assertEqual(facility['lifecycle'], 'unknown')
        self.assertIn('Currently under construction', evidence['excerpt'])
        self.assertFalse(any(note.startswith('운영 추정:') for note in facility['notes']))

    def test_building_specs_after_cta_and_actual_city_are_used(self):
        page = '<h1>Denver 1</h1><p>Our Aurora-Denver data center offers space.</p><p>Contact sales</p><p>Our data center campus features Critical campus capacity 160 MW+ Building specifications Planned 160 MW+ of critical power capacity.</p><p>Location 1160 N Gun Club Rd, Aurora, Colorado 80018</p>'
        facility, _ = COLLECTOR.qts(page, receipt('denver'))
        self.assertEqual((facility['lifecycle'], facility['city'], facility['state']), ('planned', 'Aurora', 'CO'))
        self.assertEqual(facility['capacityFacts'][0]['value'], 160)

    def test_other_project_solar_news_does_not_set_facility_status(self):
        page = '<h1>Hillsboro 3</h1><p>A data center in Oregon.</p><p>Contact sales</p><p>Avangrid Finishes Construction of New Oregon Solar Project is now open and will deliver energy. Learn more Learn more</p><p>Our data center campus features Planned 2-building campus Critical Campus Capacity 100+ MW+</p>'
        facility, _ = COLLECTOR.qts(page, receipt('hillsboro-3'))
        self.assertEqual(facility['lifecycle'], 'planned')
        self.assertEqual(facility['capacityFacts'][0]['value'], 100)


if __name__ == '__main__':
    unittest.main()
