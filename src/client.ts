import axios, { type InternalAxiosRequestConfig, type AxiosResponse } from 'axios';
import { logger } from './logger.js';

const clientLogger = logger.child({}, { msgPrefix: '🌐 ' });

const logRequest = (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
  const { method, url } = config;
  if (method !== undefined && url !== undefined) {
    clientLogger.debug(`${method} ${url}`);
  } else {
    clientLogger.debug({ config }, 'Request');
  }
  return config;
};

const logResponse = (response: AxiosResponse): AxiosResponse => {
  const {
    config: { method, url },
    status,
    statusText,
  } = response;
  if (method !== undefined && url !== undefined) {
    clientLogger.debug(`${method} ${url} => ${status} ${statusText}`);
  } else {
    clientLogger.debug({ config: response.config }, `${status} ${statusText}`);
  }
  return response;
};

const axiosDefaults = {
  headers: {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
  },
};
const client = axios.create(axiosDefaults);
client.interceptors.request.use(logRequest);
client.interceptors.response.use(logResponse);

export { client };
