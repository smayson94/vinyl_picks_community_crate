/* eslint-disable no-console */
export const logger = {
  info: (msg: string, ...rest: unknown[]) => console.log(`[info] ${msg}`, ...rest),
  warn: (msg: string, ...rest: unknown[]) => console.warn(`[warn] ${msg}`, ...rest),
  error: (msg: string, ...rest: unknown[]) => console.error(`[error] ${msg}`, ...rest),
};
