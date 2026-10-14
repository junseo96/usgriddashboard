#!/usr/bin/env python3
"""Public municipal building inventories, not electricity application queues.

Prince William County publishes stable GlobalIDs and building/permit status via
ArcGIS. Fetch the full ID manifest, bounded pages and a second manifest so a
partial response or changing inventory never replaces the last good fragment.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request
import uuid

from geography import apply_geography

ROOT = Path(__file__).resolve().parents[2]
LAYER = "https://gisweb.pwcva.gov/arcgis/rest/services/Planning/Build_Out_Analysis/MapServer/9"
FIELDS = ("OBJECTID", "GlobalID", "BuildingName", "Address", "BuildingID", "BuildingStatus",
          "YearBuilt", "PermitCase", "PermitStatus", "OCCDate", "CreateDate", "LastEditDate",
          "PlanningCaseNumber", "PlanningCaseName")
STATUSES = {"Planned": "planned", "Pending": "planned", "Approved Site Plan": "planned",
            "Under Construction": "construction", "Completed": "construction"}
PERMITS = {"Issued", "Pending", "Planned", "Potential", "Finaled"}
LIMITATIONS = [
    "Prince William County(VA)의 공개 데이터센터 건물·계획 단계 목록입니다. PJM 전체 또는 개별 전력 접속신청 전수가 아닙니다.",
    "각 행은 GlobalID로 구분한 건물·개발 단계이며 별도 캠퍼스·전력 접속점·고객 신청 건수와 같지 않습니다. 미명명 계획 건물도 원문 식별자를 유지합니다.",
    "건물 Completed·Finaled·Occupancy Date는 건축·사용승인 근거이며 실제 데이터센터 운영·통전 확인이 아닙니다. Completed는 건설 단계로 보수적으로 분류합니다.",
    "공개 API에 신청 MW·계약 MW·시설 전력이 없어 용량을 미공개로 유지합니다. 면적·건물 수·설계계획을 MW로 환산하지 않습니다.",
    "GIS 생성·수정일은 착공·허가·운영 사건일이 아닙니다. 사용승인일은 해당 승인 근거에만 연결하며 원문 확인일과 구분합니다.",
    "이름만으로 캠퍼스·건물을 합치지 않습니다. 주소·고유 시설코드가 일치한 기존 시설은 근거 보강으로 연결하고 검토된 캠퍼스의 개별 건물은 하위 단계로 연결합니다.",
    "카운티 GIS는 정확성·완전성을 보장하지 않으며 법적 토지 설명·설계 자료를 대체하지 않습니다. 출처: Prince William County Planning/Development Services/GIS; https://www.pwcva.gov/disclaimer/",
    "목록에서 빠진 건물을 철회·폐업으로 간주하지 않습니다. 이번 취득 실패·불완전 응답은 이전 정상 원장과 관측 이력을 보존합니다.",
]


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def clean(value):
    value = " ".join(str(value or "").split())
    return "" if value.lower() in {"<null>", "null", "none"} else value


def query(**params):
    return LAYER + "/query?" + urllib.parse.urlencode({"f": "json", **params}, safe=",")


class Acquisition:
    def __init__(self, state):
        self.state = state
        self.sources = {}
        self.report = []
        (state / "raw").mkdir(parents=True, exist_ok=True)

    def fetch(self, key, url):
        checked = now()
        report = {"id": key, "url": url, "checkedAt": checked}
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "GridAtlas-public-facility-research/1.0"})
            with urllib.request.urlopen(req, timeout=35) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                final_url = response.url
            if not raw or len(raw) > 8 * 1024 * 1024:
                raise ValueError("Empty or oversized public API response")
            digest = hashlib.sha256(raw).hexdigest()
            path = self.state / "raw" / (key + "-" + digest[:12] + ".json")
            path.write_bytes(raw)
            document = json.loads(raw)
            if not isinstance(document, dict) or "error" in document:
                raise ValueError("ArcGIS returned an error or invalid JSON object")
            sid = "municipal-pwc-" + key + "-" + digest[:16]
            source = {"id": sid, "name": "Prince William County — Data Center Buildings (" + key + ")",
                      "url": url, "retrievedAt": checked, "sha256": digest,
                      "publishedAt": None, "sourceAsOf": None,
                      "excerpt": "County building inventory. GlobalID, building/permit status and occupancy date; no electricity MW or connection approval. © Prince William County Planning/Development Services/GIS."}
            self.sources[sid] = source
            report.update(status="success", retrievedAt=checked, sha256=digest, sourceId=sid,
                          finalUrl=final_url, archive=str(path))
            self.report.append(report)
            path.with_suffix(".meta.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
            return document, source
        except Exception as error:
            report.update(status="failed", error=str(error))
            self.report.append(report)
            raise


def manifest(value):
    ids = value.get("objectIds")
    if value.get("exceededTransferLimit") or value.get("objectIdFieldName") != "OBJECTID" or not isinstance(ids, list) or not ids:
        raise ValueError("Incomplete ArcGIS ID manifest")
    if any(type(i) is not int or i < 1 for i in ids) or len(ids) != len(set(ids)):
        raise ValueError("Invalid or duplicated ArcGIS object IDs")
    return sorted(ids)


def collect(acq, batch_size=100):
    meta, metadata_source = acq.fetch("layer", LAYER + "?f=json")
    fields = {field.get("name") for field in meta.get("fields", [])}
    limit = meta.get("maxRecordCount")
    if meta.get("name") != "Data Center Buildings" or not set(FIELDS) <= fields or type(limit) is not int or limit < 1:
        raise ValueError("PWC building layer schema changed")
    ids, id_source = acq.fetch("ids-before", query(where="1=1", returnIdsOnly="true"))
    expected = manifest(ids)
    count, _ = acq.fetch("count", query(where="1=1", returnCountOnly="true"))
    if type(count.get("count")) is not int or count["count"] != len(expected):
        raise ValueError("ArcGIS count and ID manifest disagree")
    rows = []
    seen_guids = set()
    size = min(batch_size, limit, 100)
    if size < 1:
        raise ValueError("Invalid page size")
    for offset in range(0, len(expected), size):
        requested = expected[offset:offset + size]
        page, source = acq.fetch("buildings-" + str(offset), query(
            objectIds=",".join(map(str, requested)), outFields=",".join(FIELDS),
            returnGeometry="false", orderByFields="OBJECTID ASC", resultRecordCount=size))
        features = page.get("features")
        if page.get("exceededTransferLimit") or not isinstance(features, list) or len(features) != len(requested):
            raise ValueError("Incomplete ArcGIS building page")
        found = []
        for feature in features:
            row = feature.get("attributes")
            if not isinstance(row, dict) or not set(FIELDS) <= row.keys():
                raise ValueError("Missing building fields")
            guid = str(uuid.UUID(str(row["GlobalID"]).strip("{}")))
            if guid in seen_guids:
                raise ValueError("Duplicated stable building GlobalID")
            seen_guids.add(guid)
            found.append(row["OBJECTID"])
            rows.append((row, [metadata_source["id"], id_source["id"], source["id"]]))
        if sorted(found) != requested:
            raise ValueError("ArcGIS page ID mismatch or duplicate")
    after, _ = acq.fetch("ids-after", query(where="1=1", returnIdsOnly="true"))
    if manifest(after) != expected:
        raise ValueError("County inventory changed during collection; retry next run")
    return rows


def occupancy_day(value, cutoff):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Invalid occupancy timestamp")
    day = dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).date().isoformat()
    if not "1900-01-01" <= day <= cutoff:
        raise ValueError("Future/invalid occupancy date cannot be actual permit evidence")
    return day


def operator(name):
    for marker, label in [("iron mountain", "Iron Mountain"), ("amazon", "Amazon Web Services"),
                          ("qts ", "QTS"), ("stack ", "STACK Infrastructure"), ("cloudhq", "CloudHQ"),
                          ("microsoft", "Microsoft"), ("aligned ", "Aligned Data Centers"),
                          ("corscale", "Corscale"), ("yondr", "Yondr"), ("digital realty", "Digital Realty"),
                          ("dlr ", "Digital Realty"), ("ntt ", "NTT"), ("verizon", "Verizon"),
                          ("equinix", "Equinix"), ("compass data", "Compass Datacenters")]:
        if marker in name.lower():
            return label
    return None


def normalize(row, source_ids, cutoff):
    guid = str(uuid.UUID(str(row["GlobalID"]).strip("{}")))
    identifier = "LLF-municipal-pwc-" + guid
    name = clean(row["BuildingName"])
    status, permit = clean(row["BuildingStatus"]), clean(row["PermitStatus"])
    if not name or status not in STATUSES or permit not in PERMITS:
        raise ValueError("Unknown county building/permit classification")
    occupancy = occupancy_day(row["OCCDate"], cutoff)
    permit_case = clean(row["PermitCase"])
    building = clean(row["BuildingID"]) or "GIS " + str(row["OBJECTID"])
    notes = ["공식 지방정부 데이터센터 건물·계획 단계 행이며 개별 전력 접속신청이 아닙니다.",
             "건물 상태: " + status + "; 건축허가 상태: " + permit + "; 건물 번호: " + building + ".",
             "공식 건물 식별: GlobalID " + guid + "; OBJECTID " + str(row["OBJECTID"]) + ".",
             "시설 주소: " + (clean(row["Address"]) or "미공개"),
             "신청·계약·시설 MW는 공개되지 않았습니다. 건물 면적과 건물 수로 전력을 추정하지 않습니다."]
    if status == "Completed":
        notes.append("건축 완료·사용승인으로 건설 진척은 확인되지만 실제 데이터센터 운영·통전 근거는 미확인입니다. construction은 건물 공사 이후 단계까지 포함한 보수적 분류입니다.")
    if occupancy:
        notes.append("원문 사용승인일(OCCDate): " + occupancy + ". 실제 통전일·운영 개시일이 아닙니다.")
    if clean(row["PlanningCaseNumber"]):
        notes.append("도시계획 사건: " + clean(row["PlanningCaseNumber"]) + " — " + (clean(row["PlanningCaseName"]) or "사건명 미공개") + ". 사건 번호 자체는 허가 완료 증거가 아닙니다.")
    grid = []
    if permit in {"Issued", "Finaled"} and permit_case:
        grid.append({"id": identifier + ":building-permit:" + permit_case + ":" + permit.lower(),
                     "kind": "permit", "date": occupancy if permit == "Finaled" else None,
                     "sourceIds": source_ids, "note": "지방 건축허가 " + permit_case + " 상태 " + permit +
                     ". 사용승인일이 있으면 해당 승인 날짜만 보존합니다. 전력회사 공급계약·계통 신청·통전 승인이 아닙니다."})
    record = {"id": identifier, "name": name + " — 카운티 건물 " + building,
              "operator": operator(name), "sector": "data_center", "region": "Unknown", "state": "VA",
              "county": "Prince William County", "city": None, "lat": None, "lon": None,
              "identityKind": "phase", "parentId": None, "lifecycle": STATUSES[status],
              "asOf": None, "sourceIds": source_ids, "capacityFacts": [], "events": [], "gridEvidence": grid,
              "aliases": list(dict.fromkeys([name, "PWC GlobalID " + guid] + ([permit_case] if permit_case else []))),
              "legacyProjectIds": [], "notes": notes}
    return apply_geography(record)


def reviewed_links(records, rows, dataset, sources):
    """Only reviewed exact-code/address relationships; no automatic fuzzy merge."""
    existing = {f["id"]: f for f in dataset.get("facilities", [])}
    existing_sources = {s["id"]: s for s in dataset.get("sources", [])}
    enrichments = []
    for record, (row, _) in zip(records, rows):
        target = None
        if (row["BuildingName"], clean(row["Address"])) == ("Equinix Manassas DC14", "7400 INFANTRY RIDGE RD"):
            target = existing.get("LLF-equinix-dc14")
            if target and any("7400 Infantry Ridge Road" in n for n in target.get("notes", [])):
                record["aliases"].append(record["id"])
                record["id"] = target["id"]
                enrichments.append(target["id"])
                record["notes"].append("Equinix DC14 시설코드·7400 Infantry Ridge Road 주소가 기존 운영사 원장과 일치하여 동일 시설의 건축허가 근거만 보강합니다. 기존 운영 관측을 카운티 건물 상태로 덮어쓰지 않습니다.")
            else:
                raise ValueError("Reviewed Equinix identity proof missing; cannot add duplicate")
        elif re.fullmatch(r"QTS Manassas DC[1-6]", row["BuildingName"]):
            target = existing.get("LLF-qts-manassas")
            if not target or not any("6-building" in existing_sources[sid].get("excerpt", "") and "9400 Godwin" in existing_sources[sid].get("excerpt", "") for sid in target["sourceIds"]):
                raise ValueError("Reviewed QTS campus proof missing")
            record["parentId"] = target["id"]
            record["notes"].append("QTS 공식 Manassas 6-building campus와 DC1–DC6 시설코드를 대조해 기존 캠퍼스의 건물 단계로 연결했습니다. 캠퍼스 용량은 건물에 배분하지 않습니다.")
        if target:
            for sid in target["sourceIds"]:
                source = existing_sources[sid]
                sources[sid] = copy.deepcopy(source)
                record["sourceIds"].append(sid)
    return enrichments


def preserve(previous, current):
    old_sources = {s["id"]: s for s in previous.get("sources", [])}
    for source in current["sources"]:
        if source["id"] in old_sources:
            source["retrievedAt"] = old_sources[source["id"]]["retrievedAt"]
        old_sources[source["id"]] = source
    old_facilities = {r["id"]: r for r in previous.get("facilities", [])}
    old_facilities.update({r["id"]: r for r in current["facilities"]})
    current["sources"] = sorted(old_sources.values(), key=lambda r: r["id"])
    current["facilities"] = sorted(old_facilities.values(), key=lambda r: r["id"])
    current["enrichmentOnlyFacilityIds"] = sorted(set(previous.get("enrichmentOnlyFacilityIds", []) + current.get("enrichmentOnlyFacilityIds", [])))
    return current


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, default=ROOT / "data/large-load-facilities.json")
    args = parser.parse_args(argv)
    args.state_dir.mkdir(parents=True, exist_ok=True)
    previous = json.loads(args.output.read_text()) if args.output.exists() else {}
    acq = Acquisition(args.state_dir)
    report = {"checkedAt": now(), "preservedPrevious": bool(previous)}
    try:
        rows = collect(acq)
        records = [normalize(row, list(refs), now()[:10]) for row, refs in rows]
        dataset = json.loads(args.dataset.read_text()) if args.dataset.exists() else {}
        enrichments = reviewed_links(records, rows, dataset, acq.sources)
        fragment = preserve(previous, {"schemaVersion": 1, "id": "municipal", "generatedAt": now(),
            "sources": list(acq.sources.values()), "facilities": records,
            "enrichmentOnlyFacilityIds": enrichments, "limitations": LIMITATIONS})
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + ".tmp")
        temporary.write_text(json.dumps(fragment, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(args.output)
        report.update(status="success", facilityCount=len(fragment["facilities"]), freshFacilityCount=len(records),
                      buildingRows=len(rows), existingFacilityEnrichments=len(enrichments),
                      linkedCampusBuildings=sum(r["parentId"] is not None for r in records),
                      capacityKnownCount=0, confirmedGridApplicationCount=0)
    except Exception as error:
        report.update(status="failed", error=str(error))
    report["sources"] = acq.report
    (args.state_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "sources"}, ensure_ascii=False))
    return 0 if report["status"] == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
