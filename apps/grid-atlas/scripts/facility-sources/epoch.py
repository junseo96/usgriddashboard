#!/usr/bin/env python3
"""Epoch AI's CC BY 4.0 AI facility CSVs: research evidence, not a load queue.

Keep operating-power estimates separate from requested/contracted MW. Forecast
dates and elapsed construction schedules cannot establish observed operation.
The orchestrator stages, validates and journals changes before publication.
"""
from __future__ import annotations

import argparse
import copy
import csv
import datetime as dt
import hashlib
import html
import io
import json
import math
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from geography import apply_geography

PAGE = 'https://epoch.ai/data/ai-data-centers'
CENTERS = 'https://epoch.ai/data/data_centers/data_centers.csv'
TIMELINES = 'https://epoch.ai/data/data_centers/data_center_timelines.csv'
LICENSE = 'https://creativecommons.org/licenses/by/4.0/'
STATES = {'Alabama':'AL','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO','Connecticut':'CT','Delaware':'DE','District of Columbia':'DC','Florida':'FL','Georgia':'GA','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'}
# Only explicit place names in the published dataset; no territorial utility claim.
PLACE_HINTS = {'Google Mesa':('AZ','Mesa'), 'Google Kansas City East':('MO','Kansas City'),
 'Google Storey County':('NV',None), 'AWS New Albany':('OH','New Albany'),
 'Anthropic Barber Lake':('TX',None), 'OpenAI Stargate Michigan':('MI',None),
 'OpenAI Stargate Milam':('TX',None), 'OpenAI Stargate New Mexico':('NM',None),
 'OpenAI Stargate Wisconsin':('WI',None), 'Stream Phoenix':('AZ','Phoenix')}

