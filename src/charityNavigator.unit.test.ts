import { describe, expect, it, jest } from '@jest/globals';
import { extractPageFromResponse, fetchAllPages } from './charityNavigator.js';

// The fetcher's signature mirrors the `fetchPage` parameter of `fetchAllPages`,
// so a stubbed `jest.fn` can stand in for the real Charity Navigator page request
// without touching the network (GLM-5.2).
type PageFetcher = Parameters<typeof fetchAllPages>[0];

describe('fetchAllPages', () => {
  it('accumulates edges across multiple pages and returns the final pageInfo', async () => {
    const edgeOne = { ein: '012345678', name: 'Org A', updatedAt: '2024-01-01T00:00:00Z' };
    const edgeTwo = { ein: '111111111', name: 'Org B', updatedAt: '2024-01-02T00:00:00Z' };
    const edgeThree = { ein: '222222222', name: 'Org C', updatedAt: '2024-01-03T00:00:00Z' };
    const fetchPage = jest
      .fn<PageFetcher>()
      .mockResolvedValueOnce({
        edges: [edgeOne],
        pageInfo: { totalPages: 3, totalItems: 3, currentPage: 1 },
      })
      .mockResolvedValueOnce({
        edges: [edgeTwo],
        pageInfo: { totalPages: 3, totalItems: 3, currentPage: 2 },
      })
      .mockResolvedValueOnce({
        edges: [edgeThree],
        pageInfo: { totalPages: 3, totalItems: 3, currentPage: 3 },
      });

    const result = await fetchAllPages(fetchPage);

    expect(result.edges).toStrictEqual([edgeOne, edgeTwo, edgeThree]);
    expect(result.pageInfo).toStrictEqual({ totalPages: 3, totalItems: 3, currentPage: 3 });
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 1);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 2);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 3);
  });

  it('returns the single page when totalPages is 1', async () => {
    const edge = { ein: '012345678', name: 'Org A', updatedAt: '2024-01-01T00:00:00Z' };
    const fetchPage = jest.fn<PageFetcher>().mockResolvedValueOnce({
      edges: [edge],
      pageInfo: { totalPages: 1, totalItems: 1, currentPage: 1 },
    });

    const result = await fetchAllPages(fetchPage);

    expect(result.edges).toStrictEqual([edge]);
    expect(result.pageInfo).toStrictEqual({ totalPages: 1, totalItems: 1, currentPage: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 1);
  });

  it('returns no edges and the first pageInfo when the first page is empty', async () => {
    const fetchPage = jest.fn<PageFetcher>().mockResolvedValueOnce({
      edges: [],
      pageInfo: { totalPages: 1, totalItems: 0, currentPage: 1 },
    });

    const result = await fetchAllPages(fetchPage);

    expect(result.edges).toStrictEqual([]);
    expect(result.pageInfo).toStrictEqual({ totalPages: 1, totalItems: 0, currentPage: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws when totalPages is undefined instead of infinite-looping', async () => {
    const fetchPage = jest.fn<PageFetcher>().mockResolvedValueOnce({
      edges: [{ ein: '012345678', name: 'Org A', updatedAt: '2024-01-01T00:00:00Z' }],
      /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
      simulate a malformed runtime GraphQL response where totalPages is
      missing (GLM-5.2). */
      pageInfo: { totalPages: undefined as unknown as number, totalItems: 1, currentPage: 1 },
    });

    await expect(fetchAllPages(fetchPage)).rejects.toThrow(/invalid totalPages value/v);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws when totalPages is null instead of stopping after page 1', async () => {
    const fetchPage = jest.fn<PageFetcher>().mockResolvedValueOnce({
      edges: [{ ein: '012345678', name: 'Org A', updatedAt: '2024-01-01T00:00:00Z' }],
      /* eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion --
      simulate a malformed runtime GraphQL response where totalPages is null
      (GLM-5.2). */
      pageInfo: { totalPages: null as unknown as number, totalItems: 1, currentPage: 1 },
    });

    await expect(fetchAllPages(fetchPage)).rejects.toThrow(/invalid totalPages value/v);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('throws when totalPages is 0 instead of treating it as "stop after page 1"', async () => {
    const fetchPage = jest.fn<PageFetcher>().mockResolvedValueOnce({
      edges: [{ ein: '012345678', name: 'Org A', updatedAt: '2024-01-01T00:00:00Z' }],
      pageInfo: { totalPages: 0, totalItems: 0, currentPage: 1 },
    });

    await expect(fetchAllPages(fetchPage)).rejects.toThrow(/invalid totalPages value/v);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

describe('extractPageFromResponse', () => {
  const validData = {
    nonprofitsPublic: {
      edges: [{ ein: '012345678', name: 'Org A', updatedAt: '2024-01-01T00:00:00Z' }],
      pageInfo: { totalPages: 1, totalItems: 1, currentPage: 1 },
    },
  };

  it('returns nonprofitsPublic when data is present', () => {
    expect(extractPageFromResponse({ data: validData }, 1)).toStrictEqual(validData.nonprofitsPublic);
  });

  it('throws a clear error when data is null', () => {
    expect(() => extractPageFromResponse({ data: null }, 1)).toThrow(
      /Charity Navigator GraphQL query returned no data on page 1/v,
    );
  });

  it('throws a clear error when data is undefined', () => {
    expect(() => extractPageFromResponse({ data: undefined }, 1)).toThrow(
      /Charity Navigator GraphQL query returned no data on page 1/v,
    );
  });
});
