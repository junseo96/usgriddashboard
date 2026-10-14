/** Provider-derived aggregates stay separate from independently reviewed history. */
import { validateLoadApiDataset, type LoadApiDataset, type LoadApiRecord } from './load-api.ts';
import type { HistoricalPoint, HistoricalSeries } from './history.ts';

export const LOAD_API_HISTORY_ID = 'kardashev-ercot-large-load-total';

const monthIndex = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
const timestamp = (value: string | null | undefined) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
/** Report vintage first, then the provider's revision, then our first receipt. */
function compareVintages(a: LoadApiRecord, b: LoadApiRecord): number {
  return a.reportDate.localeCompare(b.reportDate)
    || timestamp(a.providerExtractedAt) - timestamp(b.providerExtractedAt)
    || timestamp(a.fetchedAt) - timestamp(b.fetchedAt)
    || b.id.localeCompare(a.id);
}

export function buildLoadApiHistoricalSeries(dataset: LoadApiDataset): HistoricalSeries[] {
  validateLoadApiDataset(dataset);
  const latest = new Map<string, LoadApiRecord>();
  for (const record of dataset.records) {
    const previous = latest.get(record.snapshotMonth);
    if (!previous || compareVintages(record, previous) > 0) latest.set(record.snapshotMonth, record);
  }
  const selected = [...latest.values()].toSorted((a, b) => a.snapshotMonth.localeCompare(b.snapshotMonth));
  if (!selected.length) return [];
  const points: HistoricalPoint[] = selected.map((record, index) => {
    const previous = selected[index - 1];
    const gap = previous !== undefined && monthIndex(record.snapshotMonth) - monthIndex(previous.snapshotMonth) !== 1;
    const reportChanged = previous !== undefined && (previous.reportDate !== record.reportDate || previous.sourceUrl !== record.sourceUrl);
    const sameMonthVintages = dataset.records.filter(row => row.snapshotMonth === record.snapshotMonth);
    const sourceMonth = record.snapshotMonth.slice(0, 7);
    const restated = record.trailing12mo?.[sourceMonth];
    return {
      id: `${LOAD_API_HISTORY_ID}:${sourceMonth}:${record.id}`,
      date: record.snapshotMonth, datePrecision: 'month', dateBasis: 'source_as_of',
      sourceAsOf: sourceMonth, publishedAt: record.reportDate,
      breakBefore: gap || reportChanged,
      value: record.totalMw, qualifier: 'exact', projectCount: null, ratedCount: null, unknownCount: null,
      ratingModelVersion: null,
      source: {
        name: 'Kardashev API · ERCOT 공개 보고서 추출값 · 원문 미전수검증',
        url: record.receipt.url, originalUrl: record.sourceUrl,
        retrievedAt: new Date(record.receipt.fetchedAt).toISOString(), sha256: record.receipt.sha256,
      },
      notes: [
        'ERCOT의 데이터센터·암호화폐·산업시설 등을 포함하는 대형 부하 추적 총량입니다. 개별 프로젝트 원장이나 데이터센터 전용 용량이 아닙니다.',
        '제공자가 원문에서 추출한 값이며 전체 보고서를 독립적으로 검증한 계열이 아닙니다. 값의 exact 표시는 API에 실린 숫자를 그대로 보존했다는 뜻으로 원문 검증 완료를 뜻하지 않습니다.',
        `API의 snapshot_month ${record.snapshotMonth}는 월 정렬 기준입니다. 실제 접속신청일·월말 기준일로 해석하지 않으며 보고일 ${record.reportDate}와 구분합니다.`,
        `이 달의 보존된 API 관측 ${sameMonthVintages.length}개 중 최신 보고일·제공자 추출시각 순으로 선택했습니다. 과거 관측은 load-api-observations.json에 그대로 보존합니다.`,
        '각 월 보고서의 total_mw만 사용합니다. 후속 보고서의 trailing_12mo 재작성 값은 원자료에 보존하지만 이 계열에 섞지 않습니다. 서로 다른 보고서의 증감을 자동 계산하지 않습니다.',
        `원문: ${record.sourceUrl}`,
        `SHA-256은 ERCOT 원문이 아니라 실제 취득한 API 응답 바이트의 검증값입니다. 정규화 레코드 내용의 JSON 해시는 별도 payloadSha256=${record.payloadSha256}입니다.`,
        ...(gap ? ['확보하지 못한 중간 월은 보간하거나 0으로 채우지 않고 차트 선을 끊었습니다.'] : []),
        ...(reportChanged ? ['직전 시점과 보고서 판본이 달라 기준일·집계 범위의 변경 가능성을 보존하기 위해 차트 선을 끊었습니다.'] : []),
        ...(restated !== null && restated !== undefined && restated !== record.totalMw
          ? [`같은 응답의 trailing_12mo에는 이 달이 ${restated} MW로 기록되어 total_mw ${record.totalMw} MW와 다릅니다. 두 값을 합치거나 대체하지 않았습니다.`] : []),
        ...record.qualityIssues.map(issue => `제공자 보고서 정합성 참고 · ${issue.detail}`),
        '기존 공식 원문 검토 계열·개별 프로젝트·MW 가중 병목점수와 분리합니다. 이 집계에서 프로젝트 수·개별 진행단계·병목점수를 생성하지 않습니다.',
      ],
    };
  });
  return [{
    id: LOAD_API_HISTORY_ID,
    name: 'Kardashev API · ERCOT 대형 수용가 추적 총량 · 원문 미전수검증',
    region: 'ERCOT', projectTypes: ['load'], metric: 'load_requests', unit: 'MW',
    scope: 'ERCOT 공개 대형 부하 보고서의 전체 추적 총량. 데이터센터 외 부하와 운영·통전 승인 등이 포함될 수 있으며 활성 신청 전수 또는 개별 고객 원장이 아닙니다.',
    description: '정기 API 수집으로 보존한 각 월 보고서의 총량입니다. 같은 월의 새 보고서·제공자 수정은 최신 값을 선택하되 이전 판본도 원자료에 보존합니다. 공식 원문을 검토한 기존 ERCOT 계열과 별도로 표시합니다.',
    comparability: '보고서마다 기준일·분류·추적 대상이 바뀔 수 있어 보고서 판본이 바뀌는 지점과 누락 월에서는 선을 끊습니다. 보고서 속 과거 재작성 값(trailing_12mo)을 이 계열에 합치지 않으며, 단순 전월 증감이나 병목점수를 계산하지 않습니다.',
    points,
  }];
}