# Epoch's free-text operation statements often interpolate dates from roof age,
# planned completion or parking lots. Preserve dated PARTIAL-operation evidence
# only with a reviewed statement, exact hash and reviewed effective date. None
# of these observations establishes full-campus completion: retain construction
# status and explanatory notes, never campus operating (which implies zero
# remaining gates in the current shared model) or official grid energization.
OPERATION_REVIEW = {
 ('Anthropic-Amazon New Carlisle','2025-10-17'): ('43381adc30097ed1ba1ba85ed8d7d2ef1969194eb16b03d09361f7d36596ce58','2025-10-17','AWS CEO의 해당 날짜 발언에서 Indiana의 Trainium2 약 50만 개가 이미 가동 중이라고 확인했습니다. 캠퍼스 일부 운영입니다.'),
 ('CoreWeave Denton TX','2026-03-02'): ('59d00ece9fc0c4e03823ead4a946fbd91975dca2dcd67135d24807fc64c8fcdb','2026-03-02','실적 발표가 Denton North의 AI 가동과 South 일부 가동을 명시했습니다.'),
 ('CoreWeave Denton TX','2026-07-03'): ('a0843b5780f43446703284c9a512f22e0dc9c7e0f8bfa93d2c8a11ee53ce181a','2026-07-03','실적 자료의 연중 가동 진술과 영상에 따른 당시 운영 상태입니다. 새로운 정확한 가동 개시일을 뜻하지 않습니다.'),
 ('CoreWeave Marble NC','2026-05-06'): ('edea42bcb173d050c8aef88600b743e1db63afd891105f6580f32b63d14d1bc8','2026-05-06','Core Scientific의 인도 완료 및 청구 가능한 고객 전력 약 65 MW 가동 진술을 근거로 삼았습니다.'),
 ('Microsoft Fairwater Wisconsin','2026-04-16'): ('ba7140ddac3fdeaaf39e8bdf0686f7b9f644b707a054b5539139f294367d0b92','2026-04-16','Microsoft CEO의 해당 날짜 Fairwater 가동 발표입니다. 첫 건물의 운영이며 전체 증설 완료는 아닙니다.'),
 ('Google Bristow','2024-04-29'): ('73e58b5ec8ea054507baa72a8624a25d6675ace12fd62dc449bfbd88e314b2f2','2024-04-29','냉각탑 팬의 회전 흔적을 근거로 일부 건물의 운영을 판단합니다. 다른 건물의 공사는 별도입니다.'),
 ('Google Bristow','2026-05-20'): ('9acd0769679f7883538c1007b5742172006b7990fbc55670b0fc00242ea035bf','2026-05-20','냉각탑 팬의 회전 흔적에 따른 일부 건물 운영 판단입니다.'),
 ('Google Arcola','2026-06-16'): ('d0aa358ca38680e72a40f8335703c6fb69c20a509dc9db47b297b7945f78748d','2026-06-16','냉각탑 회전 흔적과 직접 시각 확인에 따른 일부 건물 운영 판단입니다.'),
 ('Meta Eagle Mountain','2026-05-02'): ('eda0dfa8073274f973ad48628a017d1aac6b10578ad4cf478f39dfe5a0315bfa','2026-05-02','여러 냉각 팬의 회전 흔적에 따른 일부 건물 운영 판단입니다. 완성된 외관이나 주차 차량만을 근거로 삼지 않았습니다.'),
 ('Meta Aiken','2026-08-07'): ('e7ca09db8d10e79b8be46295b250fbcff4714358a73efdb4d5803af0865fffcb','2026-08-07','드론 영상에서 첫 건물 냉각 팬 9개 군 중 8개 군의 회전을 확인했습니다. 두 번째 건물의 설비 설치는 운영 확인이 아닙니다.'),
 ('CoreWeave Chester VA','2026-05-20'): ('c00f4b9cd81910290bb657375affa0a5ff00ca9c8daad8764914945ebcc2bfa6','2026-05-20','두 번째 건물의 냉각 팬 회전 흔적에 따른 일부 운영 판단입니다. 세 번째 건물의 부지 공사를 운영으로 바꾸지 않았습니다.'),
 ('Core42 Lake Mariner','2025-10-01'): ('aacbfffeeceb85f608fb38ca72b65f231b52c1267be62cbd4e2a1c784e47ec26','2025-10-01','9월 30일 기준 HPC 전력 가동을 명시한 TeraWulf 발표를 근거로 한 10월 1일의 일부 운영 상태입니다. 정확한 통전 개시일은 아닙니다.'),
 ('Core42 Lake Mariner','2026-07-23'): ('8da721171c3678bd0e622f95562236dcd26b6b6d66684d099a0236f35d242954','2026-07-23','이전 직접 운영 근거가 있는 시설의 영상상 운영 유지 관측입니다.'),
 ('Google Pryor (North)','2026-09-06'): ('c00333b0e077721a61c8d8fec098132d270d70e5d410cf83d12e9350bdbf0781','2026-09-08','CSV 행은 9월 6일이지만 실제 회전 팬 영상의 날짜는 원문이 명시한 9월 8일입니다. 9월 6일로 운영을 소급하지 않았습니다.'),
 ('Meta Prometheus','2026-08-31'): ('8c4d2ed36b0258f323db9f90847d775490fc13db2bd2b05920c5ba42db83586a','2026-08-31','당일 열영상에서 7~10번 건물의 밝은 배기구와 남측 전원 가동을 관측했습니다. 북측 건물과 13번 건물은 운영 완료로 판단하지 않습니다.'),
 ('QTS Richmond 1','2024-06-23'): ('3e3f53cbfca307a21d52b939b40500f1faa4782352d05bb201673a0d04c2124f','2024-06-23','회전 팬은 첫 번째 건물에서 관측됐습니다. 캠퍼스 일부 운영만 뒷받침하며 외관만으로 추정한 두 번째 건물의 운영을 확인하지 않습니다.'),
 ('OpenAI Stargate Abilene','2025-09-26'): ('a12a4e9f4d6bb60424dfd71e4db87f28e23e5999921e527995b4e6371b78d499','2025-09-30','Crusoe가 첫 단계를 live로 발표한 9월 30일을 사용합니다. 원문 행의 추정일 9월 26일이나 전체 건물 완공을 운영 사건으로 기록하지 않습니다.'),
}


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def slug(value):
    return re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode().lower()).strip('-')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def number(value):
    if value is None or value == '':
        return None
    result = float(value)
    if not math.isfinite(result) or result < 0:
        raise ValueError('Invalid nonnegative numeric source value')
    return result


