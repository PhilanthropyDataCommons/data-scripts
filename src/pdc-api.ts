import { client } from './client.js';
import type { AccessTokenSet } from './oidc.js';
import type { BaseField, ProposalBundle, ChangemakerBundle, SourceBundle, Source, BaseFieldBundle } from '@pdc/sdk';

const callPdcApi = async <T>(
  baseUrl: string,
  path: string,
  method: 'get' | 'post',
  options: { params: Record<string, string>; token?: AccessTokenSet; data?: unknown },
): Promise<T> => {
  const url = new URL(path, baseUrl);
  url.search = new URLSearchParams(options.params).toString();
  const headers = options.token === undefined ? {} : { authorization: `Bearer ${options.token.access_token}` };
  const response = await client.request<T>({
    method,
    url: url.toString(),
    headers,
    data: options.data,
  });
  return response.data;
};

const getBaseFields = async (baseUrl: string, token: AccessTokenSet): Promise<BaseFieldBundle> =>
  await callPdcApi<BaseFieldBundle>(baseUrl, '/baseFields', 'get', {
    params: {
      _page: '1',
      _count: '2147483647',
    },
    token,
  });

const getProposals = async (baseUrl: string, token: AccessTokenSet): Promise<ProposalBundle> =>
  await callPdcApi<ProposalBundle>(baseUrl, '/proposals', 'get', {
    params: {
      _page: '1',
      _count: '1000',
    },
    token,
  });

/**
 * Get all (up to 10m) changemakers. Avoids authentication to get only direct attributes (shallow).
 * The `fields` and `fiscalSponsors` (deep) attributes will be present but empty in this case.
 */
const getChangemakers = async (baseUrl: string): Promise<ChangemakerBundle> =>
  await callPdcApi<ChangemakerBundle>(baseUrl, '/changemakers', 'get', {
    params: {
      _page: '1',
      _count: '10000000',
    },
  });

/**
 * Get all (up to 1m) sources.
 */
const getSources = async (baseUrl: string, token: AccessTokenSet): Promise<SourceBundle> =>
  await callPdcApi<SourceBundle>(baseUrl, '/sources', 'get', {
    params: {
      _page: '1',
      _count: '1000000',
    },
    token,
  });

/** A corrected WritableSource (the SDK's is a bit off as of this writing) */
export interface WritableSource {
  label: string;
  dataProviderShortCode: string;
}

const postSource = async (baseUrl: string, token: AccessTokenSet, data: WritableSource): Promise<Source> =>
  await callPdcApi<Source>(baseUrl, '/sources', 'post', { params: {}, token, data });

// TODO: use the SDK, delete these temp types copied from the service repo
interface ChangemakerFieldValueBatch {
  readonly id: number;
  sourceId: number;
  notes: string | null;
  readonly createdAt: string;
  readonly source: Source;
}
interface ChangemakerFieldValue {
  readonly id: number;
  changemakerId: number;
  baseFieldShortCode: string;
  batchId: number;
  value: string;
  readonly file: File | null;
  goodAsOf: string | null;
  readonly createdAt: string;
  readonly baseField: BaseField;
  readonly batch: ChangemakerFieldValueBatch;
  readonly isValid: boolean;
}

interface WritableChangemakerFieldValueBatch {
  sourceId: number;
  notes: string | null;
}
interface WritableChangemakerFieldValue {
  changemakerId: number;
  baseFieldShortCode: string;
  batchId: number;
  value: string;
  goodAsOf: string | null;
}

const postChangemakerFieldValueBatch = async (
  baseUrl: string,
  token: AccessTokenSet,
  data: WritableChangemakerFieldValueBatch,
): Promise<ChangemakerFieldValueBatch> =>
  await callPdcApi<ChangemakerFieldValueBatch>(baseUrl, '/changemakerFieldValueBatches', 'post', {
    params: {},
    token,
    data,
  });

const postChangemakerFieldValue = async (
  baseUrl: string,
  token: AccessTokenSet,
  data: WritableChangemakerFieldValue,
): Promise<ChangemakerFieldValue> =>
  await callPdcApi<ChangemakerFieldValue>(baseUrl, '/changemakerFieldValues', 'post', { params: {}, token, data });

const postPlatformProviderData = async (
  baseUrl: string,
  token: AccessTokenSet,
  body: { externalId: string; platformProvider: string; data: object },
): Promise<unknown> =>
  await callPdcApi(baseUrl, '/platformProviderResponses', 'post', { params: {}, token, data: body });

export {
  type ChangemakerFieldValue,
  type ChangemakerFieldValueBatch,
  getBaseFields,
  getChangemakers,
  getProposals,
  getSources,
  postChangemakerFieldValueBatch,
  postChangemakerFieldValue,
  postPlatformProviderData,
  postSource,
};
