import { AxiosError } from 'axios';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      ignore: 'pid,hostname',
      translateTime: 'SYS:yyyy-mm-dd h:MM:ss TT',
    },
  },
});

/**
 * Reduce an error to what is useful in a log. An AxiosError otherwise serializes
 * its whole request — including the `Authorization: Bearer …` header — so only
 * its status, method, URL, and response body are kept. Plain errors keep their
 * name, message, and stack, and any `cause` is reduced the same way.
 */
const toLoggableError = (err: unknown): unknown => {
  if (err instanceof AxiosError) {
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      status: err.status,
      method: err.config?.method,
      url: err.config?.url,
      responseData: err.response?.data as unknown,
    };
  }
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause === undefined ? {} : { cause: toLoggableError(err.cause) }),
    };
  }
  return err;
};

export { logger, toLoggableError };