def parse_csv(body, required):
    reader = csv.DictReader(io.StringIO(body.decode('utf-8-sig')))
    if not reader.fieldnames or not set(required).issubset(reader.fieldnames):
        raise ValueError('Epoch CSV schema changed or an error page replaced CSV')
    rows = list(reader)
    if not rows or any(None in row for row in rows):
        raise ValueError('Empty or malformed Epoch CSV')
    return rows


def address_location(center):
    address = center['Address'].strip()
    codes = '|'.join(sorted(STATES.values()))
    match = re.search(r'\b(' + codes + r')\b(?=\s*[,\s]*(?:\d{5}|USA|$))', address)
    state = match[1] if match else next((code for name, code in STATES.items() if re.search(r'\b' + name + r'\b', address, re.I)), None)
    city = None
    if match:
        prefix = address[:match.start()].strip(' ,')
        if ',' in prefix:
            city = prefix.rsplit(',', 1)[-1].strip() or None
    hint = PLACE_HINTS.get(center['Name'])
    if hint:
        state = state or hint[0]
        city = city or hint[1]
    if state is None:
        state = next((code for name, code in STATES.items() if re.search(r'\b' + name + r'\b', center['Name'])), None)
    return state, city


def operating_confirmation(row):
    reviewed = OPERATION_REVIEW.get((row.get('Data center'), row.get('Date')))
    if reviewed and hashlib.sha256(row['Construction status'].encode()).hexdigest() == reviewed[0]:
        return reviewed
    return None


def observed_status(row, previous='unknown'):
    """Classify source statements, never the passage of a target completion date.

    Epoch explicitly models operation from imagery and typical schedules. The
    reviewed evidence establishes partial operation only, which cannot complete
    every gate for the broader campus. It supports construction/expansion with a
    dated note; an operational word or positive modeled count never means zero.
    """
    text = row['Construction status'].strip()
    lower = text.lower()
    if not text:
        return None
    if re.search(r'\b(cancelled|canceled|abandoned)\b', lower):
        return 'cancelled'
    if re.search(r'\b(construction (?:is |was )?(?:paused|halted)|project (?:is |was )?paused)\b', lower):
        return 'paused'
    if number(row['Buildings operational']) and operating_confirmation(row):
        return 'construction'
    construction = bool(re.search(r'\b(construction|land clearing|groundwork|grading|foundations?|roof(?:ed|ing|s)?|shells?|steel framing|chillers?|cooling|generators?)\b', lower))
    if construction and not re.search(r'\b(?:no|not yet|before) construction\b|construction (?:will|is expected|is scheduled)', lower):
        return 'construction'
    if re.search(r'\b(planned|announced|proposed|purchased|acquired)\b', lower):
        return 'planned'
    return None


class Acquisition:
    def __init__(self, state_dir, previous):
        self.root = Path(state_dir)
        (self.root / 'raw').mkdir(parents=True, exist_ok=True)
        self.sources = {s['id']: s for s in previous.get('sources', [])}
        self.attempts = []

    def fetch(self, url):
        try:
            request = urllib.request.Request(url, headers={'User-Agent':'GridAtlas-EpochFacilityCollector/1.0'})
            with urllib.request.urlopen(request, timeout=45) as response:
                body = response.read(16 * 1024 * 1024 + 1)
                final = response.url
            if len(body) > 16 * 1024 * 1024:
                raise ValueError('Epoch response exceeds 16 MiB')
            sha = hashlib.sha256(body).hexdigest()
            stamp = now()
            path = self.root / 'raw' / (sha + '.bin')
            path.write_bytes(body)
            doc = {'url':url, 'finalUrl':final, 'sha256':sha, 'retrievedAt':stamp, 'body':body}
            self.attempts.append({k:v for k,v in doc.items() if k != 'body'} | {'status':'success', 'rawPath':str(path)})
            return doc
        except Exception as exc:
            self.attempts.append({'url':url, 'status':'failed', 'checkedAt':now(), 'error':str(exc)})
            raise

    def evidence(self, doc, row_name, excerpt, source_date):
        identity = 'epoch-source-' + digest([doc['url'], row_name, excerpt]) + '-' + doc['sha256'][:16]
        self.sources.setdefault(identity, {'id':identity, 'name':'Epoch AI · AI data centers · ' + row_name + ' (CC BY 4.0)',
            'url':doc['url'], 'retrievedAt':doc['retrievedAt'], 'sha256':doc['sha256'],
            'publishedAt':None, 'sourceAsOf':source_date,
            'excerpt':('Epoch AI, AI data centers. CC BY 4.0; ' + LICENSE + '\n' + excerpt)[:30000]})
        return identity


