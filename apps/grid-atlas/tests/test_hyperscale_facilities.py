"""No-network regression checks for real inventory semantics and failure safety."""
import copy, importlib.util, json, pathlib, sys, tempfile, unittest
from unittest.mock import patch
APP_ROOT=pathlib.Path(__file__).resolve().parents[1]
SOURCE_DIR=APP_ROOT/'scripts'/'facility-sources'
sys.path.insert(0,str(SOURCE_DIR))
spec=importlib.util.spec_from_file_location('hyperscale',SOURCE_DIR/'hyperscale.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
DATA=APP_ROOT/'data'/'large-load-facility-fragments'/'hyperscale.json'

class HyperscaleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.data=json.loads(DATA.read_text());cls.rows={f['id']:f for f in cls.data['facilities']}
    def test_google_marketing_area_not_counted_as_fourth_sc_site(self):
        rows=[x for x in self.rows.values() if x['operator']=='Google' and x['state']=='SC']
        self.assertEqual({x['city'] for x in rows},{'Moncks Corner','Summerville','St. George'})
        self.assertFalse(any('Lowcountry' in x['name'] for x in rows))
    def test_meta_specific_operational_statement_overrides_template_future(self):
        self.assertEqual(self.rows['LLF-HS-meta-temple-tx']['lifecycle'],'operating')
        self.assertEqual(self.rows['LLF-HS-meta-montgomery-al']['lifecycle'],'construction')
        self.assertEqual(self.rows['LLF-HS-meta-huntsville-al']['lifecycle'],'operating')
        self.assertFalse(any(f['capacityFacts'] for f in self.rows.values() if f['operator']=='Meta'))
    def test_planned_dates_do_not_become_actual_events(self):
        apollo=self.rows['LLF-HS-cipher-apollo']
        self.assertTrue(all(e['date']<'2030' for e in apollo['events']))
        self.assertEqual(self.rows['LLF-HS-microsoft-wiseman-boulevard']['lifecycle'],'construction')
        self.assertEqual(self.rows['LLF-HS-microsoft-la-porte']['lifecycle'],'construction')
    def test_abilene_partial_ai_workloads_do_not_complete_eight_building_campus(self):
        f=self.rows['LLF-HS-oracle-abilene']
        self.assertEqual(f['lifecycle'],'unknown')
        self.assertEqual({e['kind'] for e in f['gridEvidence']},{'unknown'})
        self.assertTrue(any('8동 전체' in note for note in f['notes']))
        class Source:
            def __init__(self):
                self.home={'raw':'<a href="https://www.oracle.com/data-centers/abilene/">Abilene</a>'}
                self.detail={'raw':'<h1>Abilene</h1>AI workloads went live less than a year after construction began. The campus consists of eight buildings on 1,100 acres.', 'id':'source'}
            def fetch(self,url):
                return self.home if url==h.ORACLE else self.detail if url==h.ORACLE+'abilene/' else None
            def batch(self,urls):pass
            def evidence(self,*args,**kwargs):return 'source'
        parsed=h.parse_oracle(Source())[0]
        self.assertEqual(parsed['lifecycle'],'unknown')
        self.assertTrue(all(e['kind']!='energized' for e in parsed['gridEvidence']))
    def test_cipher_expansion_parent_not_independent_campus(self):
        f=self.rows['LLF-HS-cipher-barber-lake-expansion']
        self.assertEqual(f['parentId'],'LLF-HS-cipher-barber-lake');self.assertEqual(f['identityKind'],'phase')
    def test_legacy_drilldown_identifiers_are_never_census_entity_ids(self):
        self.assertFalse(any(x.startswith(('site:','request:')) for f in self.rows.values() for x in f['legacyProjectIds']))
    def test_merge_preserves_missing_source_records_and_old_events(self):
        old=h.facility('old','Existing site','Operator','OH');old['events']=[{'id':'event-old','date':'2024-01-01'}]
        current=copy.deepcopy(old);current['events']=[{'id':'event-new','date':'2025-01-01'}]
        missing=h.facility('missing','Temporarily absent page','Operator','OH')
        result=h.merge_previous({'facilities':[old,missing]},[current])
        self.assertEqual(len(result),2);self.assertEqual(len(result[0]['events']),2)
    def test_merge_retains_dated_basis_only_for_unchanged_lifecycle(self):
        old=h.facility('dated','Verified site','Operator','TX',status='construction',sources=['dated-source'])
        old['asOf']='2026-08-04'
        for status,date,expected in [('construction',None,'2026-08-04'),('operating',None,None),('construction','2026-09-01','2026-09-01')]:
            with self.subTest(status=status,date=date):
                current=h.facility('dated','Verified site','Operator','TX',status=status,sources=['current-source'])
                current['asOf']=date
                merged=h.merge_previous({'facilities':[old]},[current])[0]
                self.assertEqual(merged['asOf'],expected)
                self.assertEqual(merged['lifecycle'],status)
                self.assertEqual(merged['sourceIds'],['dated-source','current-source'])
    def test_all_source_failure_keeps_exact_last_good_file(self):
        with tempfile.TemporaryDirectory() as td:
            p=pathlib.Path(td)/'output.json';p.write_text(json.dumps(self.data));before=p.read_bytes()
            with patch.object(h.Collector,'fetch',return_value=None):
                rc=h.collect(p,pathlib.Path(td)/'state')
            self.assertEqual(rc,1);self.assertEqual(p.read_bytes(),before)
            self.assertEqual(json.loads((pathlib.Path(td)/'state/report.json').read_text())['status'],'failed')
    def test_integrity(self):h.validate(self.data)

if __name__=='__main__':unittest.main()
