import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

/** Erreur HTTP explicite pour les routes */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const status =
    err instanceof HttpError
      ? err.status
      : typeof (err as { status?: number })?.status === 'number'
        ? (err as { status: number }).status
        : 500;

  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Erreur interne';

  if (status >= 500) {
    logger.error('[ErrorHandler]', err instanceof Error ? err : new Error(String(err)));
  } else {
    logger.warn(`[ErrorHandler] ${status} — ${message}`);
  }

  res.status(status).json({
    error: {
      message,
      status,
    },
  });
};

export default errorHandler;