def normalize(centers, timelines, docs, acquisition, updated, cutoff):
    index = {}
    for row in timelines:
        dt.date.fromisoformat(row['Date'])
        for key in ['Buildings operational', 'IT power (MW)', 'Power (MW)']:
            number(row[key])
        index.setdefault(row['Data center'], []).append(row)
    if len({r['Name'] for r in centers}) != len(centers):
        raise ValueError('Duplicate Epoch center names require identity review')
    missing = set(index) - {r['Name'] for r in centers}
    if missing:
        raise ValueError('Timeline names not represented by center CSV: ' + ', '.join(sorted(missing)))
    facilities = []
    for center in centers:
        if center['Country'] != 'United States':
            continue
        # Alaska, Hawaii and US territories are not in the dashboard population.
        if re.search(r'\b(?:AK|HI|Alaska|Hawaii|Puerto Rico|Guam)\b', center['Address']):
            continue
        name = center['Name']
        identifier = 'LLF-EPOCH-' + slug(name)
        state, city = address_location(center)
        rows = sorted(index.get(name, []), key=lambda x:x['Date'])
        if len({r['Date'] for r in rows}) != len(rows):
            raise ValueError('Duplicate Epoch center/date requires revision review: ' + name)
        # Publish normalized, relevant evidence excerpts, never the full source
        # row (chip, investor, compute cost, and other unrelated research fields).
        center_excerpt = {'facility':name, 'country':center['Country'], 'address':center['Address'],
                          'ownerResearchLabel':center['Owner'], 'selectedSourceReferences':center['Selected Sources']}
        center_id = acquisition.evidence(docs[0], name, json.dumps(center_excerpt, ensure_ascii=False), updated)
        past = [r for r in rows if r['Date'] <= cutoff]
        relevant_timeline = [{'date':r['Date'], 'researchStatus':r['Construction status'],
                             'modeledOperationalBuildings':number(r['Buildings operational']),
                             'modeledItPowerMw':number(r['IT power (MW)']), 'modeledFacilityPowerMw':number(r['Power (MW)'])}
                            for r in past]
        timeline_id = acquisition.evidence(docs[1], name, json.dumps(relevant_timeline, ensure_ascii=False), updated) if rows else None
        source_ids = [center_id] + ([timeline_id] if timeline_id else [])
        f = {'id':identifier, 'name':name, 'operator':re.sub(r'\s*#\w+', '', center['Owner']).strip() or None,
             'sector':'data_center', 'region':'Unknown', 'regionBasis':'unknown', 'state':state, 'county':None, 'city':city,
             'lat':None, 'lon':None, 'identityKind':'campus', 'parentId':None, 'lifecycle':'unknown', 'asOf':None,
             'sourceIds':source_ids, 'capacityFacts':[], 'events':[], 'gridEvidence':[], 'aliases':[], 'legacyProjectIds':[],
             'notes':['Epoch AI의 공개 연구자료를 CC BY 4.0으로 재사용했습니다: ' + PAGE + ' · ' + LICENSE,
                      '위성영상·공개문서에 근거한 연구 추정입니다. 공식 접속신청·계약·통전 승인 원장이 아닙니다. 일부 건물 운영은 전체 캠퍼스 완공을 뜻하지 않습니다.',
                      '용량은 Epoch가 모델링한 가동 단계의 IT/시설 전력입니다. 요청·계약 용량이나 전체 캠퍼스 설계용량이 아니므로 phase 범위로 분리하고 캠퍼스 용량 가중 분모에 합산하지 않습니다.',
                      '이 수집기는 예정일·통상 공사기간 경과만으로 추정한 운영을 실제 운영 단계로 승격하지 않습니다. 원문의 추정 설명과 과거 기준일은 근거에 보존합니다.',
                      '일부 건물의 운영이 확인돼도 전체 캠퍼스 완료나 다섯 요건 통과로 바꾸지 않습니다. 검토한 부분 운영은 날짜와 근거를 기록하고 공사·증설 단계로 보수 평가합니다.',
                      '원문 주소: ' + (center['Address'].strip() or '미공개')]}
        for row in sorted(past, key=lambda r: (operating_confirmation(r) or ('', r['Date']))[1]):
            status = observed_status(row, f['lifecycle'])
            confirmation = operating_confirmation(row)
            effective_date = confirmation[1] if confirmation else row['Date']
            # An explicitly later evidence date cannot leak into an earlier
            # historical cutoff simply because the CSV row uses an estimate.
            if effective_date > cutoff:
                status = None
            if status:
                f['lifecycle'] = status
                f['asOf'] = effective_date
                review_note = (' 검토한 운영 근거: ' + confirmation[2]) if confirmation else ''
                payload = {'date':effective_date, 'status':status, 'note':'Epoch AI의 시설 관측/판단을 재분류한 상태입니다. 공식 계통 승인·통전 증거가 아닙니다. 원문 행 날짜: ' + row['Date'] + '.' + review_note + ' 원문: ' + row['Construction status']}
                f['events'].append({'id':identifier + '-event-' + digest(payload), **payload, 'sourceIds':[timeline_id]})
            for key, measure in [('IT power (MW)', 'it_power'), ('Power (MW)', 'facility_power')]:
                value = number(row[key])
                # Zero modeled online power is not a zero-capacity project.
                if value is None or value <= 0:
                    continue
                payload = {'value':value, 'unit':'MW', 'measure':measure, 'scope':'phase', 'asOf':row['Date'],
                           'note':'Epoch AI 연구모형의 가동 부분 전력 추정. ' + key + '; 전체 캠퍼스·신청·계약 MW가 아니며 운영 사실의 독립 근거로 쓰지 않습니다.'}
                f['capacityFacts'].append({'id':identifier + '-power-' + digest(payload), **payload, 'sourceIds':[timeline_id]})
        forecast_count = len(rows) - len(past)
        if forecast_count:
            f['notes'].append('원문 미래 전망 ' + str(forecast_count) + '개는 운영 사건·과거 용량에서 제외했습니다.')
        if not past:
            f['notes'].append('과거 진행 관측이 없어 단계 미확인으로 보존했습니다.')
        apply_geography(f)
        facilities.append(f)
    if not facilities:
        raise ValueError('No US mainland facilities in Epoch data')
    return facilities


