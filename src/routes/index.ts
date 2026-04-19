import { Router } from 'express';
import developersRouter from './developers';
import groupsRouter from './groups';
import evaluationsRouter from './evaluations';
import cronRouter from './cron';

const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ data: { ok: true } });
});

apiRouter.use('/developers', developersRouter);
apiRouter.use('/groups', groupsRouter);
apiRouter.use('/evaluations', evaluationsRouter);
apiRouter.use('/cron', cronRouter);

export default apiRouter;
