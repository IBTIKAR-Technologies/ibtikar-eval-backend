import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import config from './config';
import { connectDB, disconnectDB } from './config/database';
import logger from './utils/logger';
import apiRouter from './routes';
import errorHandler from './middleware/errorHandler';
import { startCron } from './jobs/evaluationCron';
import { startJiraCron } from './jobs/evaluationJiraCron';

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.dashboard.origins,
    credentials: true,
  })
);
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));

app.use('/api', apiRouter);

app.use(errorHandler);

async function bootstrap(): Promise<void> {
  await connectDB();
  startCron();
  startJiraCron();

  const server = app.listen(config.port, () => {
    logger.info(`[Server] Écoute sur le port ${config.port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`[Server] Signal ${signal} — arrêt en cours`);
    server.close(async () => {
      await disconnectDB();
      logger.info('[Server] Arrêt propre terminé');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err: unknown) => {
  logger.error('[Server] Échec au démarrage', err instanceof Error ? err : new Error(String(err)));
  process.exit(1);
});
