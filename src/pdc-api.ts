import { client } from './client';
import type { AccessTokenSet } from './oidc';
import type { BaseField, ProposalBundle, ChangemakerBundle } from '@pdc/sdk';

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
 * Get all (up to 4m) changemakers. Avoids authentication to get only direct attributes (shallow).
 * The `fields` and `fiscalSponsors` (deep) attributes will be present but empty.
 */
const getChangemakers = (baseUrl: string) => (
  callPdcApi<ChangemakerBundle>(
    baseUrl,
    '/changemakers',
    {
      _page: '1',
      _count: '4000000',
    },
    'get',
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
  postPlatformProviderData,
};
