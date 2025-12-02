import axios, { InternalAxiosRequestConfig, AxiosResponse } from 'axios';
import { logger } from './logger';

const clientLogger = logger.child({}, { msgPrefix: '🌐 ' });

const logRequest = (config: InternalAxiosRequestConfig) => {
  const { method, url } = config;
  if (method && url) {
    clientLogger.debug(`${method} ${url}`);
  } else {
    clientLogger.debug({ config }, 'Request');
  }
  return config;
};

const logResponse = (response: AxiosResponse) => {
  const { config: { method, url }, status, statusText } = response;
  if (method && url) {
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
