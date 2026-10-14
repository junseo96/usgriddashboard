"""Research model numbers must not become grid applications or invented milestones."""
import copy
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('epoch_facilities', ROOT / 'scripts/facility-sources/epoch.py')
epoch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(epoch)


def row(date='2026-01-10', status='Groundwork and foundations are under construction.', buildings='0', it='0', power='0'):
    return {'Data center':'Example Virginia', 'Date':date, 'Construction status':status,
            'Buildings operational':buildings, 'IT power (MW)':it, 'Power (MW)':power}


def center(name='Example Virginia'):
    return {'Name':name, 'Country':'United States', 'Address':'10 Grid Rd, Ashburn, VA 20147',
            'Owner':'Example Company #confident', 'Current power (MW)':'100', 'Selected Sources':'Public source references'}


class EpochTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.acquisition = epoch.Acquisition(self.root, {})
        self.docs = [{'url':url,'sha256':str(i)*64,'retrievedAt':'2026-10-12T12:00:00Z'}
                     for i,url in enumerate([epoch.CENTERS,epoch.TIMELINES],1)]

    def normalize(self, rows, centers=None):
        return epoch.normalize(centers or [center()], rows, self.docs, self.acquisition, '2026-10-12', '2026-10-12')

    def test_forecasts_and_zero_online_power_do_not_create_past_capacity(self):
        f = self.normalize([row(), row('2028-01-01','Building 1 is operational.', '1','100','130')])[0]
        self.assertEqual(f['lifecycle'], 'construction')
        self.assertEqual([e['date'] for e in f['events']], ['2026-01-10'])
        self.assertEqual(f['capacityFacts'], [])
        self.assertEqual(f['gridEvidence'], [])

    def test_target_expiry_does_not_establish_operation(self):
        messages = ['Building 1 is estimated to be operational.',
                    'Building 1 is operational. Based on the stated completion date in the regulatory filing.',
                    'Building 1 should be operational 120 days after completion.',
                    'Building 1 is operational, based on typical construction timelines.',
                    'Building 1 is operational, based on the previous entry.',
                    'Building 1 is operational given it was announced completed 4 months ago.',
                    'Building 1 is operational, based on no construction activity around the shell.']
        for message in messages:
            with self.subTest(message=message):
                f = self.normalize([row(),row('2026-08-01',message,'1','100','130')])[0]
                self.assertNotEqual(f['lifecycle'], 'operating')
                self.assertNotIn('operating', [e['status'] for e in f['events']])

    def test_numeric_modeled_buildings_without_narrative_do_not_establish_operation(self):
        f = self.normalize([row('2026-08-01','','4','100','130')])[0]
        self.assertEqual(f['lifecycle'],'unknown')
        self.assertEqual(f['events'],[])

    def test_reviewed_partial_operation_cannot_complete_all_campus_gates(self):
        name='CoreWeave Marble NC'
        reviewed={**row('2026-05-06','Core Scientific said Marble was fully handed over to CoreWeave with about 65 MW of billable customer power online.','1','65','90'),'Data center':name}
        f = self.normalize([reviewed],[center(name)])[0]
        self.assertEqual(f['lifecycle'],'construction')
        self.assertTrue(all(e['status'] != 'operating' for e in f['events']))
        self.assertIn('검토한 운영 근거',f['events'][0]['note'])
        self.assertEqual(f['asOf'],'2026-05-06')
        self.assertEqual(f['gridEvidence'],[])
        self.assertEqual({c['measure'] for c in f['capacityFacts']},{'it_power','facility_power'})
        self.assertTrue(all(c['scope']=='phase' for c in f['capacityFacts']))
        self.assertFalse(any(c['measure'] in ('requested_grid','contracted_grid') for c in f['capacityFacts']))

    def test_partial_operation_and_new_expansion_remain_construction(self):
        name='Google Bristow'
        rows=[row('2024-04-29','Building 1 is operational, based off of colored motion artifacts from cooling towers.  Building 2 is undergoing construction.','1','100','130'),
              row('2026-09-01','Building 2 roof and foundations under construction.','1','100','130')]
        f = self.normalize([{**r,'Data center':name} for r in rows],[center(name)])[0]
        self.assertEqual(f['lifecycle'],'construction')

    def test_actual_provider_timing_inferences_never_establish_operation(self):
        cases=[('STACK Infrastructure NVA02','2024-10-01','Building 1 is operational, which is assumed to be three months after the last backup diesel generators are finished.'),
               ('Anthropic-Amazon New Carlisle','2025-06-23','Buildings 1-7 are operational. Based on all of the roofs being completed for over 5 months.'),
               ('Google Pryor (North)','2024-07-19','Building 1 is operational, based on default roof-to-operational time.'),
               ('Google Council Bluffs (East)','2024-11-19','Building 1 is operational. So our best guess is in the middle, in November 2024.'),
               ('Google Mesa','2025-07-01','Building 1 is operational. Equipment appears cleared by this date, 4 months later, with September imagery providing an upper bound.'),
               ('Microsoft SAT14','2026-03-31','Building 2 fully operational. TDLR phases have a completion date of 2026-03-31.'),
               ('Unreviewed facility','2026-01-01','Building 1 is confirmed operational via spinning cooling fans.')]
        for name,date,text in cases:
            with self.subTest(name=name):
                f=self.normalize([{**row(date,text,'1','100','130'),'Data center':name}],[center(name)])[0]
                self.assertNotEqual(f['lifecycle'],'operating')
                self.assertFalse(any(e['status']=='operating' for e in f['events']))

    def test_changed_reviewed_narrative_requires_new_review(self):
        reviewed={**row('2026-05-06','Core Scientific said Marble was fully handed over to CoreWeave with about 65 MW of billable customer power online.','1','65','90'),'Data center':'CoreWeave Marble NC'}
        self.assertIsNotNone(epoch.operating_confirmation(reviewed))
        reviewed['Construction status']+=' This date is only assumed.'
        self.assertIsNone(epoch.operating_confirmation(reviewed))
        self.assertNotEqual(epoch.observed_status(reviewed),'operating')

    def test_reviewed_evidence_date_overrides_earlier_csv_estimate(self):
        name='Google Pryor (North)'
        r={**row('2026-09-06','Building 2 is operational, confirmed via RAAD drone imagery of spinning cooling tower fans on September 8th.','1','100','130'),'Data center':name}
        f=self.normalize([r],[center(name)])[0]
        self.assertEqual(f['events'][0]['date'],'2026-09-08')
        self.assertEqual(f['asOf'],'2026-09-08')
        early=epoch.normalize([center(name)],[r],self.docs,self.acquisition,'2026-09-07','2026-09-07')[0]
        self.assertEqual(early['events'],[])
        self.assertNotEqual(early['lifecycle'],'operating')

    def test_unknown_values_stay_unknown_and_invalid_numbers_fail(self):
        self.assertIsNone(epoch.number(''))
        for value in ['NaN','inf','-1','not MW']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                epoch.number(value)

    def test_csv_schema_and_foreign_timeline_names_fail_closed(self):
        with self.assertRaises(ValueError):
            epoch.parse_csv(b'<html>error</html>', ['Name','Address'])
        with self.assertRaises(ValueError):
            self.normalize([{**row(),'Data center':'Missing facility'}])
        with self.assertRaises(ValueError):
            self.normalize([row(),row()])

    def test_non_us_and_non_mainland_facilities_are_excluded(self):
        centers = [center(), {**center('Canada facility'),'Country':'Canada'},
                   {**center('Hawaii facility'),'Address':'1 Grid Rd, Honolulu, HI 96801'}]
        self.assertEqual(len(self.normalize([row()],centers)),1)

    def test_name_and_address_geography_is_labelled_an_estimate(self):
        f = self.normalize([row()])[0]
        self.assertEqual((f['state'],f['city'],f['region']),('VA','Ashburn','PJM'))
        self.assertEqual(f['regionBasis'],'geographic_estimate')
        self.assertEqual(f['operator'],'Example Company')

    def test_missing_facility_retained_and_old_facts_and_sources_not_deleted(self):
        current = self.normalize([row()])
        old = copy.deepcopy(current[0])
        old['id']='old-missing'
        previous={'facilities':[old,copy.deepcopy(current[0])]}
        previous['facilities'][1]['events'][0]['sourceIds']=['older-source']
        merged=epoch.merge_previous(previous,current)
        self.assertEqual(len(merged),2)
        event=next(f for f in merged if f['id']!='old-missing')['events'][0]
        self.assertIn('older-source',event['sourceIds'])

    def test_acquisition_failure_preserves_existing_fragment_and_records_failure(self):
        output=self.root/'fragment.json'
        previous={'sources':[],'facilities':[{'id':'keep'}]}
        output.write_text(json.dumps(previous))
        before=output.read_bytes()
        with mock.patch.object(epoch.Acquisition,'fetch',side_effect=ValueError('HTTP 503')):
            code=epoch.collect(output,self.root/'failed')
        self.assertEqual(code,1)
        self.assertEqual(output.read_bytes(),before)
        self.assertEqual(json.loads((self.root/'failed/report.json').read_text())['status'],'failed')

    def test_published_evidence_has_only_relevant_normalized_fields(self):
        c={**center(),'Current chip types':'Secret accelerator example','Current total capital cost':'999'}
        self.normalize([row()], [c])
        excerpts=' '.join(s['excerpt'] for s in self.acquisition.sources.values())
        self.assertNotIn('Secret accelerator example',excerpts)
        self.assertNotIn('total capital cost',excerpts)
        self.assertIn('researchStatus',excerpts)


if __name__ == '__main__':
    unittest.main()
