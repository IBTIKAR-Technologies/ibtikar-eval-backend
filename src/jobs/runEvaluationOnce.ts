import '../config';
import { connectDB, disconnectDB } from '../config/database';
import evaluationService from '../services/evaluationService';
import logger from '../utils/logger';

async function main(): Promise<void> {
  await connectDB();
  try {
    const run = await evaluationService.runFullCycle({ trigger: 'manual' });
    logger.info('[RunOnce] Cycle terminé', {
      id: String(run._id),
      status: run.status,
      counters: run.counters,
    });
  } finally {
    await disconnectDB();
    logger.info('[RunOnce] MongoDB déconnecté');
  }
}

main().catch((err: unknown) => {
  logger.error('[RunOnce] Échec', err instanceof Error ? err : new Error(String(err)));
  process.exitCode = 1;
});
