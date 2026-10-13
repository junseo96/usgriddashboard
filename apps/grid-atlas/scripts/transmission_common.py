"""Shared operational congestion math. All intervals are explicit UTC [start,end).

Adapters export collect(start_date, end_date, cache_dir, refresh=False) -> fragment.
Dates are inclusive requested operating dates, not claims of successful coverage.
Fragments: region, sources, priceIntervals, constraintIntervals, constraintWindows,
loadIntervals, utilizationIntervals, curtailmentIntervals, coverage, notes.
Sources: id,title,publisher,url,retrievedAt,sha256, optional sourceAsOf.
Price intervals are HOURLY node MCC means -> same-hour linear P90-P10, produced
by hourly_price_spreads; never mean(5-minute spatial spread) mislabeled hourly.
Constraint rows: region,start,end,assetId,contingency,binding(bool),sourceIds;
windows: region,start,end,sourceIds (only proven complete event reports).
Load rows: region,start,end,mw,sourceIds (actual interval averages only).
Utilization: region,start,end,assetId,contingency,flowMw,limitMw,value(PERCENT),sourceIds,
  directionalBasis (directed flow/limit matched to the SAME modeled constraint).
Curtailment: region,start,end,mwh,reason,sourceIds (transmission cause only).
Coverage: region,metric(price_spread|binding_duration|utilization|curtailment|load),
  status(observed|partial|unavailable|auth_required|access_blocked),reason,sourceUrls.
Never put inferred no-event intervals or missing values into the fragments.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
import math

UTC = timezone.utc


def stamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00')) if isinstance(value, str) else value
    if result.tzinfo is None:
        raise ValueError('Operational intervals require an explicit UTC offset')
    return result.astimezone(UTC)


def iso(value):
    return stamp(value).isoformat(timespec='seconds').replace('+00:00', 'Z')


def number(value):
    if value is None or isinstance(value, bool):
        raise ValueError('Missing numeric observation')
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Non-finite observation')
    return result


def quantile(values, q):
    values = sorted(number(value) for value in values)
    if not values or not 0 <= q <= 1:
        raise ValueError('Invalid quantile inputs')
    index = (len(values) - 1) * q
    lower, upper = math.floor(index), math.ceil(index)
    return values[lower] + (values[upper] - values[lower]) * (index - lower)


def hourly_price_spreads(rows, region, market, population, population_label=None):
    """Rows: start,end,node,value(signed MCC USD/MWh),sourceIds.

    Every included node must have a complete, nonoverlapping 60-minute hour.
    Identical duplicate observations collapse; conflicts/overlap reject.
    Inputs can be native hourly or subhourly interval-average MCC. Instantaneous
    dispatch snapshots need an explicit, source-supported interval first.
    Missing nodes stay missing, with observed and candidate node counts exposed.
    """
    groups = defaultdict(lambda: defaultdict(list))
    unique = {}
    for row in rows:
        start, end = stamp(row['start']), stamp(row['end'])
        value = number(row['value'])
        if end <= start or end - start > timedelta(hours=1):
            raise ValueError('Invalid price interval')
        key = (row['node'], start, end)
        if key in unique:
            if unique[key] != value:
                raise ValueError('Conflicting node MCC at the same interval')
            continue
        unique[key] = value
        cursor = start
        while cursor < end:
            hour = cursor.replace(minute=0, second=0, microsecond=0)
            finish = min(end, hour + timedelta(hours=1))
            groups[hour][str(row['node'])].append((cursor, finish, value, row['sourceIds']))
            cursor = finish
    result = []
    for hour, nodes in sorted(groups.items()):
        node_values, sources = [], set()
        for node, intervals in nodes.items():
            intervals.sort(key=lambda item: item[0])
            cursor, integral, seconds = hour, 0.0, 0.0
            valid = True
            node_sources = set()
            for start, end, value, refs in intervals:
                if start < cursor:
                    raise ValueError('Overlapping node price intervals')
                if start != cursor:
                    valid = False
                duration = (end - start).total_seconds()
                seconds += duration
                integral += value * duration
                node_sources.update(refs)
                cursor = end
            if valid and seconds == 3600 and cursor == hour + timedelta(hours=1):
                node_values.append(integral / seconds)
                sources.update(node_sources)
        if len(node_values) < 2:
            continue
        p10, p90 = quantile(node_values, .1), quantile(node_values, .9)
        result.append(dict(region=region, market=market, population=population,
                           populationLabel=population_label or population,
                           start=iso(hour), end=iso(hour + timedelta(hours=1)),
                           p10=p10, p90=p90, value=p90-p10,
                           nodeCount=len(node_values), candidateNodeCount=len(nodes),
                           resolutionMinutes=60, quantileMethod='linear-type7',
                           sourceIds=sorted(sources)))
    return result


def empty_fragment(region):
    return dict(region=region, sources=[], priceIntervals=[], constraintIntervals=[],
                constraintWindows=[], loadIntervals=[], utilizationIntervals=[],
                curtailmentIntervals=[], coverage=[], notes=[])
