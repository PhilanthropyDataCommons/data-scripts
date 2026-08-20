import { describe, expect, it } from '@jest/globals';
import {
  type EndpointMetric,
  csvField,
  formatCount,
  renderCsv,
  renderJson,
  renderTable,
  resolveFullCount,
  sortMetrics,
  summarize,
} from './getMetrics.js';

// A small, representative set of metrics: two successful reads and one that
// failed authentication (so `count` is null and there is a note).
const sampleMetrics: EndpointMetric[] = [
  { path: 'baseFields', label: 'Base Fields', count: 282, status: 'ok', note: '' },
  { path: 'changemakers', label: 'Changemakers', count: 17, status: 'ok', note: '' },
  {
    path: 'proposals',
    label: 'Proposals',
    count: null,
    status: 'unauthorized',
    note: 'Authentication required (no valid token supplied)',
  },
];

const BASE_URL = 'https://api.philanthropydatacommons.org/';

describe('csvField', () => {
  it('leaves a plain value unquoted', () => {
    expect(csvField('Base Fields')).toBe('Base Fields');
  });

  it('quotes a value containing a comma', () => {
    expect(csvField('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles an embedded double quote', () => {
    expect(csvField('a"b')).toBe('"a""b"');
  });

  it('quotes a value containing a newline', () => {
    expect(csvField('a\nb')).toBe('"a\nb"');
  });

  it('leaves an empty string unquoted', () => {
    expect(csvField('')).toBe('');
  });
});

describe('formatCount', () => {
  it('formats a number with thousands separators', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
  });

  it('formats a small number without separators', () => {
    expect(formatCount(17)).toBe('17');
  });

  it('renders null as an em dash', () => {
    expect(formatCount(null)).toBe('—');
  });

  it('renders zero as "0", not an em dash', () => {
    expect(formatCount(0)).toBe('0');
  });
});

describe('summarize', () => {
  it('counts ok / failed endpoints and sums the item totals', () => {
    expect(summarize(sampleMetrics)).toStrictEqual({
      endpointCount: 3,
      okCount: 2,
      failedCount: 1,
      itemTotal: 299,
    });
  });

  it('reports zeroes for an empty metrics list', () => {
    expect(summarize([])).toStrictEqual({
      endpointCount: 0,
      okCount: 0,
      failedCount: 0,
      itemTotal: 0,
    });
  });

  it('ignores the count of non-ok endpoints in the item total', () => {
    const metrics: EndpointMetric[] = [
      { path: 'baseFields', label: 'Base Fields', count: 10, status: 'ok', note: '' },
      { path: 'files', label: 'Files', count: null, status: 'forbidden', note: 'nope' },
    ];
    expect(summarize(metrics).itemTotal).toBe(10);
  });
});

describe('sortMetrics', () => {
  const unsorted: EndpointMetric[] = [
    { path: 'proposals', label: 'Proposals', count: 3, status: 'ok', note: '' },
    { path: 'baseFields', label: 'Base Fields', count: 282, status: 'ok', note: '' },
    { path: 'applicationForms', label: 'Application Forms', count: 11, status: 'ok', note: '' },
  ];

  it('orders metrics alphabetically by path', () => {
    expect(sortMetrics(unsorted).map((m) => m.path)).toStrictEqual(['applicationForms', 'baseFields', 'proposals']);
  });

  it('does not mutate the input array', () => {
    const before = unsorted.map((m) => m.path);
    sortMetrics(unsorted);
    expect(unsorted.map((m) => m.path)).toStrictEqual(before);
  });

  it('returns an empty array unchanged', () => {
    expect(sortMetrics([])).toStrictEqual([]);
  });
});

describe('resolveFullCount', () => {
  it('errors when both total and entries are absent', () => {
    expect(resolveFullCount(null, null)).toStrictEqual({
      count: null,
      status: 'error',
      note: 'Response had neither a `total` nor an `entries` array',
    });
  });

  it('counts entries when total is absent (the applicationForms case)', () => {
    // total missing, 11 entries fetched → reports 11, not 1.
    expect(resolveFullCount(null, 11)).toStrictEqual({
      count: 11,
      status: 'ok',
      note: 'No numeric `total` in response; counted the entries returned',
    });
  });

  it('prefers a larger entries count over a short/page-scoped total', () => {
    // total reported as 1 but 11 entries were actually returned → 11 wins.
    expect(resolveFullCount(1, 11)).toStrictEqual({ count: 11, status: 'ok', note: '' });
  });

  it('prefers a larger total when entries were truncated below it', () => {
    expect(resolveFullCount(500, 200)).toStrictEqual({ count: 500, status: 'ok', note: '' });
  });

  it('uses total as-is when it matches the entries returned', () => {
    expect(resolveFullCount(282, 282)).toStrictEqual({ count: 282, status: 'ok', note: '' });
  });

  it('reports zero for a genuinely empty collection', () => {
    expect(resolveFullCount(0, 0)).toStrictEqual({ count: 0, status: 'ok', note: '' });
  });

  it('flags the count as a floor when entries hit the fetch ceiling', () => {
    const result = resolveFullCount(null, 1_000_000);
    expect(result.count).toBe(1_000_000);
    expect(result.status).toBe('ok');
    expect(result.note).toMatch(/at least 1,000,000 items/v);
  });
});

describe('renderCsv', () => {
  it('starts with a comment line naming the environment', () => {
    expect(renderCsv(sampleMetrics, BASE_URL).split('\n')[0]).toBe(`# PDC API base URL: ${BASE_URL}`);
  });

  it('puts the CSV header row directly after the comment line', () => {
    expect(renderCsv(sampleMetrics, BASE_URL).split('\n')[1]).toBe('endpoint,label,count,status,note');
  });

  it('renders an ok row with its count and an empty note', () => {
    const lines = renderCsv(sampleMetrics, BASE_URL).split('\n');
    expect(lines[2]).toBe('baseFields,Base Fields,282,ok,');
  });

  it('renders a failed row with an empty count field and its note', () => {
    const lines = renderCsv(sampleMetrics, BASE_URL).split('\n');
    expect(lines[4]).toBe('proposals,Proposals,,unauthorized,Authentication required (no valid token supplied)');
  });

  it('quotes a note that contains a comma', () => {
    const metrics: EndpointMetric[] = [
      { path: 'files', label: 'Files', count: null, status: 'error', note: 'boom, it broke' },
    ];
    expect(renderCsv(metrics, BASE_URL).split('\n')[2]).toBe('files,Files,,error,"boom, it broke"');
  });
});

describe('renderTable', () => {
  it('starts with a header line naming the environment, then a blank line', () => {
    const lines = renderTable(sampleMetrics, BASE_URL).split('\n');
    expect(lines[0]).toBe(`PDC API base URL: ${BASE_URL}`);
    expect(lines[1]).toBe('');
  });

  it('includes a column header with all four columns', () => {
    const [, , columnHeader] = renderTable(sampleMetrics, BASE_URL).split('\n');
    expect(columnHeader).toContain('ENDPOINT');
    expect(columnHeader).toContain('COUNT');
    expect(columnHeader).toContain('STATUS');
    expect(columnHeader).toContain('NOTE');
  });

  it('prefixes each endpoint path with a slash and shows its formatted count', () => {
    const table = renderTable(sampleMetrics, BASE_URL);
    expect(table).toContain('/baseFields');
    expect(table).toContain('282');
    expect(table).toContain('ok');
  });

  it('renders an unavailable endpoint with an em dash and its note', () => {
    const table = renderTable(sampleMetrics, BASE_URL);
    expect(table).toContain('/proposals');
    expect(table).toContain('—');
    expect(table).toContain('unauthorized');
  });

  it('left-pads the count column so values are right-aligned', () => {
    // "282" is width 3 (the widest count once the header "COUNT" is considered),
    // so the single-item "17" must be right-aligned under it.
    const line = renderTable(sampleMetrics, BASE_URL)
      .split('\n')
      .find((l) => l.includes('/changemakers'));
    expect(line).toBeDefined();
    expect(line).toContain(' 17  ');
  });
});

describe('renderJson', () => {
  it('produces valid JSON with the environment URL, summary, and metrics', () => {
    const parsed: unknown = JSON.parse(renderJson(sampleMetrics, BASE_URL));
    expect(parsed).toStrictEqual({
      pdcApiBaseUrl: BASE_URL,
      generatedAt: expect.any(String),
      summary: { endpointCount: 3, okCount: 2, failedCount: 1, itemTotal: 299 },
      metrics: sampleMetrics,
    });
  });
});
