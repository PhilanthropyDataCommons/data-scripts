import { client } from './client';
import type { AccessTokenSet } from './oidc';

const callPdcApi = async <T>(
  baseUrl: string,
  path: string,
  params: Record<string, string>,
  token: AccessTokenSet,
  method: 'get' | 'post',
  data?: unknown,
): Promise<T> => {
  const url = new URL(path, baseUrl);
  url.search = new URLSearchParams(params).toString();
  const response = await client.request<T>(
    {
      method,
      url: url.toString(),
      headers: {
        authorization: `Bearer ${token.access_token}`,
      },
      data,
    },
  );
  return response.data;
};

interface ApiBaseField {
  id: number;
  label: string;
  shortCode: string;
}

const getBaseFields = (baseUrl: string, token: AccessTokenSet) => (
  callPdcApi<ApiBaseField[]>(
    baseUrl,
    '/baseFields',
    {},
    token,
    'get',
  )
);

interface ApiProposal {
  id: number;
  versions: {
    version: number;
    fieldValues: {
      applicationFormField: {
        baseFieldId: number;
        position: number;
      };
      value: string;
    }[];
  }[];
}

interface ApiProposals {
  entries: ApiProposal[];
  total: number;
}

const getProposals = (baseUrl: string, token: AccessTokenSet) => (
  callPdcApi<ApiProposals>(
    baseUrl,
    '/proposals',
    {
      _page: '1',
      _count: '1000',
    },
    token,
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
    token,
    'post',
    {
      externalId,
      platformProvider,
      data,
    },
  )
);

export {
  getBaseFields,
  getProposals,
  postPlatformProviderData,
};
