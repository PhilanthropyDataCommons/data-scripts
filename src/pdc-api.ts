import { client } from './client';
import type { AccessTokenSet } from './oidc';
import type {
  BaseField, ProposalBundle, ChangemakerBundle, SourceBundle, Source,
} from '@pdc/sdk';

const callPdcApi = async <T>(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  method: 'get' | 'post',
  token?: AccessTokenSet,
  data?: unknown,
): Promise<T> => {
  const url = new URL(path, baseUrl);
  url.search = new URLSearchParams(params).toString();
  const headers = token ? { authorization: `Bearer ${token.access_token}` } : {};
  const response = await client.request<T>(
    {
      method,
      url: url.toString(),
      headers,
      data,
    },
  );
  return response.data;
};

const getBaseFields = (baseUrl: string, token: AccessTokenSet) => (
  callPdcApi<BaseField[]>(
    baseUrl,
    '/baseFields',
    {},
    'get',
    token,
  )
);

const getProposals = (baseUrl: string, token: AccessTokenSet) => (
  callPdcApi<ProposalBundle>(
    baseUrl,
    '/proposals',
    {
      _page: '1',
      _count: '1000',
    },
    'get',
    token,
  )
);

/**
 * Get all (up to 10m) changemakers. Avoids authentication to get only direct attributes (shallow).
 * The `fields` and `fiscalSponsors` (deep) attributes will be present but empty in this case.
 */
const getChangemakers = (baseUrl: string) => (
  callPdcApi<ChangemakerBundle>(
    baseUrl,
    '/changemakers',
    {
      _page: '1',
      _count: '10000000',
    },
    'get',
  )
);

/**
 * Get all (up to 1m) sources.
 */
const getSources = (baseUrl: string, token: AccessTokenSet) => (
  callPdcApi<SourceBundle>(
    baseUrl,
    '/sources',
    {
      _page: '1',
      _count: '1000000',
    },
    'get',
    token,
  )
);

/** A corrected WritableSource (the SDK's is a bit off as of this writing) */
export interface WritableSource {
  label: string;
  dataProviderShortCode: string;
}

const postSource = (baseUrl: string, token: AccessTokenSet, data: WritableSource) => (
  callPdcApi<Source>(
    baseUrl,
    '/sources',
    {},
    'post',
    token,
    data,
  )
);

const postPlatformProviderData = (
  baseUrl: string,
  token: AccessTokenSet,
  externalId: string,
  platformProvider: string,
  data: object,
) => (
  callPdcApi(
    baseUrl,
    '/platformProviderResponses',
    {},
    'post',
    token,
    {
      externalId,
      platformProvider,
      data,
    },
  )
);

export {
  getBaseFields,
  getChangemakers,
  getProposals,
  getSources,
  postPlatformProviderData,
  postSource,
};
