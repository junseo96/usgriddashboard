/** Assemble reviewed historical evidence without creating database observations. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calendarDayKst } from '../shared/time.ts';
import { validateHistoricalDataset, type HistoricalDataset, type HistoricalPoint, type HistoricalSeries } from '../shared/history.ts';
import { STAGE_ESTIMATE_VERSION } from '../shared/stage-estimate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = (name: string) => resolve(root, 'data', name);
type Source = HistoricalPoint['source'];
interface Summary {
  region: string; type: 'all' | 'generation' | 'storage' | 'load';
  eligibleCount: number; ratedCount: number; unknownCount: number; ratingMean: number | null;
  generationMw?: number | null; storageMw?: number | null; loadMw?: number | null;
  capacityUnknownCount: number;
}
interface Vintage {
  id?: string; year?: number; sourceAsOf: string | null; publishedAt: string | null;
  dateBasis?: HistoricalPoint['dateBasis']; archiveCapturedAt?: string; observedAt?: string;
  source: Source; notes: string | string[]; summaries: Summary[];
  capacityDefinition?: string; capacityDefinitionLabel?: string; capacityBreakBefore?: boolean;
  provenance?: { excludedRowCount?: number };
}
interface Vintages { schemaVersion: 1; generatedAt: string; modelVersion: string; vintages: Vintage[]; }
const TYPE = { all: '발전·저장', generation: '발전', storage: '저장', load: '수용가' };
const METRIC = { bottleneck_score: '평균 병목점수', queue_count: '활성 신청 수', queue_capacity: '공개 신청 용량' };
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const notes = (value: string | string[]) => typeof value === 'string' ? [value] : value;
function source(value: Source): Source {
  // The acquisition receipts retain original timestamp precision; the common
  // browser schema uses canonical UTC milliseconds, not a new acquisition time.
  return { ...value, retrievedAt: new Date(value.retrievedAt).toISOString() };
}

export function assembleHistoricalData(
  generation: Vintages, nyiso: Vintages, reviewed: { series: HistoricalSeries[] }, generatedAt: string,
): HistoricalDataset {
  for (const dataset of [generation, nyiso]) {
    if (dataset.schemaVersion !== 1 || dataset.modelVersion !== STAGE_ESTIMATE_VERSION || !dataset.vintages.length) {
      throw new Error('Historical vintages require the reviewed stage model and real source observations.');
    }
  }
  const series = new Map<string, HistoricalSeries>();
  const add = (definition: Omit<HistoricalSeries, 'points'>, point: HistoricalPoint) => {
    const entry = series.get(definition.id) ?? { ...definition, points: [] };
    entry.points.push(point); series.set(entry.id, entry);
  };
  for (const vintage of generation.vintages) {
    if (!vintage.sourceAsOf || !/^\d{4}-12-31$/.test(vintage.sourceAsOf)) throw new Error('An official annual cutoff is required.');
    for (const summary of vintage.summaries) {
      if (summary.type === 'load') throw new Error('Generation archive cannot contain customer load.');
      const region = summary.region === 'all' ? '미국 본토' : summary.region;
      const metrics = summary.type === 'all' ? ['bottleneck_score', 'queue_count'] as const
        : ['bottleneck_score', 'queue_count', 'queue_capacity'] as const;
      for (const metric of metrics) {
        const id = `lbnl-${slug(summary.region)}-${summary.type}-${metric.replaceAll('_', '-')}`;
        const value = metric === 'bottleneck_score' ? summary.ratingMean : metric === 'queue_count'
          ? summary.eligibleCount : summary.type === 'generation' ? summary.generationMw : summary.storageMw;
        add({ id, name: `LBNL · ${region} ${TYPE[summary.type]} ${METRIC[metric]}`, region,
          projectTypes: summary.type === 'all' ? ['generation', 'storage'] : [summary.type], metric,
          unit: metric === 'bottleneck_score' ? 'score' : metric === 'queue_count' ? 'projects' : 'MW',
          scope: `${region}의 해당 연도 공개 활성 발전·저장 접속 원장. 비본토·철회·운영·모호한 식별자/유형은 제외하며 전국 물리 프로젝트 전수가 아닙니다.`,
          description: '2020–2025년 공식 연말 원장을 각각 읽은 과거 값입니다. 점수는 당시 원문 단계에 현재의 동일 배점 모형을 적용한 추정입니다. 발전·저장 용량은 합산하지 않으며 복합 신청은 전체 건수에서 한 번 셉니다.',
          comparability: '매년 사업이 진입·완료·철회하고 조사 범위와 단계 공개율도 달라집니다. 특히 2020–2021년은 세부 단계가 많이 미공개입니다. 연도별 평가 분모·공개율을 함께 확인해야 하며 동일 사업군의 진행 속도나 순수 병목 개선을 뜻하지 않습니다.',
        }, { id: `${id}-${vintage.year}`, date: vintage.sourceAsOf, datePrecision: 'day', dateBasis: 'source_as_of',
          sourceAsOf: vintage.sourceAsOf, publishedAt: vintage.publishedAt, value: value ?? null, qualifier: 'exact',
          projectCount: summary.eligibleCount, ratedCount: summary.ratedCount, unknownCount: summary.unknownCount,
          ratingModelVersion: metric === 'bottleneck_score' ? STAGE_ESTIMATE_VERSION : null,
          source: source(vintage.source), notes: [...notes(vintage.notes),
            `선택 범위의 용량 미공개 또는 일부 미공개 신청 ${summary.capacityUnknownCount}건.`,
            `이 연도 원본 전체에서 집계 제외한 행 ${vintage.provenance?.excludedRowCount ?? 0}건. 제외 상세는 history-generation.json에 보존합니다.`],
        });
      }
    }
  }
  for (const vintage of nyiso.vintages) {
    const stamp = vintage.archiveCapturedAt ?? vintage.observedAt;
    if (!stamp || !['archive_capture', 'observation'].includes(vintage.dateBasis ?? '')) throw new Error('NYISO requires a real archive capture or observation timestamp.');
    const date = calendarDayKst(stamp);
    for (const summary of vintage.summaries) {
      if (summary.region !== 'NYISO' || summary.type !== 'load') throw new Error('NYISO history must preserve its customer register scope.');
      for (const metric of ['bottleneck_score', 'queue_count', 'queue_capacity'] as const) {
        const id = `nyiso-load-${metric.replaceAll('_', '-')}`;
        add({ id, name: `NYISO · 수용가 ${METRIC[metric]}`, region: 'NYISO', projectTypes: ['load'], metric,
          unit: metric === 'bottleneck_score' ? 'score' : metric === 'queue_count' ? 'projects' : 'MW',
          scope: 'NYISO 공개 원장의 본토 활성 Load 신청. 데이터센터 외 수용가도 포함하며 미국 전체 수용가 또는 뉴욕의 배전·소매 접속 전수가 아닙니다.',
          description: '2023–2026년 NYISO 공식 원장의 실제 웹 보관본 4개와 2026년 10월 8일 실제 수집 원장을 비교합니다. 현재 원장의 신청일로 과거 상태를 역산하지 않습니다.',
          comparability: metric === 'queue_capacity'
            ? '과거 원장의 SP(여름) MW와 최신 Load Projects의 Peak MW는 정의가 다를 수 있어 마지막 용량 구간은 선을 끊습니다. 보관본 포착일·수집일은 전체 원장의 기준일이 아닙니다.'
            : '당시 공개된 활성 신청 집단의 값으로 동일 코호트가 아닙니다. 과거 Type/Fuel=L과 최신 Load Projects 시트의 공개 범위를 구분하며, 단계 점수는 현재 모형으로 재평가한 추정입니다. 보관본 포착일·수집일은 전체 원장 기준일이 아닙니다.',
        }, { id: `${id}-${vintage.id}`, date, datePrecision: 'day', dateBasis: vintage.dateBasis!,
          sourceAsOf: vintage.sourceAsOf, publishedAt: vintage.publishedAt,
          archiveCapturedAt: vintage.archiveCapturedAt ?? null, observedAt: vintage.observedAt ?? null,
          breakBefore: metric === 'queue_capacity' && vintage.capacityBreakBefore === true,
          value: metric === 'bottleneck_score' ? summary.ratingMean : metric === 'queue_count' ? summary.eligibleCount : summary.loadMw ?? null,
          qualifier: 'exact', projectCount: summary.eligibleCount, ratedCount: summary.ratedCount, unknownCount: summary.unknownCount,
          ratingModelVersion: metric === 'bottleneck_score' ? STAGE_ESTIMATE_VERSION : null,
          source: source(vintage.source), notes: [...notes(vintage.notes), `용량 정의: ${vintage.capacityDefinitionLabel ?? vintage.capacityDefinition}.`],
        });
      }
    }
  }
  for (const item of reviewed.series) {
    if (series.has(item.id)) throw new Error(`Duplicate reviewed series ${item.id}`);
    series.set(item.id, { ...item, points: item.points.map(point => ({ ...point, source: source(point.source) })) });
  }
  const entries = [...series.values()].map(item => ({ ...item, points: item.points.toSorted((a, b) => a.date.localeCompare(b.date)) }));
  const dates = entries.flatMap(item => item.points.map(point => point.date)).sort();
  const dataset: HistoricalDataset = { schemaVersion: 1, generatedAt,
    coverageStart: dates[0], coverageEnd: dates.at(-1)!, series: entries,
    limitations: [
      '2020년 이후 확보한 공식 원장·발표·웹 보관 자료입니다. 시작점은 자료 확보 범위이며 데이터센터 접속요청이 처음 발생한 날짜를 뜻하지 않습니다.',
      '전국 데이터센터 접속요청 전수·월별 개별 상태는 공개되지 않았습니다. 사업자별 요청·추적 총량·계약을 서로 더하거나 같은 모집단으로 연결하지 않습니다.',
      '과거 단계 점수는 당시 원문 상태에 현재 모형을 적용한 추정입니다. 실제 허가·공정률이나 당시 공식 발표 점수가 아니며 관측 공백은 보간하지 않습니다.',
      '원자료 기준일, 발행일, 웹 보관본 포착일, 실제 취득일은 서로 다릅니다. 월·분기 자료의 차트 날짜는 정렬 기준이며 정확한 관측일이 아닙니다.',
      '과거 자료는 검토해 추가한 별도 자료입니다. 현재 앱 DB에 가짜 과거 관측을 저장하지 않았으며 반복 사이트 빌드가 새로운 프로젝트 관측을 뜻하지 않습니다.',
    ],
  };
  validateHistoricalDataset(dataset);
  return dataset;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.slice(2).includes('--check');
  const [generation, nyiso, reviewed] = await Promise.all(['history-generation.json', 'history-nyiso.json', 'history-load-reviewed.json']
    .map(async name => JSON.parse(await readFile(file(name), 'utf8'))));
  const output = file('history.json');
  const existing = check ? JSON.parse(await readFile(output, 'utf8')) as HistoricalDataset : null;
  const dataset = assembleHistoricalData(generation, nyiso, reviewed, existing?.generatedAt ?? new Date().toISOString());
  if (check) {
    if (JSON.stringify(dataset) !== JSON.stringify(existing)) throw new Error('Published historical dataset differs from reviewed inputs.');
  } else await writeFile(output, JSON.stringify(dataset, null, 2) + '\n');
  console.log(JSON.stringify({ checked: check, series: dataset.series.length, points: dataset.series.reduce((sum, item) => sum + item.points.length, 0), coverageStart: dataset.coverageStart, coverageEnd: dataset.coverageEnd }));
}
