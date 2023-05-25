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
  postPlatformProviderData,
};
