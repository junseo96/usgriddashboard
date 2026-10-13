import csv
from datetime import date
import io
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import transmission_northeast as ne


def report(header,rows):
    out=io.StringIO();w=csv.writer(out);w.writerow(['C','Synthetic official-format test fixture']);w.writerow(['H',*header])
    for row in rows:w.writerow(['D',*row])
    w.writerow(['T',str(len(rows))+' lines']);return out.getvalue().encode()


def plain(header,rows):
    out=io.StringIO();w=csv.writer(out);w.writerow(header);w.writerows(rows);return out.getvalue().encode()


class NortheastTransmissionTests(unittest.TestCase):
    def isone_fixture(self):
        names=[('n1','NETWORK NODE',-10),('n2','NETWORK NODE',10),('hub','HUB',1000),('z1','LOAD ZONE',2),('z2','LOAD ZONE',4)]
        prices=report(['Date','Hour Ending','Location','LMP','Energy','Congestion','Loss'],
                      [['10/12/2026','01',n,100+c+5,100,c,5] for n,t,c in names])
        mapping=report(['Date','Hour Ending','Location Name','Location Type','Location ID'],
                       [['10/12/2026','01',n,t,str(i)] for i,(n,t,c) in enumerate(names)])
        return prices,mapping

    def test_spatial_congestion_only_excludes_hub_and_keeps_zonal_cohort_separate(self):
        p,m=self.isone_fixture();points=ne.isone_prices(p,m,date(2026,10,12),['p','m'])
        self.assertEqual(len(points),2)
        nodes=next(r for r in points if r['population']=='physical_nodes')
        zones=next(r for r in points if r['population']=='load_zones')
        self.assertEqual(nodes['value'],16)
        self.assertAlmostEqual(zones['value'],1.6)
        self.assertEqual(nodes['market'],'RT')
        self.assertEqual(nodes['nodeCount'],2)
        self.assertEqual(nodes['start'],'2026-10-12T04:00:00Z')
        self.assertEqual(nodes['sourceIds'],['m','p'])

    def test_missing_same_day_classification_is_excluded_without_current_metadata_backfill(self):
        p,m=self.isone_fixture();m=m.replace(b'n1,NETWORK NODE',b'other,NETWORK NODE')
        diagnostics=[];points=ne.isone_prices(p,m,date(2026,10,12),['p','m'],diagnostics)
        self.assertEqual(len(points),1,'One classified physical node cannot yield a spatial spread')
        self.assertEqual(points[0]['population'],'load_zones')
        self.assertIn('n1',diagnostics[0])

    def test_report_footer_and_operating_date_guard_against_partial_or_wrong_sources(self):
        p,m=self.isone_fixture()
        with self.assertRaises(ValueError):ne.isone_prices(p.replace(b'5 lines',b'6 lines'),m,date(2026,10,12),['p','m'])
        with self.assertRaises(ValueError):ne.isone_prices(p,m,date(2026,10,13),['p','m'])
        with self.assertRaises(ValueError):ne.isone_prices(p.replace(b',95,100,-10,5',b',100,100,-10,5'),m,date(2026,10,12),['p','m'])

    def test_fall_back_hour_is_not_a_duplicate_and_ambiguous_nyiso_time_is_rejected(self):
        first=ne.hour_ending(date(2026,11,1),'02');second=ne.hour_ending(date(2026,11,1),'02X')
        self.assertEqual(first,('2026-11-01T05:00:00Z','2026-11-01T06:00:00Z'))
        self.assertEqual(second,('2026-11-01T06:00:00Z','2026-11-01T07:00:00Z'))
        with self.assertRaises(ValueError):ne.ny_timestamp({'Time Stamp':'11/01/2026 01:00:00'})
        self.assertEqual(ne.iso(ne.ny_timestamp({'Time Stamp':'11/01/2026 01:00:00','Time Zone':'EST'})),second[0])

    def test_final_binding_report_uses_start_time_and_excludes_reserve_requirements(self):
        h=['Date','Hour Ending','Marginal Value Interval','Constraint Name','Marginal Value']
        r=[['10/10/2026','05','04:10:00','BASE_INTRFC_MENH',-25],
           ['10/10/2026','05','04:10:00','SYSTEM_10MINSYNC',8]]
        prefix=b'"C","Real-Time Five Minute Binding Constraints Report, final version"\r\n"C","Report for: 10/10/2026 - 10/10/2026"\r\n'
        raw=prefix+report(h,r)
        diagnostics=[];points=ne.isone_constraints(raw,date(2026,10,10),['final','page'],diagnostics)
        self.assertEqual(len(points),1);self.assertTrue(points[0]['binding'])
        self.assertEqual(points[0]['start'],'2026-10-10T08:10:00Z')
        self.assertEqual(points[0]['end'],'2026-10-10T08:15:00Z')
        self.assertIn('SYSTEM_10MINSYNC',diagnostics[0])
        with self.assertRaises(ValueError):ne.isone_constraints(raw,date(2026,10,11),['final'])
        with self.assertRaises(ValueError):ne.isone_constraints(raw.replace(b'04:10:00',b'03:10:00'),date(2026,10,10),['final'])

    def test_final_published_date_and_day_window_do_not_fill_future_final_gaps(self):
        page=b'<a href="/transform/csv/fiveminconstraints?type=final&amp;start=20261010&amp;end=20261010">CSV</a>'
        latest=ne.isone_final_available(page);self.assertEqual(latest,date(2026,10,10))
        with self.assertRaises(ValueError):ne.isone_constraint_window(date(2026,10,11),latest,['final'])
        window=ne.isone_constraint_window(date(2026,11,1),date(2026,11,2),['final'])
        self.assertEqual(window['start'],'2026-11-01T04:00:00Z')
        self.assertEqual(window['end'],'2026-11-02T05:00:00Z')
        with self.assertRaises(ValueError):ne.isone_final_available(b'<html>No reports yet</html>')

    def test_nyiso_zonal_mcc_sign_and_all_eleven_zone_coverage(self):
        header=['Time Stamp','Time Zone','Name','PTID','LBMP ($/MWHr)','Marginal Cost Congestion ($/MWHr)']
        rows=[['10/12/2026 00:00:00','EDT',zone,i,100,i] for i,zone in enumerate(sorted(ne.NY_ZONES))]
        points=ne.nyiso_prices(plain(header,rows),date(2026,10,12),'ny')
        self.assertEqual(len(points),1)
        self.assertEqual(points[0]['p10'],-9);self.assertEqual(points[0]['p90'],-1);self.assertEqual(points[0]['value'],8)
        self.assertEqual(ne.nyiso_prices(plain(header,rows[:-1]),date(2026,10,12),'ny'),[])

    def test_integrated_load_requires_all_zones_and_keeps_mw_as_interval_average(self):
        header=['Time Stamp','Name','Integrated Load'];rows=[['10/12/2026 00:00:00',z,100] for z in sorted(ne.NY_ZONES)]
        loaded=ne.nyiso_load(plain(header,rows),date(2026,10,12),'load')
        self.assertEqual(loaded[0]['mw'],1100);self.assertEqual(loaded[0]['end'],'2026-10-12T05:00:00Z')
        self.assertEqual(ne.nyiso_load(plain(header,rows[:-1]),date(2026,10,12),'load'),[])
        with self.assertRaises(ValueError):ne.nyiso_load(plain(header,rows+[rows[0][:-1]+[101]]),date(2026,10,12),'load')

    def test_constraint_identity_retains_contingency_and_five_minute_interval(self):
        h=['Time Stamp','Limiting Facility','Facility PTID','Contingency','Constraint Cost($)']
        r=[['10/12/2026 00:00:00','Line A','123','Outage B',20],['10/12/2026 00:00:00','Line A','123','Outage C',30]]
        events=ne.nyiso_constraints(plain(h,r),date(2026,10,12),'constraints')
        self.assertEqual(len(events),2);self.assertNotEqual(events[0]['contingency'],events[1]['contingency'])
        self.assertEqual(events[0]['end'],'2026-10-12T04:05:00Z')
        self.assertTrue(events[0]['binding'])

    def test_interface_flow_uses_the_same_direction_limit_and_discloses_source_unit(self):
        h=['Timestamp','Interface Name','Flow (MWH)','Positive Limit (MWH)','Negative Limit (MWH)']
        r=[['10/12/2026 00:00:00','A',-40,100,-50],['10/12/2026 00:05:00','A',40,100,-50]]
        points=ne.nyiso_flows(plain(h,r),date(2026,10,12),'flows')
        self.assertEqual([p['value'] for p in points],[80,40])
        self.assertTrue(all('as published' in p['sourceUnit'] for p in points))
        self.assertTrue(all(p['intervalNature']=='instantaneous' for p in points))
        self.assertEqual(points[0]['end'],'2026-10-12T04:00:01Z')
        self.assertEqual(points[0]['sampleObservedAt'],points[0]['start'])

    def test_conflicting_interface_snapshots_and_unusable_limits_are_not_averaged(self):
        h=['Timestamp','Interface Name','Flow (MWH)','Positive Limit (MWH)','Negative Limit (MWH)']
        r=[['10/12/2026 00:00','A',40,100,-50],['10/12/2026 00:00','A',50,100,-50],
           ['10/12/2026 00:05','A',-40,100,-9999],['10/12/2026 00:10','A',-40,100,0],
           ['10/12/2026 00:15','A',60,100,-50],['10/12/2026 00:15','A',60,100,-50]]
        diagnostics=[];points=ne.nyiso_flows(plain(h,r),date(2026,10,12),'flows',diagnostics)
        self.assertEqual(len(points),1);self.assertEqual(points[0]['value'],60)
        self.assertIn('충돌 1개',diagnostics[0]);self.assertIn('한도 2개',diagnostics[0])

    def test_scheduled_interchange_is_excluded_from_physical_flow_ratios(self):
        h=['Timestamp','Interface Name','Flow (MWH)','Positive Limit (MWH)','Negative Limit (MWH)']
        r=[['10/12/2026 00:00','SCH - HQ - NY',450,100,-100],
           ['10/12/2026 00:00','SCH - PJ - NY',60,100,-100],
           ['10/12/2026 00:00','TOTAL EAST',80,100,-100]]
        diagnostics=[];points=ne.nyiso_flows(plain(h,r),date(2026,10,12),'flows',diagnostics)
        self.assertEqual([p['assetId'] for p in points],['TOTAL EAST'])
        self.assertEqual(points[0]['value'],80)
        self.assertIn('telemetry',points[0]['directionalBasis'])
        self.assertIn('SCH 계열 2개 원문행',diagnostics[0])

    def test_off_cycle_constraint_dispatch_clips_the_previous_five_minute_window(self):
        h=['Time Stamp','Limiting Facility','Facility PTID','Contingency','Constraint Cost($)']
        r=[['10/12/2026 00:00:00','Line A','123','Outage B',20],['10/12/2026 00:02:00','Line A','123','Outage B',30]]
        events=ne.nyiso_constraints(plain(h,r),date(2026,10,12),'constraints')
        self.assertEqual(events[0]['end'],events[1]['start'])
        self.assertEqual(events[1]['end'],'2026-10-12T04:07:00Z')


if __name__=='__main__':unittest.main()
