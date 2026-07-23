import { writeFile } from 'node:fs/promises';
import { Issuer, type TokenSet } from 'openid-client';
import { jwtDecode } from 'jwt-decode';
import { logger } from './logger.js';
import type { CommandModule, Options } from 'yargs';

export interface AccessTokenSet extends TokenSet {
  access_token: string;
}

const isAccessToken = (token: TokenSet): token is AccessTokenSet => 'access_token' in token;

const getToken = async (baseUrl: string, clientId: string, clientSecret: string): Promise<AccessTokenSet> => {
  const issuer = await Issuer.discover(baseUrl);
  logger.debug(`Discovered OIDC issuer at ${issuer.metadata.issuer}`);

  const client = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
  });

  const token = await client.grant({ grant_type: 'client_credentials' });

  if (!isAccessToken(token)) {
    logger.error({ token }, 'Received token');
    throw new Error('Token set does not include an access token');
  }

  const { jti } = jwtDecode(token.access_token);
  if (jti === undefined) {
    logger.debug('Retrieved token');
  } else {
    logger.debug(`Retrieved token with id ${jti}`);
  }

  return token;
};

const oidcOptions: Record<string, Options> = {
  'oidc-base-url': {
    describe: 'OpenID Connect authority base URL',
    demandOption: true,
    type: 'string',
  },
  'oidc-client-id': {
    describe: 'OpenID Connect client ID',
    demandOption: true,
    type: 'string',
  },
  'oidc-client-secret': {
    describe: 'OpenID Connect client secret',
    demandOption: true,
    type: 'string',
  },
};

interface TokenCommandArgs {
  oidcBaseUrl: string;
  oidcClientId: string;
  oidcClientSecret: string;
  outputFile?: string;
}

const getTokenCommand: CommandModule<object, TokenCommandArgs> = {
  command: 'test-client-credentials',
  aliases: ['auth'],
  describe: 'Validate the OIDC client credentials and configuration by retrieving a token',
  builder: {
    ...oidcOptions,
    'output-file': {
      alias: 'write',
      describe: 'Write token to the specified file',
      normalize: true,
      type: 'string',
    },
  },
  handler: async (args) => {
    const token = await getToken(args.oidcBaseUrl, args.oidcClientId, args.oidcClientSecret);

    if (args.outputFile === undefined) {
      logger.info({ token: jwtDecode(token.access_token) }, 'Successfully retrieved token');
    } else {
      await writeFile(args.outputFile, token.access_token);
      logger.info(`Wrote token to ${args.outputFile}`);
    }
  },
};

export { getToken, getTokenCommand, oidcOptions };
