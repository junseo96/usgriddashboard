#!/usr/bin/env python3
"""Collect reviewed market-monitor reports, PG&E load ICA and EIA reliability.

--refresh obtains official bytes; --rebuild reproduces from the private raw cache;
--check validates the checked-in normalized result without network or mutation.
Report years/locators are reviewed explicitly: no extrapolation to live telemetry.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request
import zipfile

APP = Path(__file__).resolve().parents[1]
CACHE = APP / '.local/grid-constraints'
OUTPUT = APP / 'data/grid-constraints.json'
PG_BASE = 'https://services2.arcgis.com/mJaJSax0KPHoCNB6/arcgis/rest/services/DRPComplianceRelProd/FeatureServer'
PG_GUIDE_INDEX = 'https://services2.arcgis.com/mJaJSax0KPHoCNB6/arcgis/rest/services/PresignedURLPROD/FeatureServer/1/query?where=1%3D1&outFields=userguideurl&returnGeometry=false&f=json'
REGIONS = ['CAISO', 'ERCOT', 'PJM', 'MISO', 'SPP', 'NYISO', 'ISO-NE', 'West', 'Southeast']
CONTIGUOUS = set('AL AR AZ CA CO CT DC DE FL GA IA ID IL IN KS KY LA MA MD ME MI MN MO MS MT NC ND NE NH NJ NM NV NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI WV WY'.split())
REPORTS = {
    'pjm-2025': ('PJM', 'Monitoring Analytics', '2025 State of the Market Report for PJM — Section 11', 'https://www.monitoringanalytics.com/reports/PJM_State_of_the_Market/2025/2025-som-pjm-sec11.pdf'),
    'caiso-2025': ('CAISO', 'CAISO Department of Market Monitoring', '2025 Annual Report on Market Issues and Performance', 'https://www.caiso.com/documents/2025-annual-report-on-market-issues-and-performance.pdf'),
    'ercot-2025': ('ERCOT', 'Potomac Economics — ERCOT IMM', '2025 State of the Market Report for ERCOT', 'https://www.potomaceconomics.com/wp-content/uploads/2026/06/2025-State-of-the-Market-Report-for-ERCOT.pdf'),
    'miso-2025': ('MISO', 'Potomac Economics — MISO IMM', '2025 State of the Market Report for MISO', 'https://www.potomaceconomics.com/wp-content/uploads/2026/07/2025-State-of-the-Market-Report.pdf'),
    'spp-2025': ('SPP', 'SPP Market Monitoring Unit', '2025 Annual State of the Market Report', 'https://www.spp.org/Documents/76798/2025_Annual_State_of_the_Market_Report.pdf'),
    'nyiso-2025': ('NYISO', 'Potomac Economics — NYISO MMU', '2025 State of the Market Report for NYISO', 'https://www.potomaceconomics.com/wp-content/uploads/2026/05/NYISO-2025-SOM-Report__5-19-2026-final.pdf'),
    'isone-2025': ('ISO-NE', 'Potomac Economics — ISO-NE External Market Monitor', '2025 Assessment of the ISO New England Electricity Markets', 'https://www.potomaceconomics.com/wp-content/uploads/2026/06/ISO-NE-2025-EMM-Report_Final.pdf'),
}


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def metric(identifier, label, part, kind, unit, definition, caveat, higher=True, aggregation='none'):
    return dict(id=identifier, label=label, part=part, kind=kind, unit=unit,
                definition=definition, caveat=caveat, aggregation=aggregation, higherIsWorse=higher)


ECONOMIC_CAVEAT = '금융적 혼잡 정산액·권리 환급 전 수치로, 사회적 손실이나 소비자 순부담이 아니다. 시장별 정산 범위가 달라 전국 합계·순위를 만들지 않는다.'
METRICS = [
    metric('day_ahead_congestion_usdm', '하루전 혼잡 정산액', 'transmission', 'economic', '백만 USD', '시장감시기관이 보고한 하루전 혼잡 정산액·혼잡 지대. 개별 관측의 정산 범위와 원문 정의를 확인한다.', ECONOMIC_CAVEAT),
    metric('pjm_total_congestion_usdm', 'PJM 총 혼잡 정산액', 'transmission', 'economic', '백만 USD', 'PJM 하루전·조정시장 및 inadvertent charge를 반영한 연간 총 congestion costs, Table 11-11.', ECONOMIC_CAVEAT),
    metric('real_time_congestion_value_usdm', '실시간 혼잡의 경제적 가치', 'transmission', 'economic', '백만 USD', 'MISO 제약별 실시간 흐름 × shadow price를 시간에 걸쳐 합산한 nominal value. 실제 회수한 정산액과 다르다.', '제약의 shadow price × 흐름으로 계산한 nominal value다. 실제 정산수입, 재급전 생산비 총액, 사회적 손실 또는 소비자의 순부담으로 해석하지 않는다.'),
    metric('rt_congestion_event_hours', '실시간 제약별 누적 혼잡시간', 'transmission', 'constraint', '제약·시간', 'PJM 실시간 시장의 각 송전 제약에 발생한 혼잡 event-hours의 합.', '여러 제약이 같은 시간에 발생하면 중복으로 더한다. 8,760시간으로 나눠 권역 혼잡시간 비율을 만들 수 없다.'),
    metric('da_congestion_event_hours', '하루전 제약별 누적 혼잡시간', 'transmission', 'constraint', '제약·시간', 'PJM 하루전 시장의 각 송전 제약에 발생한 혼잡 event-hours의 합.', '제약별 누적시간이며 권역에서 혼잡이 있었던 고유 시간의 수가 아니다.'),
    metric('rt_constraint_violation_hours', '실시간 제약 초과 누적시간', 'transmission', 'constraint', '제약·시간', 'ERCOT SCED 시장 급전 흐름이 송전 운전한도를 초과한 constraint-hours 합.', '한도 초과와 단순 binding을 구분한다. 누적 제약시간이며 정전시간이나 연간 시간비율이 아니다.'),
    metric('rt_any_constraint_interval_percent', '실시간 혼잡 발생 구간 비율', 'transmission', 'constraint', '%', 'SPP 실시간 급전 구간 중 하나 이상의 binding 또는 breached 제약이 있었던 비율 = 100 − uncongested interval 비율.', '관측 시간 구간 기준이다. 제약을 겪은 송전선의 비율이나 정전율이 아니다. MISO market-to-market flowgate도 포함한다.'),
    metric('rt_breached_interval_percent', '실시간 제약 초과 구간 비율', 'transmission', 'constraint', '%', 'SPP 실시간 급전 구간 중 적어도 한 제약이 breached 상태였던 비율.', '시장모형 제약 초과 상태의 비율이다. 단순 binding·정전·열적 선로손상과 동일하지 않다.'),
    metric('isone_da_congestion_per_mwh_3year', '3년 평균 하루전 혼잡액 / 공급전력량', 'transmission', 'economic', 'USD/MWh', 'ISO-NE EMM가 보고한 2023–2025년 평균 하루전 혼잡 정산액의 실제 부하 MWh당 값.', '3년 평균 하나의 관측값이다. 2025년 단독값 또는 노드별 혼잡가격 격차로 읽지 않는다. '+ECONOMIC_CAVEAT),
    metric('pge_load_headroom_min_mw', '피더 구간 최소 부하 수용여유', 'distribution', 'hosting_capacity', 'MW', 'PG&E 공개 ICA 선로구간 LoadCapacity_kW 중 피더별 최솟값 ÷ 1,000. 추가 부하를 수용하는 모델 기반 계획 정보.', '동일 피더의 모든 위치가 이 값이라는 뜻은 아니다. 실측 이용률·서비스 승인·보장된 용량이 아니며 피더 간 MW를 합산하지 않는다. 분석 시점은 구간마다 다르다.', False),
    metric('pge_load_headroom_max_mw', '피더 구간 최대 부하 수용여유', 'distribution', 'hosting_capacity', 'MW', 'PG&E 공개 ICA 선로구간 LoadCapacity_kW 중 피더별 최댓값 ÷ 1,000.', '피더의 최댓값을 개별 부지 접속가능 용량으로 적용하지 않는다. 연결 지점마다 값이 다르고 공유 상위 설비 때문에 합산할 수 없다.', False),
    metric('pge_zero_load_headroom_percent', '부하 수용여유 0인 공개 구간 비율', 'distribution', 'hosting_capacity', '%', '피더별 LoadCapacity_kW = 0인 공개 선로구간 수 ÷ LoadCapacity_kW가 공개된 구간 수 × 100.', '선로구간 레코드 수 기준이다. 길이·고객·용량·실측시간 가중 비율이 아니며 세분화 방식의 영향을 받는다. null은 0으로 계산하지 않는다.'),
]
for suffix, title, unit, definition in [
    ('saidi_all', 'SAIDI · 대규모 사고일 포함', '분/고객·년', '지속정전 총 고객·분 ÷ 보고 고객 수'),
    ('saifi_all', 'SAIFI · 대규모 사고일 포함', '회/고객·년', '지속정전 총 고객·횟수 ÷ 보고 고객 수'),
    ('saidi_no_med', 'SAIDI · 대규모 사고일 제외', '분/고객·년', 'IEEE major event days를 제외한 지속정전 고객당 평균 시간'),
    ('saifi_no_med', 'SAIFI · 대규모 사고일 제외', '회/고객·년', 'IEEE major event days를 제외한 지속정전 고객당 평균 횟수'),
]:
    METRICS.append(metric('eia_ieee_'+suffix, title, 'distribution', 'reliability', unit,
                          'EIA-861 IEEE 기준: '+definition+'.',
                          '신뢰도 보조지표이며 배전 혼잡을 직접 측정하지 않는다. 기상·설비고장·공급상실 등 원인이 섞인다. 고객 수는 표에 발표된 보고 범위이며 지표별 유효 분모와 다를 수 있어 이 수로 주·전국 평균을 재가중하지 않는다. IEEE 미신고 기관은 이 계열에서 제외하고 ISO 평균으로 배분하지 않는다.'))


class Collector:
    def __init__(self, refresh=False):
        self.refresh = refresh
        self.sources = []

    def get(self, identifier, url, title, publisher, asof=None, public_url=None, retrieval_note=None):
        CACHE.mkdir(parents=True, exist_ok=True)
        meta_file = CACHE / (identifier+'.json')
        if not self.refresh:
            if not meta_file.exists():
                raise ValueError('Raw cache missing; run --refresh explicitly: '+identifier)
            meta = json.loads(meta_file.read_text())
            if meta['url'] != (public_url or url):
                raise ValueError('Cached URL changed: '+identifier)
            body = (CACHE / (meta['sha256']+'.bin')).read_bytes()
            if hashlib.sha256(body).hexdigest() != meta['sha256']:
                raise ValueError('Raw hash mismatch: '+identifier)
        else:
            request = urllib.request.Request(url, headers={'User-Agent': 'GridAtlas/1.0 public-source-research'})
            with urllib.request.urlopen(request, timeout=55) as response:
                body = response.read(32*1024*1024+1)
            if len(body) > 32*1024*1024:
                raise ValueError('Source exceeds 32MiB: '+identifier)
            sha = hashlib.sha256(body).hexdigest()
            meta = dict(id=identifier, title=title, publisher=publisher, url=public_url or url,
                        retrievedAt=utc_now(), sha256=sha, sourceAsOf=asof)
            if retrieval_note:
                meta['retrievalNote'] = retrieval_note
            (CACHE / (sha+'.bin')).write_bytes(body)
            meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2)+'\n')
        self.sources.append(meta)
        return body, meta


def pdf_text(body):
    if not body.startswith(b'%PDF-'):
        raise ValueError('Expected a PDF report')
    with tempfile.TemporaryDirectory() as folder:
        path = Path(folder) / 'report.pdf'
        path.write_bytes(body)
        return subprocess.check_output(['pdftotext', '-layout', str(path), '-'], text=True)


def observed(identifier, metric_id, region, value, year, source_ids, locator, note='', **extra):
    return dict(id=identifier, metricId=metric_id, region=region, scope=region,
                utility=None, state=None, periodStart=f'{year}-01-01', periodEnd=f'{year}-12-31',
                periodKind='annual', value=value, sourceIds=source_ids, locator=locator, note=note, **extra)


def require_text(text, pattern):
    match = re.search(pattern, text, re.S)
    if not match:
        raise ValueError('Reviewed report evidence no longer matches: '+pattern[:100])
    return match


def reports(collector):
    texts = {}
    rows = []
    for key, (region, publisher, title, url) in REPORTS.items():
        body, _ = collector.get(key, url, title, publisher, '2025-12-31')
        texts[key] = pdf_text(body)
    # Exact table rows, not graph-height estimates. Preserve all published years.
    pjm = texts['pjm-2025']
    table = pjm.split('Table 11-11 Total CLMP credits and charges by accounting category')[1].split('Charges and Credits versus Congestion:')[0]
    for line in table.splitlines():
        found = re.match(r'\s*(20\d\d)\s+(.*)', line)
        if not found:
            continue
        cells = re.findall(r'\(?\$[\d,]+\.\d+\)?', found[2])
        if len(cells) != 10:
            raise ValueError('PJM Table 11-11 column count changed')
        year = int(found[1])
        for metric_id, position in [('day_ahead_congestion_usdm', 3), ('pjm_total_congestion_usdm', 9)]:
            value = float(cells[position].replace('$', '').replace(',', ''))
            rows.append(observed(f'pjm-{metric_id}-{year}', metric_id, 'PJM', value, year, ['pjm-2025'], 'Table 11-11, p.676', 'PJM CLMP 정산범위, 원문 백만 USD 소수 1자리.'))
    if len(rows) != 36:
        raise ValueError('Expected PJM 2008–2025 table')
    compact = ' '.join(pjm.split())
    for metric_id, values, anchor in [
        ('da_congestion_event_hours', [78295, 76525], r'78,295 congestion event hours in 2024.{0,20}to 76,525 congestion event hours in 2025'),
        ('rt_congestion_event_hours', [27680, 30485], r'27,680 congestion event hours in.{0,20}2024 to 30,485 congestion event hours in 2025'),
    ]:
        require_text(compact, anchor)
        for year, value in zip([2024, 2025], values):
            rows.append(observed(f'pjm-{metric_id}-{year}', metric_id, 'PJM', value, year, ['pjm-2025'], 'Executive summary, p.666', '여러 송전 제약의 동시 발생시간을 합산하므로 고유 혼잡시간 비율이 아니다.'))
    caiso = ' '.join(texts['caiso-2025'].split())
    require_text(caiso, r'annual congestion rent and loss surpluses were \$485 million and \$143')
    require_text(caiso, r'Internal congestion rent increased from \$373 million in 2024 to \$459 million in 2025')
    require_text(caiso, r'Intertie congestion rent decreased from \$164 million in 2024 to \$26 million in 2025')
    for year, value in [(2024, 373+164), (2025, 485)]:
        rows.append(observed(f'caiso-da-{year}', 'day_ahead_congestion_usdm', 'CAISO', value, year, ['caiso-2025'], '§5.3, p.192', 'CAISO 하루전 내부·intertie congestion rent. 2024년은 공개된 내부 373 + intertie 164 백만 USD의 합. 손실 surplus 제외.'))
    ercot = ' '.join(texts['ercot-2025'].split())
    require_text(ercot, r'64 constraint-hours in 2025')
    rows.append(observed('ercot-violations-2025', 'rt_constraint_violation_hours', 'ERCOT', 64, 2025, ['ercot-2025'], 'Figure 38 설명, p.63', '급전모형에서 운전한도를 넘은 제약별 누적시간. Binding 전체시간과 다르다.'))
    miso = ' '.join(texts['miso-2025'].split())
    rt = require_text(miso, r'Total RT Value\s+\$([\d,]+) M\s+\$([\d,]+) M\s+\$([\d,]+) M')
    da = require_text(miso, r'DA Congestion Revenue\s+\$([\d,]+) M\s+\$([\d,]+) M\s+\$([\d,]+) M')
    for metric_id, match in [('real_time_congestion_value_usdm', rt), ('day_ahead_congestion_usdm', da)]:
        for year, raw in zip([2023, 2024, 2025], match.groups()):
            rows.append(observed(f'miso-{metric_id}-{year}', metric_id, 'MISO', int(raw.replace(',', '')), year, ['miso-2025'], 'Figure 26, p.51', '실시간 nominal value와 하루전 실제 정산수입을 별도 계열로 유지.'))
    nyiso = ' '.join(texts['nyiso-2025'].split())
    da = require_text(nyiso, r'DAM Cong\. Revenues \(1\)\s+\$306\s+\$638')
    for year, value in [(2024, 306), (2025, 638)]:
        rows.append(observed(f'nyiso-da-{year}', 'day_ahead_congestion_usdm', 'NYISO', value, year, ['nyiso-2025'], 'Figure A-39, p.A-45', 'Day-ahead congestion revenue; TCC 지급액·shortfall과 구분.'))
    spp = ' '.join(texts['spp-2025'].split())
    require_text(spp, r'5\.7% of intervals having no congestion in 2025 and 3\.5% having no congestion in 2024')
    require_text(spp, r'54\.2%, similar to the 2024 value of 53\.5%')
    for year, uncongested, breached in [(2024, 3.5, 53.5), (2025, 5.7, 54.2)]:
        rows.append(observed(f'spp-any-{year}', 'rt_any_constraint_interval_percent', 'SPP', round(100-uncongested, 1), year, ['spp-2025'], '§5 summary p.152; §5.1 p.169', f'100 − uncongested {uncongested}%. M2M flowgate 포함.'))
        rows.append(observed(f'spp-breach-{year}', 'rt_breached_interval_percent', 'SPP', breached, year, ['spp-2025'], '§5.1 p.169', '한 개 이상 제약이 breached인 실시간 구간 비율.'))
    isone = ' '.join(texts['isone-2025'].split())
    require_text(isone, r'averaging \$0\.39 per MWh over the past three years')
    row = observed('isone-da-intensity-2023-2025', 'isone_da_congestion_per_mwh_3year', 'ISO-NE', .39, 2025, ['isone-2025'], 'Figure 2 설명, pp.4–5', '2023–2025년 3년 평균. 연간 개별값으로 복제하지 않는다.')
    row.update(periodStart='2023-01-01', periodKind='multi_year')
    rows.append(row)
    return rows


def arc_query(collector, identifier, parameters, title):
    url = PG_BASE+'/3/query?'+urllib.parse.urlencode(parameters)
    raw, source = collector.get(identifier, url, title, 'Pacific Gas & Electric — GRIP')
    result = json.loads(raw)
    if 'error' in result:
        raise ValueError('ArcGIS public query failed: '+str(result['error']))
    return result, source


def parse_pge_groups(groups, zeros, source_ids, date, analysis_note):
    """Groups are unique feeders, no hidden weighting by line lengths or demand."""
    rows = []
    seen = set()
    for row in groups:
        feeder = row['FeederId']
        if feeder in seen:
            raise ValueError('Duplicate feeder group: '+str(feeder))
        seen.add(feeder)
        count = row['load_known_segments']
        if not isinstance(count, int) or count < 0 or count > row['segment_count']:
            raise ValueError('Invalid known-segment denominator')
        if not count:
            continue
        low, high = row['load_min_kw'], row['load_max_kw']
        if low is None or high is None or low < 0 or high < low or not feeder:
            raise ValueError('Invalid disclosed load ICA value')
        zero = zeros.get(feeder, 0)
        if zero < 0 or zero > count:
            raise ValueError('Invalid zero-segment numerator')
        for metric_id, value in [('pge_load_headroom_min_mw', low/1000), ('pge_load_headroom_max_mw', high/1000), ('pge_zero_load_headroom_percent', zero/count*100)]:
            entry = observed(f'pge-{feeder}-{metric_id}-{date}', metric_id, 'CAISO', value, date[:4], source_ids, f'LineDetail layer 3; FeederId={feeder}; Publish=1', analysis_note, assetId=feeder, sampleCount=count)
            entry.update(scope='PG&E 피더 '+feeder, utility='Pacific Gas & Electric', state='CA', periodStart=date, periodEnd=date, periodKind='snapshot')
            if metric_id.endswith('percent'):
                entry.update(numerator=zero, denominator=count)
            rows.append(entry)
    return rows


def pge(collector):
    collector.get('pge-grip-description', PG_BASE+'?f=json', 'PG&E GRIP — ICA/DIDF public feature service', 'Pacific Gas & Electric')
    guide_ids = pge_guide(collector)
    fields = [('min', 'LoadCapacity_kW', 'load_min_kw'), ('max', 'LoadCapacity_kW', 'load_max_kw'), ('count', 'LoadCapacity_kW', 'load_known_segments'), ('count', 'OBJECTID', 'segment_count')]
    stats = [dict(statisticType=kind, onStatisticField=field, outStatisticFieldName=name) for kind, field, name in fields]
    params = dict(where='Publish = 1', groupByFieldsForStatistics='FeederId', outStatistics=json.dumps(stats, separators=(',', ':')), returnGeometry='false', f='json', orderByFields='FeederId', resultRecordCount=2000)
    groups, source_ids, dates = [], ['pge-grip-description']+guide_ids, []
    for offset in range(0, 20000, 2000):
        page, source = arc_query(collector, f'pge-feeders-{offset}', params | dict(resultOffset=offset), 'PG&E load ICA — feeder min/max and disclosed segment counts')
        features = page.get('features')
        if not isinstance(features, list):
            raise ValueError('PG&E query missing features')
        groups.extend(feature['attributes'] for feature in features)
        source_ids.append(source['id'])
        dates.append(source['retrievedAt'][:10])
        if not page.get('exceededTransferLimit'):
            break
    else:
        raise ValueError('PG&E feeder pagination exceeded bound')
    zero_params = dict(where='Publish = 1 AND LoadCapacity_kW = 0', groupByFieldsForStatistics='FeederId', outStatistics=json.dumps([dict(statisticType='count', onStatisticField='OBJECTID', outStatisticFieldName='zero_segments')], separators=(',', ':')), returnGeometry='false', f='json', orderByFields='FeederId', resultRecordCount=2000)
    zeros = {}
    for offset in range(0, 20000, 2000):
        page, source = arc_query(collector, f'pge-zero-{offset}', zero_params | dict(resultOffset=offset), 'PG&E load ICA — zero headroom segments by feeder')
        for feature in page['features']:
            item = feature['attributes']
            if item['FeederId'] in zeros:
                raise ValueError('Duplicate zero-capacity feeder')
            zeros[item['FeederId']] = item['zero_segments']
        source_ids.append(source['id'])
        if not page.get('exceededTransferLimit'):
            break
    else:
        raise ValueError('PG&E zero pagination exceeded bound')
    page, source = arc_query(collector, 'pge-analysis-dates', dict(where='Publish = 1', outFields='lica_analysis_date', returnDistinctValues='true', returnGeometry='false', f='json'), 'PG&E load ICA — disclosed source analysis months')
    if page.get('exceededTransferLimit'):
        raise ValueError('Analysis-date query truncated')
    source_ids.append(source['id'])
    months = sorted({dt.datetime.strptime(feature['attributes']['lica_analysis_date'], '%b %Y').strftime('%Y-%m') for feature in page['features'] if feature['attributes']['lica_analysis_date']})
    note = f'공개 API 취득 스냅샷. 부하 ICA 분석월은 {months[0]}–{months[-1]}로 혼재하고 미공개도 있다. 취득일은 분석일이 아니다. 2025-06 이후 분석은 향후 1년의 계획 계통·승인 부하·공사를 반영한 모형이다.'
    page, source = arc_query(collector, 'pge-segment-count', dict(where='Publish = 1', returnCountOnly='true', f='json'), 'PG&E published ICA total line-segment count')
    source_ids.append(source['id'])
    if sum(row['segment_count'] for row in groups) != page['count']:
        raise ValueError('PG&E published segment count does not match complete grouped result')
    collector.pge_scope = f"PG&E 공개 {len(groups):,}개 피더·{page['count']:,}개 선로구간 중 부하 ICA 공개 {sum(bool(row['load_known_segments']) for row in groups):,}개 피더·{sum(row['load_known_segments'] for row in groups):,}개 구간. 미공개를 0으로 넣지 않는다."
    return parse_pge_groups(groups, zeros, source_ids, max(dates), note)


def pge_guide(collector):
    raw, _ = collector.get('pge-guide-index', PG_GUIDE_INDEX, 'PG&E GRIP public User Documentation download index', 'Pacific Gas & Electric')
    index = json.loads(raw)
    if 'error' in index or len(index.get('features', [])) != 1:
        raise ValueError('PG&E public documentation index changed')
    url = index['features'][0]['attributes']['userguideurl']
    if not url.startswith('https://'):
        raise ValueError('PG&E documentation requires HTTPS')
    bundle, _ = collector.get('pge-user-guide', url, 'PG&E GRIP User Documentation — PGE_GRIP_UserGuide.pdf', 'Pacific Gas & Electric', public_url=PG_GUIDE_INDEX,
                              retrieval_note='Public index features[0].attributes.userguideurl → documentation ZIP → PGE_GRIP_UserGuide.pdf, pp.6–8. SHA-256 refers to the downloaded ZIP. Temporary signed download URL is intentionally not published.')
    guide = pdf_text(zipfile.ZipFile(io.BytesIO(bundle)).read('PGE_GRIP_UserGuide.pdf'))
    text = ' '.join(guide.split())
    require_text(text, r'Amount of load that can be installed at that location without any thermal or voltage violations')
    require_text(text, r'system-as-\s*planned for the future one-year time span')
    return ['pge-guide-index', 'pge-user-guide']


def valid_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def parse_eia_workbook(body, year, source_id):
    import openpyxl
    archive = zipfile.ZipFile(io.BytesIO(body))
    workbook = openpyxl.load_workbook(io.BytesIO(archive.read(f'Reliability_{year}.xlsx')), read_only=True, data_only=True)
    rows = []
    expected = ['Data Year', 'Utility Number', 'Utility Name', 'State', 'Ownership']
    utility_rows = list(workbook['Reliability_States'].values)
    if list(utility_rows[2][:5]) != expected or utility_rows[2][14] != 'Number of Customers':
        raise ValueError('EIA reliability columns changed')
    for excel_row, row in enumerate(utility_rows[3:], start=4):
        if row[0] != year or row[3] not in CONTIGUOUS or not valid_number(row[14]) or row[14] <= 0:
            continue
        for suffix, column in [('saidi_all', 5), ('saifi_all', 6), ('saidi_no_med', 8), ('saifi_no_med', 9)]:
            if not valid_number(row[column]):
                continue
            entry = observed(f'eia-{year}-{row[1]}-{row[3]}-{suffix}', 'eia_ieee_'+suffix, 'State-level', float(row[column]), year, [source_id], f'Reliability_{year}.xlsx / Reliability_States row {excel_row}; IEEE column {column+1}', '유틸리티·주 보고 범위. IEEE 기준 신고값만 포함하며 주 경계를 ISO 경계로 바꾸지 않는다.', customerCount=row[14])
            entry.update(scope='유틸리티·주', utility=str(row[2]), state=row[3])
            rows.append(entry)
    state_rows = list(workbook['State Totals'].values)
    if state_rows[2][2] != 'Number of Customers' or state_rows[2][3] != 'SAIDI (minutes per year)':
        raise ValueError('EIA state total columns changed')
    for excel_row, row in enumerate(state_rows[3:], start=4):
        if row[0] != year or row[1] not in CONTIGUOUS or not valid_number(row[2]) or row[2] <= 0:
            continue
        for suffix, column in [('saidi_all', 3), ('saifi_all', 4), ('saidi_no_med', 6), ('saifi_no_med', 7)]:
            if not valid_number(row[column]):
                continue
            entry = observed(f'eia-state-{year}-{row[1]}-{suffix}', 'eia_ieee_'+suffix, 'State-level', float(row[column]), year, [source_id], f'Reliability_{year}.xlsx / State Totals row {excel_row}; IEEE column {column+1}', 'EIA 발표 IEEE 주 집계. 고객 수는 표의 IEEE 전체 보고 고객으로 지표별 유효 분모와 다를 수 있고 유틸리티 행의 합과 일치도 보장되지 않는다. 이 고객 수로 주·전국 평균을 재가중하지 않는다. 유틸리티 행과 겹치므로 합산하지 않는다.', customerCount=row[2])
            entry.update(scope='주 집계 · IEEE 보고 고객', state=row[1])
            rows.append(entry)
    workbook.close()
    return rows


def eia(collector):
    rows = []
    for year in [2024, 2025]:
        base = 'https://www.eia.gov/electricity/data/eia861/'
        url = base + ('archive/' if year == 2024 else '') + f'zip/f861{year}.zip'
        key = f'eia861-{year}'
        raw, _ = collector.get(key, url, f'EIA-861 {year} final — Reliability', 'U.S. Energy Information Administration', f'{year}-12-31')
        rows.extend(parse_eia_workbook(raw, year, key))
    return rows


def validate(data):
    metrics = {row['id']: row for row in data['metrics']}
    sources = {row['id']: row for row in data['sources']}
    seen = set()
    for source in sources.values():
        if not re.fullmatch('[a-f0-9]{64}', source['sha256']) or not source['url'].startswith('https://'):
            raise ValueError('Invalid source provenance')
        dt.datetime.fromisoformat(source['retrievedAt'].replace('Z', '+00:00'))
    for row in data['observations']:
        if row['id'] in seen:
            raise ValueError('Duplicate observation '+row['id'])
        seen.add(row['id'])
        metric_ = metrics[row['metricId']]
        if not valid_number(row['value']) or not row['sourceIds'] or any(key not in sources for key in row['sourceIds']):
            raise ValueError('Invalid observation '+row['id'])
        if row['periodStart'] > row['periodEnd']:
            raise ValueError('Reversed dates')
        if metric_['unit'] == '%' and row['value'] > 100:
            raise ValueError('Invalid percent')
        if metric_['kind'] == 'reliability' and row.get('customerCount', 0) <= 0:
            raise ValueError('Missing reliability denominator')
    if len(sources) != len(data['sources']) or len(metrics) != len(data['metrics']):
        raise ValueError('Duplicate source or metric')
    return data


def build(collector):
    observations = reports(collector) + pge(collector) + eia(collector)
    coverage = []
    for region in REGIONS:
        keys = [key for key, value in REPORTS.items() if value[0] == region]
        coverage.append(dict(region=region, part='transmission', status='observed' if keys else 'missing', sourceIds=keys,
                             detail='공식 시장감시 보고서의 확보한 연간·다년 지표. 실시간 선로별 측정 및 동일 정의의 전국 혼잡가격 격차는 미확보.' if keys else '비ISO 권역의 공통 정의 송전혼잡 수치 미확보. 자료 없음을 혼잡 0으로 처리하지 않는다.'))
        coverage.append(dict(region=region, part='distribution', status='observed' if region == 'CAISO' else 'reference_only', sourceIds=['pge-grip-description', 'eia861-2025'] if region == 'CAISO' else ['eia861-2025'],
                             detail=collector.pge_scope+' CAISO 전체 배전망을 대표하지 않는다. EIA 신뢰도는 별도 주·회사 범위.' if region == 'CAISO' else 'EIA 주·회사 신뢰도 자료는 확보했지만 이 ISO/비ISO 권역 전체의 배전 수용여유·실측 과부하율은 미확보. 신뢰도는 혼잡 대체값이 아니다.'))
    data = dict(schemaVersion=1, generatedAt=max(source['retrievedAt'] for source in collector.sources), sources=collector.sources, metrics=METRICS,
                observations=observations, coverage=coverage, notes=[
                    '절차상 병목점수와 송배전 제약 관측은 별도다. 이 자료로 인허가 단계나 개별 프로젝트 점수를 변경하지 않는다.',
                    '전국 공통 송배전 제약지수는 아직 산출하지 않는다. 서로 다른 정의·기간·분모의 비용, 제약시간, ICA, 신뢰도를 더하지 않는다.',
                    '송전 자료는 공식 연간 시장보고서다. 선로 운전한도 이용률, 동시점 노드별 혼잡가격 P90−P10, 송전 원인만 분리한 출력제한은 아직 확보하지 못했다.',
                    '배전 ICA는 모델 기반 접속 검토 참고이며 실측 혼잡률이 아니다. PG&E 한 유틸리티의 공개 구간을 CAISO나 전국의 배전망으로 확대하지 않는다.',
                    'EIA 신뢰도는 IEEE 보고 기관의 본토 48주·DC 범위만 제공한다. 주·유틸리티 행은 서로 겹치고 고객 수는 접속신청 프로젝트 수가 아니다.',
                    '공식 보고서는 검토한 연도와 표에 고정되어 있다. 재취득 명령은 지원하지만 다음 연도 보고서의 자동 발굴·해석을 주장하지 않는다.',
                ])
    return validate(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--refresh', action='store_true')
    mode.add_argument('--rebuild', action='store_true')
    mode.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if args.check:
        data = validate(json.loads(OUTPUT.read_text()))
    else:
        data = build(Collector(refresh=args.refresh))
        # Publish atomically only after every source and denominator validates.
        temporary = OUTPUT.with_suffix('.tmp')
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')
        temporary.replace(OUTPUT)
    print(json.dumps(dict(observations=len(data['observations']), sources=len(data['sources']), metrics=len(data['metrics']), mode='check' if args.check else 'build')))


if __name__ == '__main__':
    main()