def merge_previous(previous, current):
    result = {f['id']:copy.deepcopy(f) for f in previous.get('facilities', [])}
    for f in current:
        old = result.get(f['id'])
        if old:
            for field in ['events', 'capacityFacts', 'gridEvidence']:
                items = {r['id']:copy.deepcopy(r) for r in old[field]}
                for row in f[field]:
                    prior = items.get(row['id'])
                    items[row['id']] = {**row, 'sourceIds':sorted(set(row['sourceIds'] + (prior['sourceIds'] if prior else [])))}
                f[field] = list(items.values())
            f['sourceIds'] = sorted(set(old['sourceIds'] + f['sourceIds']))
        result[f['id']] = f
    return sorted(result.values(), key=lambda f:f['id'])


def collect(output, state_dir):
    output = Path(output)
    previous = json.loads(output.read_text()) if output.exists() else {'sources':[], 'facilities':[]}
    acquisition = Acquisition(state_dir, previous)
    report = {'id':'epoch', 'status':'failed', 'generatedAt':now(), 'sources':acquisition.attempts,
              'startedWithFacilities':len(previous['facilities']), 'facilityCount':len(previous['facilities'])}
    try:
        page = acquisition.fetch(PAGE)
        page_text = html.unescape(page['body'].decode())
        if LICENSE not in page_text:
            raise ValueError('Epoch attribution/license reference missing; review changed source terms')
        match = re.search(r'"updateDate"\s*:\s*\[3,\s*"(\d{4}-\d{2}-\d{2})', page_text)
        if not match:
            raise ValueError('Epoch source update date unavailable')
        updated = match[1]
        cutoff = min(updated, dt.datetime.now(dt.timezone.utc).date().isoformat())
        if updated > cutoff:
            raise ValueError('Epoch source update date is in the future')
        docs = [acquisition.fetch(CENTERS), acquisition.fetch(TIMELINES)]
        centers = parse_csv(docs[0]['body'], ['Name','Country','Address','Owner','Current power (MW)','Selected Sources'])
        timelines = parse_csv(docs[1]['body'], ['Data center','Date','Construction status','Buildings operational','IT power (MW)','Power (MW)'])
        page_id = acquisition.evidence(page, 'Methodology and attribution', 'Independent estimates from imagery, permits and public statements. Published update ' + updated + '. Center Current power is IT power; timeline Power includes facility overhead. Licensed attribution: Epoch AI.', updated)
        current = normalize(centers, timelines, docs, acquisition, updated, cutoff)
        # Reviewed cross-source identities are maintained separately from the
        # discovery parser. A research alias enriches a primary operator record;
        # it must not replace that record's current reported lifecycle.
        decisions_path = Path(__file__).resolve().parents[2] / 'data/large-load-facility-decisions.json'
        decisions = json.loads(decisions_path.read_text()).get('decisions', []) if decisions_path.exists() else []
        enrichment = set()
        phases = set()
        for decision in decisions:
            members = decision.get('facilityIds', [])
            if decision.get('kind') == 'same_entity':
                enrichment.update(i for i in members[1:] if i.startswith('LLF-EPOCH-'))
            elif decision.get('kind') == 'part_of' and members and members[0].startswith('LLF-EPOCH-'):
                phases.add(members[0])
        for f in current:
            f['sourceIds'].append(page_id)
            if f['id'] in phases:
                f['identityKind'] = 'phase'
        facilities = merge_previous(previous, current)
        for f in facilities:
            if f['id'] in enrichment:
                # Research describes partial campus activity. Keep its dated
                # evidence without replacing the primary facility's history.
                for event in f['events']:
                    event['evidenceOnly'] = True
        fragment = {'schemaVersion':1, 'id':'epoch', 'generatedAt':now(), 'sources':list(acquisition.sources.values()),
                    'facilities':facilities, 'enrichmentOnlyFacilityIds':sorted(enrichment & {f['id'] for f in facilities}), 'limitations':[
                        'Epoch AI, AI data centers (' + PAGE + '), CC BY 4.0 (' + LICENSE + '). 미국 본토 행을 선별하고 단계·권역·전력범위를 재분류한 파생 자료입니다.',
                        'Epoch의 대형 AI 시설 연구 표본이며 전국 데이터센터·산업시설·계통접속 신청의 전수가 아닙니다.',
                        '위성영상/설비 기반 전력 연구 추정과 공식 요청·계약·실제 소비를 구분합니다. 가동 부분 MW는 캠퍼스 용량 가중 분모에서 제외합니다.',
                        '미래 전망과 목표일 경과만으로 만든 운영 시점은 실제 과거 사건으로 적재하지 않습니다.',
                        '일부 건물 운영 증거는 전체 캠퍼스의 운영 완료·병목 0점을 의미하지 않습니다. 검토한 부분 운영은 날짜·이유와 함께 공사·증설 단계로 보존합니다.',
                        '출처 누락·취득 실패만으로 이전 시설과 과거 근거를 삭제하거나 철회 상태로 변경하지 않습니다.']}
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix('.tmp')
        temporary.write_text(json.dumps(fragment, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(output)
        report.update(status='success', sourceAsOf=updated, facilityCount=len(facilities), refreshedFacilities=len(current),
                      preservedFacilities=len(facilities)-len(current), globalSourceFacilities=len(centers),
                      timelineRows=len(timelines), excludedFutureTimelineRows=sum(r['Date']>cutoff for r in timelines))
    except Exception as exc:
        report['error'] = str(exc)
    report['generatedAt'] = now()
    (Path(state_dir) / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({k:v for k,v in report.items() if k != 'sources'}, ensure_ascii=False))
    return 0 if report['status'] == 'success' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args()
    raise SystemExit(collect(args.output, args.state_dir))
