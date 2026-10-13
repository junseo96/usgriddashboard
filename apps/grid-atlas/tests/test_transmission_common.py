import sys
from pathlib import Path
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from transmission_common import hourly_price_spreads, quantile


class OperationalPriceMathTests(unittest.TestCase):
    def row(self,node,start,end,value):
        return dict(node=node,start=start,end=end,value=value,sourceIds=['evidence'])

    def test_signed_mcc_and_common_shift_invariance(self):
        values=[-50,-20,0,5,30]
        self.assertAlmostEqual(quantile(values,.9)-quantile(values,.1),58)
        self.assertAlmostEqual(quantile([x+1000 for x in values],.9)-quantile([x+1000 for x in values],.1),58)

    def test_node_temporal_average_precedes_spatial_percentile(self):
        rows=[]
        for node,first,last in [('A',0,100),('B',100,0)]:
            rows.extend([self.row(node,'2026-01-01T00:00:00Z','2026-01-01T00:30:00Z',first),self.row(node,'2026-01-01T00:30:00Z','2026-01-01T01:00:00Z',last)])
        result=hourly_price_spreads(rows,'MISO','RT','load_zones')
        self.assertEqual(len(result),1)
        self.assertEqual(result[0]['value'],0)
        self.assertEqual(result[0]['p10'],50)
        self.assertNotEqual(result[0]['value'],80) # Averaging subhourly spreads is wrong.

    def test_incomplete_node_is_excluded_not_zero_filled(self):
        rows=[self.row('A','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z',-10),self.row('B','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z',10),self.row('C','2026-01-01T00:00:00Z','2026-01-01T00:30:00Z',1000)]
        result=hourly_price_spreads(rows,'MISO','RT','load_zones')[0]
        self.assertEqual(result['nodeCount'],2)
        self.assertEqual(result['candidateNodeCount'],3)
        self.assertEqual(result['value'],16)

    def test_duplicate_conflict_and_overlap_rejected(self):
        first=self.row('A','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z',1)
        for other in [dict(first,value=2),dict(first,start='2026-01-01T00:30:00Z')]:
            with self.assertRaises(ValueError): hourly_price_spreads([first,other],'MISO','RT','load_zones')

    def test_missing_price_and_naive_timezone_rejected(self):
        for row in [self.row('A','2026-01-01T00:00:00Z','2026-01-01T01:00:00Z',None),self.row('A','2026-01-01T00:00:00','2026-01-01T01:00:00Z',0)]:
            with self.assertRaises(ValueError): hourly_price_spreads([row],'MISO','RT','load_zones')


if __name__=='__main__': unittest.main()
