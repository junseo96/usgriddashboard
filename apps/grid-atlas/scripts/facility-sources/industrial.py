#!/usr/bin/env python3
"""Collect large US manufacturing developments from public SIA/DOE inventories.

Only electrical MW/MVA may populate capacityFacts. Dollar investments select a
review population, never estimate power. Directory inclusion is not grid approval.
CLI matches collect-large-load-facilities: --output PATH --state-dir PATH.
Uses stdlib only. The caller seeds output with the last good fragment.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import io
import json
from pathlib import Path
import re
import sys
import unicodedata
import urllib.request
import urllib.parse

from geography import apply_geography

SIA_URL = "https://www.semiconductors.org/chip-supply-chain-investments/"
DOE_URL = "https://app.energy.gov/mapbox/data.csv"
DOE_PAGE = "https://www.energy.gov/invest"
DOE_METHOD = "https://www.energy.gov/invest/map-methodology"
STATES = dict(zip(
    "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia".split("|"),
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split()))


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def slug(value):
    value = unicodedata.normalize("NFKD", html.unescape(str(value))).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")


def clean(value):
    return " ".join(html.unescape(str(value or "")).split())


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []; self.depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}: self.depth += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style"}: self.depth = max(0, self.depth - 1)

    def handle_data(self, data):
        if not self.depth and data.strip(): self.parts.append(clean(data))


def text_of(raw):
    decoded = raw.decode("utf-8", errors="replace")
    parser = TextParser(); parser.feed(decoded)
    # Rivian publishes the article body in public Next.js JSON, not visible HTML.
    # Extract JSON string values, never execute scripts or infer from script code.
    match = re.search(r'<script\b[^>]*\bid=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', decoded, re.S | re.I)
    if match:
        try:
            def strings(value):
                if isinstance(value, str): return [clean(value)]
                if isinstance(value, dict): return [s for item in value.values() for s in strings(item)]
                if isinstance(value, list): return [s for item in value for s in strings(item)]
                return []
            parser.parts.extend(strings(json.loads(match.group(1))))
        except (ValueError, TypeError): pass
    return "\n".join(parser.parts)


def date_from_text(value):
    match = re.search(r"Last updated\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})", value, re.I)
    if match:
        try: return dt.datetime.strptime(match.group(1), "%B %d, %Y").date().isoformat()
        except ValueError: pass
    return None


class Acquisition:
    def __init__(self, state):
        self.state = state; self.report = []; self.sources = {}
        (state / "raw").mkdir(parents=True, exist_ok=True)

    def fetch(self, key, url, name=None, asof=None, excerpt=None):
        timestamp = now(); report = {"id": key, "url": url, "checkedAt": timestamp}
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "GridAtlas-public-facility-research/1.0"})
            with urllib.request.urlopen(request, timeout=35) as response:
                raw = response.read(); final_url = response.url
            if not raw: raise ValueError("Empty response")
            digest = hashlib.sha256(raw).hexdigest()
            extension = Path(urllib.parse.urlparse(url).path).suffix.lower()
            if extension not in {".csv", ".json", ".pdf", ".jpg", ".png"}: extension = ".html"
            path = self.state / "raw" / (key + "-" + digest[:12] + extension)
            path.write_bytes(raw)
            source_id = "industrial-" + key + "-" + digest[:12]
            source = {"id": source_id, "name": name or key, "url": url,
                      "retrievedAt": timestamp, "sha256": digest,
                      "publishedAt": None, "excerpt": excerpt or "",
                      "sourceAsOf": asof}
            self.sources[source_id] = source
            report.update(status="success", sha256=digest, retrievedAt=timestamp,
                          sourceId=source_id, finalUrl=final_url, archive=str(path))
            self.report.append(report)
            path.with_suffix(path.suffix + ".meta.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
            return raw, source
        except Exception as error:
            report.update(status="failed", error=str(error)); self.report.append(report)
            raise


def facility(identifier, operator, city, state, sector, source_ids):
    return {"id": identifier, "name": f"{operator} — {city or 'Location undisclosed'}, {state or 'US'}",
            "operator": operator, "sector": sector, "region": "Unknown", "state": state,
            "county": None, "city": city, "lat": None, "lon": None,
            "identityKind": "facility", "parentId": None, "lifecycle": "unknown",
            "asOf": None, "sourceIds": source_ids, "capacityFacts": [], "events": [],
            "gridEvidence": [], "aliases": [], "legacyProjectIds": [], "notes": []}


def dollars(value):
    try: return float(re.sub(r"[^0-9.]", "", str(value)))
    except ValueError: return 0


def coordinate(value, lower, upper):
    try:
        result = float(value)
        return result if lower <= result <= upper else None
    except (ValueError, TypeError): return None


# Verified common-campus duplicates in the SIA map. Amkor's second announcement
# explicitly calls itself phase 2 of its Peoria campus. Intel/NIST identify the
# same Rio Rancho campus, and Coherent calls its new announcement an expansion.
SIA_CAMPUS_MERGES = {("Amkor", "Peoria", "AZ"), ("Intel", "Rio Rancho", "NM"),
                     ("Coherent", "Sherman", "TX")}
SIA_EXCLUSIONS = {("Lam Research", "Boise"), ("DSV", "Mesa"),
                  ("EMD", "Sheboygan"), ("EMD", "Carlsbad"), ("EMD", "Catoosa"),
                  ("Micromize", "Columbus"), ("University of Arkansas", "Fayetteville")}


def collect_sia(acq):
    raw, page = acq.fetch("sia-index", SIA_URL, "SIA semiconductor supply chain investment tracker")
    page_text = text_of(raw); asof = date_from_text(page_text)
    page["sourceAsOf"] = asof
    page["excerpt"] = next((line for line in page_text.splitlines() if "Last updated" in line), "Announced semiconductor supply-chain projects since 2020.")
    match = re.search(r"https://datawrapper\.dwcdn\.net/u1vJC/\d+/", raw.decode(errors="replace"))
    if not match: raise ValueError("SIA published investment map iframe missing")
    dataset_url = match.group(0) + "dataset.csv"
    raw, source = acq.fetch("sia-investments", dataset_url,
                          "SIA investment map — named US manufacturing developments", asof)
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
    if not rows or not {"Company", "City", "State", "Category", "Source"}.issubset(rows[0]):
        raise ValueError("SIA CSV schema changed")
    source["excerpt"] = f"{len(rows)} source rows; fields Company, City, State, Project Type, Category, Technology, Source, Project Size ($), Status. Status describes CHIPS awards, not electric interconnection."
    candidates = []; source_urls = {}; merged = {}
    for index, row in enumerate(rows):
        company, city, state = (clean(row.get(key)) for key in ("Company", "City", "State"))
        category = clean(row.get("Category")); amount = dollars(row.get("Project Size ($)"))
        if state not in set(STATES.values()) - {"AK", "HI"}: continue
        if (company, city) in SIA_EXCLUSIONS: continue
        # Physical fabs/packaging, major material/equipment manufacturing, and
        # Anderon's explicitly producing quantum wafer foundry. No design offices.
        if category in {"Chip Design", "Other"}: continue
        if category == "R&D Facility" and company != "Anderon": continue
        if category in {"Materials", "Equipment"} and amount < 100_000_000 and "nist.gov/chips/" not in row.get("Source", ""): continue
        if category == "Semiconductors" and 0 < amount < 20_000_000: continue
        key = (company, city, state)
        suffix = "campus" if key in SIA_CAMPUS_MERGES else slug(row.get("Project Type") or "development")
        identifier = "LLF-ind-sia-" + slug("-".join(key)) + "-" + suffix
        source_url = clean(row.get("Source"))
        if source_url.startswith("http"):
            source_urls[source_url] = company
        if identifier in merged:
            record = merged[identifier]
            record["notes"].append(f"동일 캠퍼스의 별도 투자 발표행 보존: {row.get('Project Type')}; {row.get('Project Size (text)')}; {source_url}")
            record["_urls"].append(source_url)
            continue
        record = facility(identifier, company, city, state, "semiconductor", [page["id"], source["id"]])
        record.update(lat=coordinate(row.get("LAT"), 24, 50), lon=coordinate(row.get("LON"), -125, -66), asOf=asof)
        if key in SIA_CAMPUS_MERGES: record["identityKind"] = "campus"
        if "Expansion" in row.get("Project Type", "") or "Modernization" in row.get("Project Type", ""):
            record["identityKind"] = "phase"; record["name"] += " — 증설·현대화"
        if company == "Crucible Metals": record["sector"] = "other_industrial"
        if company == "USA Rare Earth Inc": record["sector"] = "other_industrial"
        record["notes"] = [
            f"원장 행 {index + 2}: {company}; {city}, {state}; {row.get('Project Type')}; {category}; {row.get('Technology') or '기술 미기재'}.",
            "반도체 투자 발표 원장에 등재된 신설·증설 후보입니다. 현재 공사·운영 상태와 실제 전력 접속 절차는 별도 근거가 없으면 미확인입니다.",
            "SIA 지도 좌표는 원자료의 근사 위치입니다. 실제 공장 경계·공급 유틸리티·규제 관할의 확정 근거가 아닙니다.",
            f"투자금 {row.get('Project Size (text)') or '미공개'}는 사업 설명이며 전력 MW가 아닙니다. 복수 부지 투자금은 개별 부지에 배분하지 않습니다.",
            f"CHIPS 보조금 상태: {row.get('Status') or '미기재'}. 보조금 확정·PMT·LOI는 전력 접속 승인이나 통전이 아닙니다.",
            f"원장이 연결한 추가 자료: {source_url or '미기재'}",
        ]
        record["_urls"] = [source_url]
        candidates.append(record); merged[identifier] = record
    if len(candidates) < 50: raise ValueError("Unexpected SIA manufacturing coverage contraction")
    nokia_ids = ["LLF-ind-sia-nokia-san-jose-sunnyvale-ca-expansion", "LLF-ind-sia-nokia-san-jose-ca-new-facility"]
    nokia = {record["id"]: record for record in candidates if record["id"] in nokia_ids}
    if len(nokia) == 2:
        for identifier, record in nokia.items():
            record["possibleDuplicateIds"] = [other for other in nokia_ids if other != identifier]
            record["notes"].append("SIA의 San Jose/Sunnyvale 증설 발표와 NIST가 지칭한 San Jose 신규 Fab이 동일 부지인지 확인되지 않았습니다. 단일 시설로 병합하지 않고 두 행 모두 중복 가능성 검토 대상으로 보존합니다.")
        nokia[nokia_ids[0]]["name"] = "Nokia San Jose/Sunnyvale — 부지 연결 미확인 증설 발표"
        nokia[nokia_ids[0]]["notes"].append("원문은 San Jose/Sunnyvale 복수 도시 범위이며 하나의 확인된 물리 시설을 의미하지 않습니다. 투자 발표 범위의 이력 보존용 행으로, 단일 공장·독립 접속 프로젝트 수나 점수 평균에 포함하지 않습니다.")
    return candidates, source_urls


DOE_SKIP = {"NewCo", "Norfolk", "Portsmouth Marine Terminal", "South Brooklyn Marine Terminal",
            "US DOT INFRA program", "Leading Light Wind/Invenergy", "South32",
            "Peninsula Energy (Strata Energy)", "Rio Tinto"}
# Same facility appears in both the DOE clean-energy component map and SIA map.
DOE_TO_SIA = {("Bosch", "Roseville", "CA"): ("Bosch", "Roseville", "CA"),
              ("Pallidus", "Rock Hill", "SC"): ("Pallidus", "Rock Hill", "SC"),
              ("Wolfspeed", "Siler City", "NC"): ("Wolfspeed", "Siler City", "NC")}


def collect_doe(acq, sia):
    page_raw, page = acq.fetch("doe-index", DOE_PAGE, "DOE clean energy manufacturing investment map")
    page_text = text_of(page_raw)
    match = re.search(r"Last update:\s*(\d{1,2})-(\d{1,2})-(\d{2,4})", page_text, re.I)
    if not match: raise ValueError("DOE source cutoff date missing")
    month, day, year = map(int, match.groups()); year += 2000 if year < 100 else 0
    asof = dt.date(year, month, day).isoformat()
    page.update(sourceAsOf=asof, excerpt=match.group(0))
    method_raw, method = acq.fetch("doe-methodology", DOE_METHOD, "DOE map methodology and conditional-project limitation")
    method["excerpt"] = "Many facilities are conditional on financing, funding, site control, and other facts. Inclusion on this map does not imply that these facilities will come online as reported."
    if "Inclusion on this map" not in text_of(method_raw): raise ValueError("DOE methodology changed; review required")
    raw, source = acq.fetch("doe-manufacturing", DOE_URL, "DOE announced manufacturing investments — public CSV", asof)
    rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
    if not rows or not {"company_name", "city", "state", "category", "priinvest", "tech"}.issubset(rows[0]):
        raise ValueError("DOE investment CSV schema changed")
    source["excerpt"] = f"{len(rows)} investment rows. Manufacturing candidates selected from category All - Manufacturing, named location, and reported private investment at least $100 million. Dollar amounts are not MW."
    result = []; groups = {}; selected = []
    for index, row in enumerate(rows):
        company, city = clean(row["company_name"]), clean(row["city"])
        state = STATES.get(clean(row["state"]))
        if (company, city, state) == ("Nucor", "Bradenburg", "KY"): city = "Brandenburg"
        if row["category"] != "All - Manufacturing" or dollars(row["priinvest"]) < 100_000_000: continue
        if not city or not company or state in {None, "AK", "HI"} or company in DOE_SKIP: continue
        if "Marine Terminal" in company: continue
        selected.append((index, row, company, city, state))
        groups.setdefault((company, city, state), []).append((index, row))
    for index, row, company, city, state in selected:
        key = (company, city, state)
        linked = next((f for f in sia if (f["operator"], f["city"], f["state"]) == DOE_TO_SIA.get(key)), None)
        if linked:
            linked["sourceIds"] += [page["id"], method["id"], source["id"]]
            linked["notes"].append(f"DOE의 동일 제조시설 발표행 {index + 2}도 연결합니다: {company}, {city}, {state}, {row['tech']}. 두 원장을 별도 시설로 합산하지 않습니다.")
            continue
        tech = row["tech"]
        sector = {"Batteries": "battery", "Electric Vehicles": "vehicle", "Hydrogen": "hydrogen"}.get(tech, "manufacturing")
        if company in {"JSW Steel USA", "Nucor"}: sector = "steel"
        # Original row contains no durable facility ID/address. Preserve each
        # materially different investment record instead of asserting co-location.
        row_key = "|".join((company, city, state, tech, row["priinvest"], row["latitude"], row["longitude"]))
        identifier = "LLF-ind-doe-" + slug(company + "-" + city + "-" + state) + "-" + hashlib.sha256(row_key.encode()).hexdigest()[:8]
        record = facility(identifier, company, city, state, sector, [page["id"], method["id"], source["id"]])
        if (company, city, state) == ("Nucor", "Brandenburg", "KY"):
            record["aliases"] = ["LLF-ind-doe-nucor-bradenburg-ky-bc515d6c", "Nucor — Bradenburg, KY"]
        record.update(asOf=asof, lat=coordinate(row.get("latitude"), 24, 50), lon=coordinate(row.get("longitude"), -125, -66))
        record["notes"] = [
            f"DOE 발표행 {index + 2}: {company}; {city}, {row['state']}; {tech}; 민간 투자 ${int(dollars(row['priinvest'])):,}.",
            f"{asof} 기준의 조건부 투자 발표 원장입니다. 현재 공사·운영·취소 여부는 별도 자료가 없으면 미확인입니다. 기준일을 사업 발표일로 사용하지 않습니다.",
            "1억 달러 이상 신설·증설 투자 발표를 우선 수집했습니다. 투자금은 시설의 실제 MW를 뜻하지 않으며 생산량·배터리 GWh를 전력 MW로 변환하지 않습니다.",
            "DOE 지도 좌표는 근사 위치이며 공급 유틸리티 또는 개별 계통 접속을 입증하지 않습니다.",
        ]
        if len(groups[key]) > 1:
            record["identityKind"] = "phase"
            record["name"] += f" — 투자 발표 ${int(dollars(row['priinvest'])):,} ({tech})"
            record["notes"].append("중복 가능성: 같은 기업·도시의 다른 투자 발표행이 있습니다. 원장에 부지 주소·동일 사업 식별자가 없어 별도 증설인지 중복 발표인지 미확정입니다. 물리 시설 전수나 독립 사업 수로 해석하지 마세요.")
        result.append(record)
    if len(result) < 100: raise ValueError("Unexpected DOE manufacturing coverage contraction")
    by_location = {}
    for record in result:
        by_location.setdefault((record["operator"], record["city"], record["state"]), []).append(record)
    for group in by_location.values():
        if len(group) > 1:
            for record in group:
                record["possibleDuplicateIds"] = sorted(other["id"] for other in group if other["id"] != record["id"])
    return result


# Source-confirmed status overlays are intentionally explicit and quote-checked.
# A new headline/date cannot silently promote every facility owned by a company.
STATUS_OVERRIDES = [
    {"company": "Toyota", "city": "Liberty", "facilityIds": ["LLF-ind-doe-toyota-liberty-nc-f4792f60"], "url": "https://pressroom.toyota.com/toyota-charges-into-u-s-battery-manufacturing/", "status": "operating", "date": "2025-11-12",
     "quote": "Toyota supercharged its multi-pathway approach to global vehicle electrification with the highly anticipated start of production at its all-new battery plant in Liberty, North Carolina.", "note": "초기 Liberty 배터리 생산시설의 실제 가동 확인입니다. DOE 후속 126.1억 달러 투자행이나 2030년까지의 추가 라인 전부를 가동 완료로 평가하지 않습니다. 동일 캠퍼스 복수 투자행 중 초기 시설 범위에만 적용합니다.", "name": "Toyota Liberty — 초기 배터리 생산시설"},
    {"company": "Hyundai", "city": "Savannah", "url": "https://www.hmgma.com/2026/06/03/hmgma-and-kia-america-celebrate-production-of-kia-sportage-hybrid/", "status": "operating", "date": "2026-06-02", "publishedAt": "2026-06-03",
     "quote": "celebrated the start of production for its newest vehicle", "note": "실제 공장은 Savannah 권역 Ellabell의 HMGMA입니다. 차량 3종 생산을 확인하며 별도 Hyundai / LG Energy 배터리 JV에 차량 가동 상태를 적용하지 않습니다."},
    {"company": "Ultium Cells (GM, LG Energy Solution)", "city": "Spring Hill", "url": "https://www.ultiumcell.com/newsroom/latest-news/2026/09/28/Ultium-Cells-to-Upgrade-Spring-Hill-Operations-to-Produce-Lithium-Manganese-Rich-LMR-Prismatic-Battery-Cells--", "status": "operating", "date": "2026-09-28",
     "quote": "This latest upgrade builds on Ultium Cells’ production of LFP cells for energy storage systems (ESS) for LG Energy Solution Vertech customers, which began in June, 2026.", "note": "기존 Spring Hill 공장의 LFP 배터리 생산이 확인됩니다. 2026년 말 개조 착수·2028년 완료 목표인 별도 LMR 후속 증설은 이 운영 범위에 포함하지 않습니다."},
    {"company": "Rivian", "city": "Normal", "url": "https://rivian.com/newsroom/article/rivian-begins-r2-public-customer-deliveries", "status": "operating", "date": "2026-06-09",
     "quote": "R2 vehicles have been rolling off the production line at the company's Normal, Illinois manufacturing facility", "note": "Normal 공장 R2 실제 생산·고객 인도 근거입니다. 발표 확인일이며 최초 생산 개시일을 만들지 않습니다."},
    {"company": "Rivian", "city": "Rutledge", "url": "https://rivian.com/newsroom/article/rivian-begins-r2-public-customer-deliveries", "status": "construction", "date": "2026-06-09",
     "quote": "Rivian is constructing a second manufacturing facility in Stanton Springs, Georgia", "note": "DOE Rutledge행은 Stanton Springs North/Social Circle 권역의 두 번째 공장입니다. 공식 자료가 현재 공사를 명시합니다. 2028년 생산 목표는 미래이며 전력 계약·계통 공사의 완료를 뜻하지 않습니다."},
    {"company": "Ford", "city": "Marshall", "url": "https://www.fromtheroad.ford.com/us/en/articles/2026/ford-response-transportation-secretary-duffy", "status": "operating", "date": "2026-09-08",
     "quote": "It is producing batteries in Michigan, with American workers, for Ford vehicles also built in America.", "note": "Ford 공식 성명의 BlueOval Battery Park Michigan in Marshall 실제 배터리 생산 확인입니다. Kentucky·Tennessee 사업에 전이 적용하지 않습니다."},
    {"company": "Nucor", "city": "Brandenburg", "url": "https://www.sec.gov/Archives/edgar/data/73309/000119312526318190/g468854ex99_2p9g1.jpg", "status": "operating", "date": "2026-07-28",
     "sha256": "3c8973343f590253fe99d944e2eec8862450d6b6d0aed9a4bbc132a8a00337cd",
     "quote": "Brandenburg performing well; shipments growing Q/Q", "note": "SEC 2026년 2분기 실적 9쪽에 Brandenburg 후판 공장 출하가 전분기 대비 증가했다고 명시되어 실제 가동을 확인합니다. DOE 도시 오탈자 Bradenburg는 Brandenburg로 보정했습니다."},
    {"company": "Micron", "city": "Boise", "url": "https://investors.micron.com/news-releases/news-release-details/micron-and-trump-administration-announce-expanded-us-investments", "status": "construction", "date": "2025-06-12",
     "quote": "Micron has already achieved key construction milestones on its first Idaho fab", "note": "첫 Idaho Fab의 실제 건설 공정 달성이 확인됩니다. 두 번째 Fab 추가 계획과 2027년 생산 목표를 현재 완료로 해석하지 않습니다. 이 상태 근거의 날짜는 2025년 6월입니다.", "identityKind": "campus"},
    {"company": "Intel", "city": "Rio Rancho", "url": "https://www.intel.com/content/www/us/en/newsroom/news/intel-opens-fab-9-new-mexico.html", "status": "operating", "date": "2024-01-24",
     "quote": "The Fab 9 and Fab 11x facilities in Rio Rancho represent the first operational site for mass production", "note": "Fab 9·Fab 11x의 실제 첨단 패키징 가동 및 개장 행사 확인입니다. 향후 별도 증설의 완료를 의미하지 않습니다.", "identityKind": "campus"},
    {"company": "TSMC", "city": "Phoenix", "url": "https://www.tsmc.com/static/abouttsmcaz/index.htm", "status": "construction", "date": None,
     "quote": "Fourth Fab and First Advanced Packaging Fab: In early 2026, the company started initial stages of construction.", "note": "캠퍼스의 첫 Fab은 2024년 4분기 생산, 두 번째 Fab은 2025년 건물 완공, 세 번째 Fab은 2025년 4월 착공, 네 번째 Fab·첫 패키징 Fab은 2026년 초기 공사 중입니다. 일부 생산을 전체 증설 완료로 확대하지 않고 캠퍼스 진행을 construction으로 표시합니다.", "identityKind": "campus"},
    {"company": "Samsung", "city": "Taylor", "url": "https://semiconductor.samsung.com/us/sas/company/taylor/", "status": "construction", "date": None,
     "quote": "The new facility we're building in Taylor, Texas", "note": "삼성의 개별 Taylor 공장 소개가 현장 건설을 직접 명시합니다. 신규 생산 목표일이나 기존 Austin 공장 가동을 Taylor 운영으로 바꾸지 않습니다."},
    {"company": "Texas Instruments", "city": "Sherman", "url": "https://www.ti.com/about-ti/worldwide-manufacturing.html", "status": "construction", "date": None,
     "quote": "The first fab, SM1 is open and in production and construction is complete on the second fab, SM2.", "note": "SM1은 실제 생산 중이고 SM2는 건물 공사를 마쳤지만 원장 투자 범위는 추가 Fab을 포함합니다. 부분 운영을 전체 캠퍼스 통전 완료로 보지 않고 증설 진행 construction으로 보존합니다.", "identityKind": "campus"},
    {"company": "Texas Instruments", "city": "Lehi", "url": "https://www.ti.com/about-ti/worldwide-manufacturing.html", "status": "construction", "date": None,
     "quote": "a second 300mm semiconductor wafer fab is under construction on the site", "note": "공식 소개가 LFAB2 건설을 명시합니다. 기존 LFAB1의 2022년 생산 개시는 신규 LFAB2 완료가 아닙니다.", "identityKind": "phase"},
    {"company": "Aspen Aerogels", "city": "Register", "url": "https://www.sec.gov/Archives/edgar/data/1145986/000119312526340275/aspn-20260630.htm", "status": "cancelled", "date": "2026-06-30", "publishedAt": "2026-08-07",
     "quote": "decided to cease construction at its previously planned aerogel manufacturing facility in Statesboro, Georgia", "note": "2026년 2분기 공시는 Statesboro 공장 공사를 2025년 2월 중단·현장 철수하고 자산을 매각할 계획이라고 명시합니다. DOE의 Register 표기는 같은 Bulloch County Statesboro 제조 부지의 발표행입니다. 정확한 중단 일자는 미공개로, 6월 30일은 공시 기준일입니다."},
    {"company": "Canoo", "city": "Oklahoma City", "url": "https://www.sec.gov/Archives/edgar/data/1750153/000162828025001918/goev-20250117.htm", "status": "cancelled", "date": "2025-01-17", "publishedAt": "2025-01-21",
     "quote": "filed for liquidation under Chapter 7", "note": "Canoo와 제조 관련 자회사 전체의 Chapter 7 청산 신청으로 기존 개발자의 사업은 종료된 것으로 분류합니다. 부지 철거 또는 후속 운영자 사업 부재를 뜻하지 않습니다. 기업 공시를 해당 기업 시설에 연결한 판단입니다."},
    {"company": "Canoo", "city": "Pryor", "url": "https://www.sec.gov/Archives/edgar/data/1750153/000162828025001918/goev-20250117.htm", "status": "cancelled", "date": "2025-01-17", "publishedAt": "2025-01-21",
     "quote": "filed for liquidation under Chapter 7", "note": "Canoo와 제조 관련 자회사 전체의 Chapter 7 청산 신청으로 기존 개발자의 사업은 종료된 것으로 분류합니다. 부지 철거 또는 후속 운영자 사업 부재를 뜻하지 않습니다. 기업 공시를 해당 기업 시설에 연결한 판단입니다."},
    {"company": "Entegris", "city": "Colorado Springs", "url": "https://www.nist.gov/chips/entegris-colorado-colorado-springs", "status": "construction", "date": None,
     "quote": "The center is being built in multiple phases", "note": "NIST의 개별 시설 소개가 여러 단계로 건설 중이라고 명시합니다. 원문 기준일은 확인되지 않아 날짜를 만들지 않으며 예정된 2028·2032년 생산 목표를 통전으로 바꾸지 않습니다."},
    {"company": "Texas Instruments", "city": "Richardson", "url": "https://www.ti.com/about-ti/company/ti-at-a-glance/manufacturing/richardson.html", "status": "operating", "date": None,
     "quote": "Both wafer fabs are currently in production.", "note": "현재 공식 제조시설 소개가 RFAB1·RFAB2 모두 생산 중이라고 명시합니다. 실제 최초 통전일은 공개되지 않아 사건 날짜를 만들지 않습니다."},
    {"company": "Anderon", "city": "Albany", "url": "https://newsroom.ibm.com/2026-09-16-anderon,-an-ibm-company,-finalizes-agreement-with-the-u-s-department-of-commerce-for-a-1-billion-chips-award-to-accelerate-r-d-for-u-s-based-pure-play-quantum-foundry", "status": "operating", "date": "2026-09-16",
     "quote": "the first quantum wafers now running through its manufacturing facility", "note": "첫 양자 웨이퍼 제조가 실제 시작됐다는 기업 확인입니다. 투자 확대 전부가 완공됐다는 뜻은 아닙니다."},
    {"company": "Amkor", "city": "Peoria", "url": "https://ir.amkor.com/news-releases/news-release-details/amkor-technology-breaks-ground-new-semiconductor-advanced", "status": "construction", "date": "2025-10-06",
     "quote": "today announces the groundbreaking", "note": "공식 착공 발표를 근거로 합니다. 2026년 9월 Phase 2 추가 계획은 동일 캠퍼스의 후속 증설이며 전력 접속 완료가 아닙니다."},
    {"company": "KPPC Advanced Chemicals", "city": "Casa Grande", "url": "https://www.azcommerce.com/news-events/news/2025/12/kanto-ppc-groundbreaking/", "status": "construction", "date": "2025-12-22",
     "quote": "groundbreaking", "note": "애리조나 경제개발기관의 현장 착공 발표입니다. 2027년 생산 목표를 현재 운영으로 바꾸지 않습니다."},
    {"company": "Lumentum", "city": "Greensboro", "url": "https://investor.lumentum.com/financial-news-releases/news-details/2026/Lumentum-Announces-New-U-S--Manufacturing-Facility-to-Produce-Advanced-Lasers-for-the-Worlds-Largest-AI-Data-Centers/default.aspx", "status": "planned", "date": "2026-03-26",
     "quote": "will be retrofitted to manufacture Lumentum", "note": "매입한 기존 공장은 운영 중이나 신규 InP 생산 증설은 개조 계획 단계입니다. 기존 건물 운영을 새 증설의 통전·양산으로 보지 않습니다."},
]


def enrich_sources(acq, facilities, source_urls):
    # Public primary sources linked by the publisher; unreviewed third-party
    # articles remain reference URLs, not falsely marked as retrieved evidence.
    urls = {url for url in source_urls if any(domain in url for domain in (
        "nist.gov/chips/", "ir.amkor.com/", "newsroom.ibm.com/", "pr.tsmc.com/", "ti.com/about-ti/"))}
    urls.update(item["url"] for item in STATUS_OVERRIDES)
    def worker(url):
        key = "primary-" + hashlib.sha256(url.encode()).hexdigest()[:12]
        try:
            raw, source = acq.fetch(key, url, "Official manufacturing project source — " + source_urls.get(url, "status review"))
            value = "" if url.lower().endswith((".jpg", ".png")) else text_of(raw)
            summary = value.split("Project Summary", 1)[-1].split("Economic and National Security Impact", 1)[0]
            source["excerpt"] = clean(summary[:900])
            return url, source, value
        except Exception: return url, None, None
    retrieved = dict((url, (source, value)) for url, source, value in concurrent.futures.ThreadPoolExecutor(max_workers=8).map(worker, sorted(urls)))
    for record in facilities:
        for url in record.pop("_urls", []):
            source, _ = retrieved.get(url, (None, None))
            if source: record["sourceIds"].append(source["id"])
        for override in STATUS_OVERRIDES:
            if (record["operator"], record["city"]) != (override["company"], override["city"]): continue
            if override.get("facilityIds") and record["id"] not in override["facilityIds"]:
                source, _ = retrieved.get(override["url"], (None, None))
                if source:
                    record["sourceIds"].append(source["id"])
                    record["notes"].append("같은 캠퍼스 초기 시설의 가동 근거가 있지만 이 후속 투자행의 추가 라인 완공 여부는 미확인입니다. 초기 가동을 후속 증설 전체에 적용하지 않습니다.")
                continue
            source, value = retrieved.get(override["url"], (None, None))
            verified = bool(source and (source["sha256"] == override["sha256"] if override.get("sha256") else clean(override["quote"]).lower() in clean(value).lower()))
            if not verified:
                record["notes"].append("검토된 상태 근거를 이번 실행에서 재확인하지 못했습니다. 기존 상태 이력은 보존하며 새 단계로 추정하지 않습니다.")
                continue
            source.update(sourceAsOf=override["date"], publishedAt=override.get("publishedAt", override["date"]))
            if override["quote"] not in source["excerpt"]:
                source["excerpt"] = (source["excerpt"] + " | " + override["quote"]).strip(" |")
            record.update(lifecycle=override["status"], asOf=override["date"])
            if override.get("identityKind"): record["identityKind"] = override["identityKind"]
            if override.get("name"): record["name"] = override["name"]
            record["sourceIds"].append(source["id"]); record["notes"].append(override["note"])
            if override["date"]:
                record["events"].append({"id": record["id"] + "-" + override["date"] + "-" + override["status"], "date": override["date"], "status": override["status"], "sourceIds": [source["id"]], "note": override["note"]})
        record["sourceIds"] = sorted(set(record["sourceIds"]))


def collect_reviewed_industry(acq):
    """Large steel/aluminum developments outside the clean-energy map."""
    specs = [
        {"id": "sk-battery-commerce-ga", "operator": "SK Battery America", "city": "Commerce", "state": "GA", "sector": "battery", "identityKind": "campus", "status": "operating",
         "url": "https://www.skbatteryamerica.com/company/history.html", "date": None,
         "quote": "2023 Began mass production in Factory 2 in Georgia, USA",
         "note": "Commerce 공식 사업장 주소 1760 SK Blvd와 기업 연혁상 Georgia Factory 1(2021)·2(2023) 양산 개시를 확인했습니다. 정확한 일자가 없어 asOf·events 날짜를 만들지 않습니다. 현재 가동률·휴업 여부는 이 연혁만으로 확인되지 않으며 두 공장을 Commerce 캠퍼스 1개로 기록합니다."},
        {"id": "nucor-west-virginia-sheet-mill", "operator": "Nucor", "city": None, "state": "WV", "sector": "steel",
         "name": "Nucor Steel West Virginia — 신설 판재 제철소",
         "url": "https://www.sec.gov/Archives/edgar/data/73309/000119312526318190/g468854ex99_2p7g1.jpg", "date": "2026-07-28",
         "sha256": "715b366d3541753a4d114ffe1628e9091489233482b53587976264b615807f25",
         "quote": "WEST VIRGINIA PROJECT PROGRESSING – ON TIME AND ON BUDGET. COMMISSIONING THROUGHOUT 2026. Ran first coil through pickle line in June. Expanded equipment commissioning across the site and will continue throughout the year.",
         "note": "West Virginia 신설 판재 제철소는 2026년 설비별 시운전 중입니다. 6월 첫 산세라인 코일 통과가 확인되며 전체 생산 2027년 목표는 미래 일정입니다. 구체 도시 주소는 이 슬라이드에 없어 null로 보존합니다."},
        {"id": "novelis-bay-minette-al", "operator": "Novelis", "city": "Bay Minette", "state": "AL", "sector": "aluminum",
         "url": "https://investors.novelis.com/news-events/press-releases/detail/1425/novelis-reports-first-quarter-fiscal-year-2027-results", "date": "2026-08-05",
         "quote": "greenfield rolling and recycling plant in Bay Minette, Alabama, which has begun the commissioning process",
         "note": "신설 압연·재활용 공장이 시운전에 들어갔다는 분기 실적 확인입니다. 시운전은 전체 상업운전 완료나 계통 최종 승인을 뜻하지 않아 construction으로 보존합니다."},
        {"id": "nucor-berkeley-galvanizing-sc", "operator": "Nucor", "city": "Huger", "state": "SC", "sector": "steel",
         "url": "https://www.sec.gov/Archives/edgar/data/73309/000119312526318190/g468854ex99_2p8g1.jpg", "date": "2026-07-28",
         "sha256": "0f9f6fc822790b52075f242df6f6db2565867fc285599cf175de8601f3a9cc56",
         "quote": "NUCOR BERKELEY GALV LINE. Constructing a second 500K tpa galvanizing line at Nucor Steel Berkeley (SC) sheet mill. Equipment commissioning currently in process.",
         "note": "공식 SEC 실적 발표 8쪽 이미지를 직접 검토했습니다. Berkeley 두 번째 도금 라인은 설비 시운전 중입니다. 50만 톤/년은 제품 생산량이며 전력 MW가 아닙니다.", "phase": True},
    ]
    result = []
    for spec in specs:
        try:
            raw, source = acq.fetch("review-" + spec["id"], spec["url"], spec["operator"] + " — official manufacturing progress", spec["date"], spec["quote"])
            if spec.get("sha256"):
                if source["sha256"] != spec["sha256"]: raise ValueError("Reviewed slide changed; manual review required")
            elif clean(spec["quote"]).lower() not in clean(text_of(raw)).lower():
                raise ValueError("Reviewed industrial quote missing")
            source["publishedAt"] = spec["date"]
            record = facility("LLF-ind-reviewed-" + spec["id"], spec["operator"], spec["city"], spec["state"], spec["sector"], [source["id"]])
            record.update(lifecycle=spec.get("status", "construction"), asOf=spec["date"])
            if spec.get("identityKind"): record["identityKind"] = spec["identityKind"]
            if spec.get("name"): record["name"] = spec["name"]
            if spec.get("phase"): record.update(identityKind="phase", name="Nucor Berkeley — 두 번째 도금 라인")
            record["notes"] = [spec["note"], "설비 공정 근거이며 접속 계약 용량·보강 완료·최초 통전일은 이 자료로 확인되지 않습니다."]
            if spec["date"]:
                record["events"] = [{"id": record["id"] + "-" + spec["date"], "date": spec["date"], "status": spec.get("status", "construction"), "sourceIds": [source["id"]], "note": "공식 자료가 해당 공정을 확인한 날짜입니다. 최초 착공·시운전 시작일을 뜻하지 않습니다."}]
            result.append(record)
        except Exception as error:
            acq.report.append({"id": "review-" + spec["id"], "url": spec["url"], "status": "failed", "error": str(error), "checkedAt": now()})
    return result


def preserve(previous, current):
    old_sources = {source["id"]: source for source in previous.get("sources", [])}
    for source in current["sources"]:
        if source["id"] in old_sources:
            # Same bytes preserve the first real acquisition time in event evidence.
            source["retrievedAt"] = old_sources[source["id"]]["retrievedAt"]
        old_sources[source["id"]] = source
    old_facilities = {record["id"]: record for record in previous.get("facilities", [])}
    for record in current["facilities"]:
        old = old_facilities.get(record["id"])
        if old:
            for field in ("sourceIds", "aliases", "legacyProjectIds", "notes", "possibleDuplicateIds"):
                record[field] = list(dict.fromkeys(old.get(field, []) + record.get(field, [])))
            for field in ("events", "capacityFacts", "gridEvidence"):
                merged = {item["id"]: item for item in old.get(field, [])}
                merged.update({item["id"]: item for item in record.get(field, [])}); record[field] = list(merged.values())
            if record["lifecycle"] == "unknown" and old.get("lifecycle") != "unknown":
                record["lifecycle"] = old["lifecycle"]; record["asOf"] = old.get("asOf")
                # A failed status-source refresh cannot undo its reviewed scope.
                # Keep the fresh inventory label as provenance, not as a rename.
                if record["name"] != old["name"]:
                    record["aliases"] = list(dict.fromkeys(record["aliases"] + [record["name"]]))
                record["name"] = old["name"]
                record["identityKind"] = old["identityKind"]
        old_facilities[record["id"]] = record
    current["sources"] = sorted(old_sources.values(), key=lambda x: x["id"])
    current["facilities"] = sorted(old_facilities.values(), key=lambda x: x["id"])
    return current


def merge_reviewed_facilities(fragment):
    """Merge only individually reviewed investment tranches, retaining all proof."""
    groups = [
        {"ids": ["LLF-ind-doe-aspen-aerogels-register-ga-8b7d09c8", "LLF-ind-doe-aspen-aerogels-register-ga-cb09f390"],
         "name": "Aspen Aerogels — Statesboro/Register 제조공장", "identityKind": "facility",
         "url": "https://www.sec.gov/Archives/edgar/data/1145986/000119312526340275/aspn-20260630.htm",
         "reason": "DOE의 3.25억·6.71억 달러 Register 투자 발표는 SEC 공시가 단일 Statesboro aerogel manufacturing facility로 지칭한 사업으로 병합했습니다. 두 발표 금액을 전력 용량이나 별도 공장 수로 합산하지 않습니다."},
    ]
    records = {record["id"]: record for record in fragment["facilities"]}
    sources = {source["id"]: source for source in fragment["sources"]}
    remap = {}
    for group in groups:
        if not all(identifier in records for identifier in group["ids"]): continue
        members = [records[identifier] for identifier in group["ids"]]
        if not all(any(sources[sid]["url"] == group["url"] for sid in member["sourceIds"]) for member in members): continue
        canonical = members[0]
        for other in members[1:]:
            for field in ("sourceIds", "aliases", "legacyProjectIds", "notes"):
                canonical[field] = list(dict.fromkeys(canonical.get(field, []) + other.get(field, [])))
            for field in ("events", "capacityFacts", "gridEvidence"):
                merged = {item["id"]: item for item in canonical.get(field, []) + other.get(field, [])}
                canonical[field] = list(merged.values())
            # A refresh returns both original investment rows. Their identifiers
            # may already be aliases in the last-good canonical facility.
            canonical["aliases"] = list(dict.fromkeys(canonical["aliases"] + [other["id"], other["name"]]))
            remap[other["id"]] = canonical["id"]; del records[other["id"]]
        canonical.update(name=group["name"], identityKind=group["identityKind"])
        canonical["notes"].append(group["reason"])
    for record in records.values():
        record["possibleDuplicateIds"] = sorted({remap.get(identifier, identifier) for identifier in record.get("possibleDuplicateIds", [])} - {record["id"]})
        record["notes"] = list(dict.fromkeys(record["notes"]))
    fragment["facilities"] = sorted(records.values(), key=lambda record: record["id"])
    return fragment


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True); parser.add_argument("--state-dir", type=Path, required=True)
    args = parser.parse_args(); args.state_dir.mkdir(parents=True, exist_ok=True)
    previous = json.loads(args.output.read_text()) if args.output.exists() else {}
    acq = Acquisition(args.state_dir); facilities = []; successes = []; errors = []
    sia = []; urls = {}
    try:
        sia, urls = collect_sia(acq); facilities.extend(sia); successes.append("sia")
    except Exception as error: errors.append({"source": "sia", "error": str(error)})
    try:
        facilities.extend(collect_doe(acq, sia)); successes.append("doe")
    except Exception as error: errors.append({"source": "doe", "error": str(error)})
    if successes:
        enrich_sources(acq, facilities, urls)
        facilities.extend(collect_reviewed_industry(acq))
    if not successes:
        (args.state_dir / "report.json").write_text(json.dumps({"status": "failed", "checkedAt": now(), "sources": acq.report, "errors": errors, "preservedPrevious": bool(previous)}, ensure_ascii=False, indent=2))
        print("Industrial facility acquisition failed; previous output left intact", file=sys.stderr); return 1
    for record in facilities: apply_geography(record)
    fragment = preserve(previous, {"schemaVersion": 1, "id": "industrial", "generatedAt": now(), "sources": list(acq.sources.values()), "facilities": facilities,
        "limitations": [
            "미국 산업 수용가 전수가 아닙니다. SIA의 제조 투자 발표와 DOE의 1억 달러 이상 제조 투자 발표를 중심으로 대형 신설·증설 후보를 수집했습니다.",
            "기업·시설 실명 등재는 계통 접속 신청이나 전력 공급 계약을 입증하지 않습니다. 실제 MW가 없으면 용량 수치를 만들지 않습니다.",
            "SIA CHIPS 보조금 단계와 DOE 투자금은 전력 접속 단계가 아닙니다. 날짜가 오래된 발표는 현재 건설·운영 상태로 간주하지 않습니다.",
            "DOE는 주소·내부 사업 ID가 없고 근사 좌표를 제공합니다. 같은 기업·도시의 복수 투자 발표는 중복 가능성을 명시하여 보존하며 물리 시설 전수로 주장하지 않습니다.",
            "기업의 기존 공장 운영과 신규 증설의 진행은 별개입니다. 생산 GWh·톤·투자 달러를 전력 수요 MW로 환산하지 않습니다.",
            "일시 수집 실패나 최신 목록 미노출은 폐업·취소 근거가 아닙니다. 이전 자료·원문 출처와 사건 이력을 보존합니다.",
            "NLR/NAATBatt 배터리 DB는 등록 양식을 요구하여 이 자동 공개 수집 범위에 포함하지 않았습니다.",
        ]})
    fragment = merge_reviewed_facilities(fragment)
    used = {sid for record in fragment["facilities"] for sid in record["sourceIds"]}
    known = {source["id"] for source in fragment["sources"]}
    if not used <= known: raise ValueError("Dangling facility provenance")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    temporary.write_text(json.dumps(fragment, ensure_ascii=False, indent=2) + "\n"); temporary.replace(args.output)
    status = "partial" if errors or any(row["status"] == "failed" for row in acq.report) else "success"
    report = {"status": status, "checkedAt": now(), "sources": acq.report, "errors": errors,
              "facilityCount": len(fragment["facilities"]), "freshFacilityCount": len(facilities),
              "preservedPrevious": bool(previous), "successfulInventories": successes}
    (args.state_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k not in {"sources", "errors"}}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
