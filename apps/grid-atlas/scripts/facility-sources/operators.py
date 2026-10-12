#!/usr/bin/env python3
"""Collect first-party facility pages, never a third-party data-center database.

The four adapters discover individual facilities from public operator navigation.
Normal runs acquire fresh HTTPS pages. --replay reprocesses verified local receipts
without claiming a fresh observation, for reproducible review and parser tests.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import html
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import sys
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler
from geography import apply_geography

OPERATORS = ('Digital Realty', 'DataBank', 'Equinix', 'QTS')
HOSTS = {'www.digitalrealty.com', 'www.databank.com', 'www.equinix.com', 'q.com'}
STATE_NAMES = dict(pair.split(':') for pair in (
    'Alabama:AL|Alaska:AK|Arizona:AZ|Arkansas:AR|California:CA|Colorado:CO|Connecticut:CT|Delaware:DE|'
    'Florida:FL|Georgia:GA|Hawaii:HI|Idaho:ID|Illinois:IL|Indiana:IN|Iowa:IA|Kansas:KS|Kentucky:KY|'
    'Louisiana:LA|Maine:ME|Maryland:MD|Massachusetts:MA|Michigan:MI|Minnesota:MN|Mississippi:MS|'
    'Missouri:MO|Montana:MT|Nebraska:NE|Nevada:NV|New Hampshire:NH|New Jersey:NJ|New Mexico:NM|'
    'New York:NY|North Carolina:NC|North Dakota:ND|Ohio:OH|Oklahoma:OK|Oregon:OR|Pennsylvania:PA|'
    'Rhode Island:RI|South Carolina:SC|South Dakota:SD|Tennessee:TN|Texas:TX|Utah:UT|Vermont:VT|'
    'Virginia:VA|Washington:WA|West Virginia:WV|Wisconsin:WI|Wyoming:WY|District of Columbia:DC').split('|'))
MAINLAND = set(STATE_NAMES.values()) - {'AK', 'HI'}
LIMITATIONS = [
    '운영사 4곳의 공개 시설·캠퍼스 목록에 대한 부분 조사이며 미국 전체 데이터센터 전수나 접속신청 원장이 아닙니다.',
    '서비스 도시 페이지는 실제 시설로 만들지 않습니다. DataBank는 개별 건물, QTS는 명시된 캠퍼스 단위이며 캠퍼스 전체 용량을 각 건물에 복제하지 않습니다.',
    'IT 부하·시설 전력은 접속 요청 MW와 다릅니다. 단위가 없는 원시 전력 필드나 회사·도시 전체 용량은 시설 MW로 변환하지 않습니다.',
    '직접 가동 표현이 없는 운영사 서비스 목록은 운영 추정이며 통전 확인이 아닙니다. 개별 시설의 계획·공사 표현과 상충 자료를 우선하며 최초 운영일을 만들지 않습니다.',
    '원문 기준일이 없는 시설 페이지는 asOf=null을 유지합니다. 실제 취득시각은 출처 retrievedAt으로만 기록합니다.',
    '수집 실패·목록 누락만으로 시설을 삭제하거나 취소하지 않습니다. 이전 확인 자료를 보존하고 실행 보고서에 불완전 수집을 기록합니다.',
    '다른 운영사·테넌트가 같은 주소를 사용할 수 있습니다. 동일 도시나 주소만으로 시설을 합치지 않았으며 운영사 간 물리 중복 연결은 별도 검토가 필요합니다.',
]


def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def plain(value):
    value = re.sub(r'<(script|style)\b[^>]*>.*?</\1>', '', value, flags=re.S | re.I)
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', value)).split())


def main_text(page):
    match = re.search(r'<h1\b', page, re.I)
    if not match:
        raise ValueError('Missing facility heading')
    text = plain(page[match.start():])
    # Exclude shared news cards, office addresses and footer links from facts.
    return re.split(r'\b(?:Resources Becoming|Get Started Discover|CENTRAL DATA CENTERS|Request a Quote Let us|U\.S\. Headquarters)\b', text)[0]


class Links(HTMLParser):
    def __init__(self, page):
        super().__init__(convert_charrefs=True)
        self.urls = set()
        self.feed(page)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a' and attrs.get('href'):
            self.urls.add(attrs['href'])


def heading(page):
    match = re.search(r'<h1\b[^>]*>(.*?)</h1>', page, re.S | re.I)
    if not match:
        raise ValueError('Missing h1')
    return plain(match[1])


def postal_state(text):
    match = re.search(r'\b(' + '|'.join(sorted(MAINLAND)) + r')\s*\d{5}(?:-\d{4})?\b', text)
    return match[1] if match else None


def coordinate(value, axis):
    try:
        number = float(value)
        return number if math.isfinite(number) and abs(number) <= (90 if axis == 'lat' else 180) and number != 0 else None
    except (ValueError, TypeError):
        return None


def empty_facility(identifier, name, operator, state, city, source_id, kind='facility'):
    if state not in MAINLAND:
        raise ValueError('An explicit mainland state is required: ' + str(state))
    return dict(id=identifier, name=name, operator=operator, sector='data_center', region='Unknown',
                state=state, county=None, city=city, lat=None, lon=None, identityKind=kind, parentId=None,
                lifecycle='unknown', asOf=None, sourceIds=[source_id], capacityFacts=[], events=[],
                gridEvidence=[], aliases=[], legacyProjectIds=[], notes=[])


def source(receipt, name, excerpt):
    # Content-addressed IDs preserve old evidence when a page changes or only a
    # subset of its dependent facilities could be revalidated.
    identifier = 'operator-source:' + hashlib.sha256(receipt['url'].encode()).hexdigest()[:16] + ':' + receipt['sha256'][:12]
    return dict(id=identifier, name=name, url=receipt['url'], retrievedAt=receipt['retrievedAt'],
                sha256=receipt['sha256'], publishedAt=None, excerpt=excerpt[:2400], sourceAsOf=None)


def capacity(facility, value, measure, note):
    if not math.isfinite(value) or value <= 0:
        raise ValueError('Invalid disclosed capacity')
    facility['capacityFacts'].append(dict(id=facility['id'] + ':power', value=value, unit='MW', measure=measure,
        scope=facility['identityKind'], asOf=None, sourceIds=list(facility['sourceIds']), note=note))


def describe_lifecycle(facility, text, allow_listing=True):
    """Interpret only an adapter's own facility description, not global navigation.

    A partial build keeps the campus in development. Service availability alone
    is explicitly labelled as an inference, never an observed grid milestone.
    """
    construction = re.search(r'\b(?:under construction|are being constructed|is building|construction (?:of [^.!?]{1,100} )?(?:is )?(?:currently )?under\s?way)\b', text, re.I)
    planned = re.search(r'\b(?:will be built|planned data center|planned as|planned \d+(?:[,.]\d+)?\s*(?:[-+]\s*)?(?:building|MW)|coming soon|will open|under development|will deliver|will join|will provide|is being developed|to be built|is developing|is exploring|will be|will offer|is establishing|to establish|working with [^.!?]{0,100} to establish|being developed|announce plans)\b', text, re.I)
    # Bare "in operation" often describes neighboring buildings (IAD1/IAD3 on
    # the future IAD4 page). Retain explicit openings such as SLC6 opened in 2023.
    direct = re.search(r'\b(?:opened in|is now open|now operational|is operating|currently operating)\b', text, re.I)
    if construction:
        lifecycle = 'construction'
    elif direct:
        lifecycle = 'operating'
    elif planned:
        lifecycle = 'planned'
    else:
        lifecycle = 'operating' if allow_listing else 'unknown'
    facility['lifecycle'] = lifecycle
    if lifecycle == 'operating' and not direct:
        facility['notes'].append('운영 추정: 운영사의 현재 서비스·시설 등재를 근거로 분류했습니다. 직접적인 가동·통전 완료 확인이나 최초 운영일은 미확보입니다.')
    elif lifecycle in {'construction', 'planned'}:
        matched = construction or planned
        facility['notes'].append('개별 시설 설명의 개발 상태: ' + text[max(0, matched.start()-90):matched.end()+160] + ' — 일부 운영·후속 증설이 함께 있을 수 있어 전체 캠퍼스 완료로 해석하지 않습니다.')
    return lifecycle


def next_data(page):
    match = re.search(r'<script\b[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    if not match:
        raise ValueError('Digital Realty public page data missing')
    return json.loads(match[1])['props']['pageProps']['data']


def field(data, name):
    values = data.get(name) or []
    return values[0].get('value') if values else None


def digital_realty(page, receipt):
    data = next_data(page)
    address = plain(field(data, 'field_address_location') or '')
    state = postal_state(address)
    if not state:
        match = re.search(r',\s*(' + '|'.join(sorted(MAINLAND)) + r')$', address)
        state = match[1] if match else None
    if not state:
        # Several pages spell out the state in the facility street address.
        state = next((code for name, code in STATE_NAMES.items() if re.search(r'\b' + re.escape(name) + r'\b', address)), None)
    intro = plain(field(data, 'field_intro_location') or '')
    code = field(data, 'field_site_code_location') or data['title']
    metro = (data.get('field_facility_location') or [{}])[0].get('name')
    evidence = source(receipt, 'Digital Realty ' + str(code), address + ' | ' + intro[:1800])
    address_before_state = re.split(r',\s*' + str(state) + r'(?=\s|\d|$)', address)[0]
    if ',' in address_before_state:
        city = re.sub(r'\([^)]*\)', '', address_before_state.split(',')[-1]).strip()
    else:
        # Strip the actual street suffix, not the marketed metro. Ashburn is not
        # Washington DC, nor is Santa Clara the same jurisdiction as San Jose.
        clean_address = re.sub(r'\([^)]*\)', '', address_before_state)
        parts = re.split(r'\b(?:Street|Road|Drive|Avenue|Boulevard|Lane|Way|Freeway|Ave|Rd|Plaza|Parkway|Row|Place)\b', clean_address)
        city = parts[-1].strip() if len(parts) > 1 else None
        city = re.sub(r'^(?:NW|NE|SW|SE)\s+', '', city or '') or None
    facility = empty_facility('LLF-digitalrealty-' + str(data['node_id']), 'Digital Realty ' + str(code),
                             'Digital Realty', state, city or None, evidence['id'])
    facility.update(lat=coordinate(field(data, 'field_latitude'), 'lat'), lon=coordinate(field(data, 'field_longitude'), 'lon'))
    facility['aliases'] = [str(code)]
    facility['notes'] = ['시설 주소: ' + address, '운영사 시장 분류: ' + str(metro) + ' (실제 소재 도시와 다를 수 있음).',
        '공개 시설 서비스 목록 기준. 최초 운영일·통전 승인일은 미확보.',
        '페이지 내부 utility_power_capacity 숫자는 공개 화면에서 단위를 검증하지 못하여 MW로 변환하지 않았습니다.']
    describe_lifecycle(facility, intro)
    return facility, evidence


def databank(page, receipt):
    text = main_text(page)
    code = re.search(r'\(([A-Z]{3}\d+)\)', text[:500])
    if not code:
        if 'Campus' in heading(page):
            return None  # Parent campus is navigation; buildings are collected separately.
        raise ValueError('No individual DataBank facility code; metro/campus pages are not facilities')
    address = re.search(r'\(' + code[1] + r'\)\s+(.+?\b([A-Z]{2})\s+\d{5}(?:-\d{4})?)\b', text)
    if not address:
        raise ValueError('No individual DataBank street address')
    city = re.search(r' - (.+?),\s*' + address[2] + r'\s+\d{5}', address[1])
    name = 'DataBank ' + code[1] + ' — ' + heading(page)
    match = re.search(r'([\d,.]+)\s*MW\s+Critical IT Load\b', text)
    excerpt = text[:1400] + (' | ' + match[0] if match else '')
    evidence = source(receipt, name, excerpt)
    facility = empty_facility('LLF-databank-' + code[1].lower(), name, 'DataBank', address[2], city[1] if city else None, evidence['id'])
    intro = text.split('IT Square Feet')[0]
    facility['aliases'] = [code[1]]
    facility['notes'] = ['시설 주소: ' + address[1], '개별 건물의 시설 코드 기준. 캠퍼스 전체 전력과 도시 총량은 이 건물에 배분하지 않습니다.',
        '현재 공개 시설 안내의 상태 표현을 보존하며 운영 개시일·접속 승인일은 추정하지 않습니다.']
    describe_lifecycle(facility, intro)
    # Historic videos below the current introduction are not automatically the
    # latest status. A specifically named, conflicting building remains unknown.
    later = text[len(intro):]
    conflict = re.search(r'\b(?:currently under construction|future site of ' + re.escape(code[1]) + r')\b', later, re.I)
    if conflict and facility['lifecycle'] == 'operating':
        facility['lifecycle'] = 'unknown'
        facility['notes'] = [note for note in facility['notes'] if not note.startswith('운영 추정:')]
        facility['notes'].append('상태 상충: 상단 서비스 설명과 하단의 동일 시설 공사·미래 부지 설명이 함께 존재하며 각각의 기준일이 없습니다. 운영 완료를 확정하지 않습니다. ' + later[max(0, conflict.start()-80):conflict.end()+200])
        evidence['excerpt'] += ' | ' + later[max(0, conflict.start()-80):conflict.end()+240]
    if match:
        capacity(facility, float(match[1].replace(',', '')), 'it_power', match[0] + ' — 개별 건물의 Critical IT Load; 신청 MW가 아닙니다.')
    return facility, evidence


def js_string(page, variable):
    match = re.search(r'\bconst\s+' + variable + r'\s*=\s*("(?:[^"\\]|\\.)*")\s*\|\|', page)
    if not match:
        return None
    # Public inline map strings use JS escaping, including escaped apostrophes;
    # normalize those to JSON without evaluating JavaScript.
    value = re.sub(r'\\x([a-fA-F0-9]{2})', lambda m: '\\u00' + m[1], match[1]).replace("\\'", "'")
    return json.loads(value)


def equinix(page, receipt):
    text = main_text(page)
    code = re.search(r'\b([A-Z]{2}\d+[A-Za-z]?)\b', heading(page))
    country = js_string(page, 'country')
    if not code or country != 'United States of America':
        raise ValueError('Not an individually identified United States IBX facility')
    state = postal_state(text[:1800])
    inferred_state = False
    if not state and js_string(page, 'city') and js_string(page, 'postalCode'):
        match = re.search(re.escape(js_string(page, 'city')) + r',\s*([A-Z]{2})\s*' + re.escape(js_string(page, 'postalCode')), text)
        if match:
            state, inferred_state = match[1], True
    address = ' '.join(filter(None, [js_string(page, key) for key in ['address1', 'address2', 'city', 'postalCode']]))
    name = 'Equinix ' + code[1] + ' — ' + str(js_string(page, 'city') or '')
    evidence = source(receipt, name, text[:1600])
    facility = empty_facility('LLF-equinix-' + code[1].lower(), name, 'Equinix', state, js_string(page, 'city'), evidence['id'])
    facility.update(lat=coordinate(js_string(page, 'latitude'), 'lat'), lon=coordinate(js_string(page, 'longitude'), 'lon'))
    facility['aliases'] = [code[1]]
    facility['notes'] = ['시설 주소: ' + address, '공식 개별 IBX 서비스 안내 기준. N+1/2N은 중복 구성이지 MW 용량이 아닙니다.',
        'IBX·테넌트 시설이 다른 운영사의 같은 건물에 존재할 수 있으며 물리적 전력 중복은 별도 검토가 필요합니다.']
    describe_lifecycle(facility, text[:900])
    if inferred_state:
        facility['notes'].append('개별 주소의 주 약어가 빠져 페이지의 동일 도시·우편번호 표기로 소재 주를 확인했습니다.')
    return facility, evidence


def qts(page, receipt):
    text = main_text(page)
    name = heading(page)
    if re.search(r'\b(?:Spain|United Kingdom|Finland|Netherlands|Italy|Zaragoza|Vimercate)\b', text[:250], re.I):
        return None
    # A planned site's heading is more specific than a corporate footer or the
    # addresses of other campuses linked lower down the page.
    state = next((code for state_name, code in sorted(STATE_NAMES.items(), key=lambda item: -len(item[0]))
                  if re.search(r'\b' + re.escape(state_name) + r'\b', name)), None)
    if not state:
        state = postal_state(text)
    if not state:
        state = next((code for state_name, code in STATE_NAMES.items()
                      if re.search(r'\b' + re.escape(state_name) + r'\s+\d{5}\b', text)), None)
    if not state:
        state = next((code for state_name, code in sorted(STATE_NAMES.items(), key=lambda item: -len(item[0]))
                      if re.search(r'\b' + re.escape(state_name) + r'\b', text[:700])), None)
    name = name.replace('A tlanta', 'Atlanta')
    city = name.split(',')[0] if ',' in name else re.sub(r'\s+\d+$', '', name)
    slug = urlsplit(receipt['url']).path.rstrip('/').split('/')[-1]
    match = re.search(r'Critical campus capacity\s+([\d,.]+)\+?\s*MW(?:\+)?(?=\s|$)', text, re.I)
    if not match:
        match = re.search(r'([\d,.]+)\s*MW(\+)?\s+(?:of\s+)?critical (?:building|campus)', text, re.I)
    excerpt = text[:1400] + (' | ' + text[max(0, match.start()-90):match.end()+400] if match else '')
    evidence = source(receipt, 'QTS ' + name, excerpt)
    facility = empty_facility('LLF-qts-' + slug, 'QTS ' + name, 'QTS', state, city, evidence['id'], 'campus')
    intro = re.split(r'\b(?:Contact us if you have questions|Contact sales|Schedule a tour)\b', text, maxsplit=1)[0]
    # Inspect the actual building specifications too; a CTA is not the end of
    # the facility description. Exclude separate solar-project promotional news.
    details = re.sub(r'Avangrid Finishes Construction of New Oregon Solar Project.*?Learn more Learn more', '', text, flags=re.I)
    features = re.search(r'Our data center campus features\b(.*)', details, re.I)
    description = intro + (' | ' + features[1] if features else '')
    facility['notes'] = ['원문 캠퍼스 단위. 여러 건물·증설분이 포함될 수 있고 캠퍼스 용량은 현재 가동 MW나 계통 신청 MW가 아닙니다.',
        '향후 통전 목표를 실제 운영 사건으로 추가하지 않았습니다. 운영 캠퍼스 내 건설 중 건물은 별개일 수 있습니다.']
    describe_lifecycle(facility, description,
        allow_listing=not ('Contact us if you have questions' in text[:450] and not re.search(r'\b(?:offers|supports|features|operated|operating|serves)\b', intro, re.I)))
    # Marketed metro names are not municipalities. Use this site's Location
    # address when the publisher supplies its city and state explicitly.
    state_label = next(key for key, value in STATE_NAMES.items() if value == state)
    located = re.search(r'\bLocation\s+[^,]{3,120},\s*([A-Za-z .-]+?),?\s+(?:' + re.escape(state_label) + '|' + state + r')\s+\d{5}\b', text)
    if located:
        facility['city'] = located[1].strip()
    addresses = re.findall(r'.{0,100}\b' + state + r'\s+\d{5}(?:-\d{4})?.{0,20}', text)
    if addresses:
        facility['notes'].append('페이지 소재지: ' + ' | '.join(dict.fromkeys(addresses))[:1300])
    if match:
        is_building = 'critical building' in match[0].lower()
        capacity(facility, float(match[1].replace(',', '')), 'facility_power', match[0] +
                 (' — 원문 건물 critical power 공시; 캠퍼스 전체나 접속신청 용량이 아닙니다.' if is_building else ' — 캠퍼스 critical power 공시; 계획 용량/증설을 포함할 수 있으며 접속신청 아님.'))
        if is_building:
            facility['capacityFacts'][-1]['scope'] = 'facility'
    return facility, evidence


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_url(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.username or parsed.password:
        raise ValueError('Only the operators public HTTPS pages are allowed')


class Archive:
    def __init__(self, state_dir, replay=False):
        self.root = state_dir / 'raw'
        self.root.mkdir(parents=True, exist_ok=True)
        self.replay, self.cache, self.attempts = replay, {}, []
        self.receipts = {}
        for path in sorted(self.root.glob('*.meta.json')):
            try:
                item = json.loads(path.read_text())
                if item.get('status') == 'fetched':
                    self.receipts[item['url']] = (item, path)
            except (ValueError, KeyError):
                continue

    def fetch(self, url):
        validate_url(url)
        if url in self.cache:
            return self.cache[url]
        key = hashlib.sha256(url.encode()).hexdigest()[:24]
        result = dict(id=key, url=url, retrievedAt=now())
        try:
            if self.replay:
                result, metadata_path = self.receipts[url]
                raw_path = self.root / (result['sha256'] + '.html')
                if not raw_path.exists():
                    raw_path = metadata_path.with_name(metadata_path.name.removesuffix('.meta.json') + '.html')
                body = raw_path.read_bytes()
                if hashlib.sha256(body).hexdigest() != result['sha256']:
                    raise ValueError('Archive hash mismatch')
            else:
                with build_opener(SafeRedirect()).open(Request(url, headers={'User-Agent': 'GridAtlas-public-facility-research/1.0'}), timeout=25) as response:
                    body = response.read(32 * 1024 * 1024 + 1)
                    if len(body) > 32 * 1024 * 1024:
                        raise ValueError('Page exceeds 32 MiB')
                    validate_url(response.url)
                    result.update(status='fetched', httpStatus=response.status, finalUrl=response.url,
                                  sha256=hashlib.sha256(body).hexdigest(), bytes=len(body))
                (self.root / (result['sha256'] + '.html')).write_bytes(body)
                (self.root / (key + '.meta.json')).write_text(json.dumps(result, indent=2) + '\n')
            page = body.decode('utf-8')
            self.cache[url] = page, result
            self.attempts.append(dict(id=key, url=url, status='success', sha256=result['sha256'], retrievedAt=result['retrievedAt'], replay=self.replay))
            return page, result
        except Exception as error:
            self.attempts.append(dict(id=key, url=url, status='failed', error=str(error), retrievedAt=now()))
            self.cache[url] = None
            return None

    def many(self, urls):
        urls = sorted(set(urls))
        if len(urls) > 400:
            raise ValueError('Unexpected directory size; review before expanding collection')
        with ThreadPoolExecutor(max_workers=4) as pool:
            return dict(zip(urls, pool.map(self.fetch, urls)))


def required(archive, url):
    value = archive.fetch(url)
    if value is None:
        raise ValueError('Index unavailable: ' + url)
    return value[0]


def discover(archive, operator):
    if operator == 'Digital Realty':
        page = required(archive, 'https://www.digitalrealty.com/data-centers')
        records = next_data(page)['facilities']
        urls = [urljoin('https://www.digitalrealty.com', item['url-alias']) for item in records if item.get('country') == 'USA']
    elif operator == 'DataBank':
        page = required(archive, 'https://www.databank.com/data-centers/')
        metros = [url for url in Links(page).urls if re.fullmatch(r'https://www.databank.com/data-centers/[^/]+/', url)
                  and url.rstrip('/').split('/')[-1] not in {'london', 'data-center-design', 'edge-strategy'}]
        urls = []
        for metro, value in archive.many(metros).items():
            if value is None:
                continue
            urls.extend(url for url in Links(value[0]).urls if url.startswith(metro) and url != metro
                        and not any(char in url for char in '?#') and not url.rstrip('/').endswith('campus'))
    elif operator == 'Equinix':
        page = required(archive, 'https://www.equinix.com/data-centers')
        metros = [urljoin('https://www.equinix.com', url) for url in Links(page).urls
                  if re.fullmatch(r'/data-centers/americas-colocation/united-states-colocation/[^/]+-data-centers', url)]
        urls = []
        for value in archive.many(metros).values():
            if value is None:
                continue
            urls.extend(urljoin('https://www.equinix.com', url) for url in Links(value[0]).urls
                        if re.fullmatch(r'/data-centers/americas-colocation/united-states-colocation/[^/]+/[a-z]{2}\d+[a-z]?', url))
    else:
        page = required(archive, 'https://q.com/data-centers/')
        urls = [url for url in Links(page).urls if re.fullmatch(r'https://q.com/data-centers/[^/]+/', url)
                and url.rstrip('/').split('/')[-1] != 'feed' and not url.rstrip('/').endswith('-es')]
    if len(set(urls)) < 10:
        raise ValueError('Unexpectedly small facility directory; retain previous data')
    return sorted(set(urls))


def validate_fragment(data):
    sources = {item['id']: item for item in data['sources']}
    if len(sources) != len(data['sources']):
        raise ValueError('Duplicate source ID')
    identities = set()
    for facility in data['facilities']:
        if facility['id'] in identities or facility['state'] not in MAINLAND or not facility['sourceIds']:
            raise ValueError('Duplicate or unlocated facility')
        identities.add(facility['id'])
        for identifier in facility['sourceIds']:
            if identifier not in sources:
                raise ValueError('Missing facility source')
        for fact in facility['capacityFacts']:
            if fact['value'] <= 0 or fact['measure'] in {'requested_grid', 'contracted_grid'}:
                raise ValueError('Operator catalog capacities must not be promoted to grid requests')
        if facility['events'] or facility['gridEvidence']:
            raise ValueError('Undated catalog pages cannot establish dated grid milestones')


def run(output, state_dir, replay=False):
    archive = Archive(state_dir, replay)
    previous = json.loads(output.read_text()) if output.exists() else {'facilities': [], 'sources': []}
    facilities = {item['id']: item for item in previous['facilities']}
    sources = {item['id']: item for item in previous['sources']}
    parsers = dict(zip(OPERATORS, [digital_realty, databank, equinix, qts]))
    outcomes, fresh_ids = [], set()
    for operator in OPERATORS:
        parsed, errors, ignored = 0, [], 0
        try:
            urls = discover(archive, operator)
            for url, acquired in archive.many(urls).items():
                if acquired is None:
                    errors.append({'url': url, 'error': 'Fetch failed; previous facility retained'})
                    continue
                try:
                    item = parsers[operator](*acquired)
                    if item is None:
                        ignored += 1
                        continue
                    facility, evidence = item
                    apply_geography(facility)
                    if facility['id'] in fresh_ids:
                        # Alternate navigation URLs cannot create additional facilities.
                        existing = facilities[facility['id']]
                        if existing['operator'] != facility['operator'] or existing['state'] != facility['state']:
                            raise ValueError('Conflicting duplicate facility identity')
                        continue
                    facilities[facility['id']], sources[evidence['id']] = facility, evidence
                    fresh_ids.add(facility['id'])
                    parsed += 1
                except (ValueError, KeyError, TypeError) as error:
                    errors.append({'url': url, 'error': str(error)})
            outcomes.append(dict(operator=operator, status='partial' if errors else 'success', parsed=parsed, ignored=ignored, errors=errors))
        except (ValueError, KeyError, TypeError) as error:
            outcomes.append(dict(operator=operator, status='failed', parsed=parsed, errors=[{'error': str(error)}]))
    retained = sorted(set(facilities) - fresh_ids)
    for identifier in retained:
        row = facilities[identifier]
        note = '이번 실행에서 재확인하지 못해 이전 확인 자료를 보존했습니다. 미등재·수집 실패는 폐쇄나 취소의 증거가 아닙니다.'
        if note not in row['notes']:
            row['notes'].append(note)
    used_sources = {identifier for item in facilities.values() for identifier in item['sourceIds']}
    data = dict(schemaVersion=1, id='operators', generatedAt=now(),
                sources=sorted((value for key, value in sources.items() if key in used_sources), key=lambda item: item['id']),
                facilities=sorted(facilities.values(), key=lambda item: item['id']), limitations=LIMITATIONS)
    total = sum(item['parsed'] for item in outcomes)
    failures = any(item['status'] != 'success' for item in outcomes) or any(item['status'] == 'failed' for item in archive.attempts)
    status = 'failed' if total == 0 else 'partial' if failures or retained else 'success'
    report = dict(status=status, generatedAt=data['generatedAt'], replay=replay, freshSourceFetch=not replay,
                  parsedFacilities=total, retainedFacilityIds=retained, operators=outcomes, sources=archive.attempts)
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    if total == 0:
        raise ValueError('All operator sources failed; existing fragment untouched')
    validate_fragment(data)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(output)
    print(json.dumps({'status': status, 'facilities': len(data['facilities']), 'freshlyParsed': total, 'retained': len(retained), 'operators': outcomes}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--replay', action='store_true', help='Verify and reuse actual prior receipts; performs no network requests')
    options = parser.parse_args()
    try:
        run(options.output.resolve(), options.state_dir.resolve(), options.replay)
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
