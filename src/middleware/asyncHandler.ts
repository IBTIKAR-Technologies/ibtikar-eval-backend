import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncRouteFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Enveloppe une route async Express et transmet les erreurs à `next(err)` */
export default function asyncHandler(fn: AsyncRouteFn): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
