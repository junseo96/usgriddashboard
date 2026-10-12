"""Offline regressions for repeated industrial inventory acquisition and lineage."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "scripts" / "facility-sources"
sys.path.insert(0, str(SOURCE_DIR))
SPEC = importlib.util.spec_from_file_location("industrial_facilities", SOURCE_DIR / "industrial.py")
COLLECTOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COLLECTOR)

ASPEN_IDS = [
    "LLF-ind-doe-aspen-aerogels-register-ga-8b7d09c8",
    "LLF-ind-doe-aspen-aerogels-register-ga-cb09f390",
]
SEC_URL = "https://www.sec.gov/Archives/edgar/data/1145986/000119312526340275/aspn-20260630.htm"


def aspen_input():
    """A source refresh reintroduces both investment rows after their first merge."""
    facilities = []
    for index, identifier in enumerate(ASPEN_IDS):
        record = COLLECTOR.facility(identifier, "Aspen Aerogels", "Register", "GA", "vehicle", ["doe", "sec"])
        record["name"] = f"Aspen investment announcement {index + 1}"
        record["possibleDuplicateIds"] = [ASPEN_IDS[1 - index]]
        record["notes"] = [f"Source investment row {index + 1}"]
        record["events"] = [{"id": f"evidence-{index + 1}", "date": "2026-06-30", "status": "cancelled", "sourceIds": ["sec"], "note": "Dated source observation"}]
        facilities.append(record)
    return {
        "schemaVersion": 1, "id": "industrial", "generatedAt": "2026-10-12T08:00:00.000Z",
        "sources": [
            {"id": "doe", "url": "https://app.energy.gov/mapbox/data.csv", "retrievedAt": "2026-10-12T07:00:00.000Z"},
            {"id": "sec", "url": SEC_URL, "retrievedAt": "2026-10-12T07:00:00.000Z"},
        ],
        "facilities": facilities, "limitations": [],
    }


class IndustrialLineageTests(unittest.TestCase):
    def test_repeated_refresh_preserves_identical_aliases_and_evidence(self):
        first = COLLECTOR.merge_reviewed_facilities(COLLECTOR.preserve({}, aspen_input()))
        second = COLLECTOR.merge_reviewed_facilities(COLLECTOR.preserve(copy.deepcopy(first), aspen_input()))
        third = COLLECTOR.merge_reviewed_facilities(COLLECTOR.preserve(copy.deepcopy(second), aspen_input()))
        self.assertEqual(first, second)
        self.assertEqual(second, third)
        canonical = second["facilities"][0]
        self.assertEqual(len(second["facilities"]), 1)
        self.assertEqual(canonical["aliases"].count(ASPEN_IDS[1]), 1)
        self.assertEqual(len(canonical["aliases"]), len(set(canonical["aliases"])))
        self.assertEqual({event["id"] for event in canonical["events"]}, {"evidence-1", "evidence-2"})
        self.assertEqual(canonical["possibleDuplicateIds"], [])

    def test_unresolved_nokia_lineage_stays_two_records_on_refresh(self):
        ids = ["LLF-ind-sia-nokia-san-jose-sunnyvale-ca-expansion", "LLF-ind-sia-nokia-san-jose-ca-new-facility"]
        fragment = {"sources": [], "facilities": []}
        for index, identifier in enumerate(ids):
            record = COLLECTOR.facility(identifier, "Nokia", "San Jose/Sunnyvale" if index == 0 else "San Jose", "CA", "semiconductor", [])
            record["possibleDuplicateIds"] = [ids[1 - index]]
            fragment["facilities"].append(record)
        first = COLLECTOR.merge_reviewed_facilities(copy.deepcopy(fragment))
        second = COLLECTOR.merge_reviewed_facilities(COLLECTOR.preserve(copy.deepcopy(first), copy.deepcopy(fragment)))
        self.assertEqual(first, second)
        self.assertEqual({record["id"] for record in second["facilities"]}, set(ids))
        for record in second["facilities"]:
            self.assertEqual(record["lifecycle"], "unknown")
            self.assertEqual(record["possibleDuplicateIds"], [identifier for identifier in ids if identifier != record["id"]])
            self.assertEqual(record["aliases"], [])

    def test_aspen_is_not_merged_without_proof_linked_to_both_rows(self):
        for unproven_rows in ([0, 1], [1]):
            with self.subTest(unproven_rows=unproven_rows):
                fragment = aspen_input()
                for index in unproven_rows:
                    fragment["facilities"][index]["sourceIds"] = ["doe"]
                    fragment["facilities"][index]["events"] = []
                result = COLLECTOR.merge_reviewed_facilities(fragment)
                self.assertEqual({record["id"] for record in result["facilities"]}, set(ASPEN_IDS))
                self.assertTrue(all(not record["aliases"] for record in result["facilities"]))
                self.assertTrue(all(record["possibleDuplicateIds"] for record in result["facilities"]))


if __name__ == "__main__":
    unittest.main()
