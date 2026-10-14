import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE_DIR = Path(__file__).resolve().parents[1] / "scripts/facility-sources"
sys.path.insert(0, str(SOURCE_DIR))
spec = importlib.util.spec_from_file_location("municipal", SOURCE_DIR / "municipal.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def row(number=1, **changes):
    result = dict.fromkeys(m.FIELDS)
    result.update(OBJECTID=number, GlobalID="00000000-0000-0000-0000-" + str(number).zfill(12),
                  BuildingName="Example Data Center " + str(number), Address="100 EXAMPLE RD",
                  BuildingID=str(number), BuildingStatus="Planned", PermitStatus="Planned")
    result.update(changes)
    return result


class FakeAcquisition:
    def __init__(self, pages=None, after=None, page_mutator=None):
        self.pages = pages or [row(1), row(2), row(3)]
        self.after = after
        self.page_mutator = page_mutator
        self.calls = []

    def fetch(self, key, url):
        self.calls.append((key, url))
        params = m.urllib.parse.parse_qs(m.urllib.parse.urlsplit(url).query)
        source = {"id": key}
        ids = [r["OBJECTID"] for r in self.pages]
        if key == "layer":
            return {"name": "Data Center Buildings", "fields": [{"name": f} for f in m.FIELDS], "maxRecordCount": 2}, source
        if key.startswith("ids-"):
            return {"objectIdFieldName": "OBJECTID", "objectIds": self.after if key == "ids-after" and self.after is not None else ids}, source
        if key == "count":
            return {"count": len(ids)}, source
        wanted = list(map(int, params["objectIds"][0].split(",")))
        result = {"features": [{"attributes": copy.deepcopy(r)} for r in self.pages if r["OBJECTID"] in wanted]}
        if self.page_mutator:
            self.page_mutator(result)
        return result, source


class MunicipalCollectionTests(unittest.TestCase):
    def test_complete_explicit_id_pagination(self):
        acq = FakeAcquisition()
        rows = m.collect(acq)
        self.assertEqual([r[0]["OBJECTID"] for r in rows], [1, 2, 3])
        self.assertEqual(sum(key.startswith("buildings-") for key, _ in acq.calls), 2)
        self.assertEqual(acq.calls[-1][0], "ids-after")
        self.assertTrue(all("returnGeometry=false" in url for key, url in acq.calls if key.startswith("buildings-")))
        self.assertTrue(all("CreateUser" not in url and "LastEditUser" not in url for _, url in acq.calls))

    def test_truncated_page_rejected(self):
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            m.collect(FakeAcquisition(page_mutator=lambda value: value.update(exceededTransferLimit=True)))

    def test_missing_page_row_rejected(self):
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            m.collect(FakeAcquisition(page_mutator=lambda value: value["features"].pop()))

    def test_duplicate_globalid_rejected(self):
        rows = [row(1), row(2)]
        rows[1]["GlobalID"] = rows[0]["GlobalID"]
        with self.assertRaisesRegex(ValueError, "Duplicated stable"):
            m.collect(FakeAcquisition(pages=rows))

    def test_changed_manifest_rejected(self):
        with self.assertRaisesRegex(ValueError, "changed during"):
            m.collect(FakeAcquisition(after=[1, 2, 3, 4]))

    def test_manifest_duplicate_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicated"):
            m.manifest({"objectIdFieldName": "OBJECTID", "objectIds": [1, 1]})

    def test_completed_is_not_operating_or_energized(self):
        result = m.normalize(row(BuildingStatus="Completed", PermitStatus="Finaled",
                                 PermitCase="BLD2024-00001", OCCDate=1735689600000), ["source"], "2026-10-14")
        self.assertEqual(result["lifecycle"], "construction")
        self.assertEqual(result["gridEvidence"][0]["kind"], "permit")
        self.assertEqual(result["gridEvidence"][0]["date"], "2025-01-01")
        self.assertEqual(result["capacityFacts"], [])
        self.assertEqual(result["events"], [])
        self.assertIsNone(result["asOf"])
        self.assertEqual(result["identityKind"], "phase")
        self.assertEqual(result["regionBasis"], "geographic_estimate")

    def test_planned_has_no_application_or_permit_completion(self):
        result = m.normalize(row(PermitCase="BLD2027-00001", CreateDate=1735689600000,
                                 LastEditDate=1735689600000), ["source"], "2026-10-14")
        self.assertEqual(result["lifecycle"], "planned")
        self.assertEqual(result["gridEvidence"], [])
        self.assertEqual(result["events"], [])
        self.assertEqual(result["capacityFacts"], [])
        self.assertIsNone(result["asOf"])

    def test_future_occupancy_rejected(self):
        with self.assertRaisesRegex(ValueError, "Future"):
            m.normalize(row(OCCDate=1893456000000), ["source"], "2026-10-14")

    def test_unknown_classification_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unknown"):
            m.normalize(row(BuildingStatus="Online"), ["source"], "2026-10-14")

    def test_equivalent_uuid_formats_have_stable_identity(self):
        a = row()
        b = copy.deepcopy(a)
        b["GlobalID"] = "{" + a["GlobalID"].upper() + "}"
        self.assertEqual(m.normalize(a, ["s"], "2026-10-14")["id"], m.normalize(b, ["s"], "2026-10-14")["id"])

    def test_failed_refresh_preserves_exact_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "previous.json"
            old = '{"schemaVersion":1,"facilities":[],"sources":[]}\n'
            out.write_text(old)
            with patch.object(m, "collect", side_effect=TimeoutError("page timeout")):
                result = m.main(["--output", str(out), "--state-dir", str(Path(directory) / "state")])
            self.assertEqual(result, 1)
            self.assertEqual(out.read_text(), old)
            report = json.loads((Path(directory) / "state/report.json").read_text())
            self.assertEqual(report["status"], "failed")
            self.assertTrue(report["preservedPrevious"])

    def test_missing_facility_preserved_without_cancellation(self):
        old = m.normalize(row(1), ["s1"], "2026-10-14")
        fresh = m.normalize(row(2), ["s2"], "2026-10-14")
        merged = m.preserve({"facilities": [old], "sources": [{"id": "s1", "retrievedAt": "old"}]},
                            {"facilities": [fresh], "sources": [{"id": "s2", "retrievedAt": "new"}]})
        self.assertEqual(len(merged["facilities"]), 2)
        self.assertEqual(merged["facilities"][0]["lifecycle"], "planned")

    def test_exact_equinix_is_evidence_only_existing_identity(self):
        raw = row(BuildingName="Equinix Manassas DC14", Address="7400 INFANTRY RIDGE RD")
        record = m.normalize(raw, ["county"], "2026-10-14")
        dataset = {"facilities": [{"id": "LLF-equinix-dc14", "notes": ["7400 Infantry Ridge Road"], "sourceIds": ["operator"]}],
                   "sources": [{"id": "operator", "url": "https://www.equinix.com/dc14"}]}
        sources = {}
        enrichments = m.reviewed_links([record], [(raw, ["county"])], dataset, sources)
        self.assertEqual(enrichments, ["LLF-equinix-dc14"])
        self.assertEqual(record["id"], "LLF-equinix-dc14")
        self.assertIn("operator", sources)

    def test_qts_building_links_to_verified_campus_without_copying_mw(self):
        raw = row(BuildingName="QTS Manassas DC1", Address="9400 GODWIN DR")
        record = m.normalize(raw, ["county"], "2026-10-14")
        dataset = {"facilities": [{"id": "LLF-qts-manassas", "sourceIds": ["operator"],
                                   "capacityFacts": [{"value": 190}]}],
                   "sources": [{"id": "operator", "excerpt": "6-building campus; DC1 — 9400 Godwin Dr"}]}
        enrichments = m.reviewed_links([record], [(raw, ["county"])], dataset, {})
        self.assertEqual(enrichments, [])
        self.assertEqual(record["parentId"], "LLF-qts-manassas")
        self.assertEqual(record["capacityFacts"], [])
        self.assertEqual(record["identityKind"], "phase")

    def test_unverified_exact_identity_fails_before_duplicate_insertion(self):
        raw = row(BuildingName="Equinix Manassas DC14", Address="7400 INFANTRY RIDGE RD")
        record = m.normalize(raw, ["county"], "2026-10-14")
        with self.assertRaisesRegex(ValueError, "identity proof missing"):
            m.reviewed_links([record], [(raw, ["county"])], {"facilities": [], "sources": []}, {})


if __name__ == "__main__":
    unittest.main()
