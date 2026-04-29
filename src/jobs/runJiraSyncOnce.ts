import '../config';
import { connectDB, disconnectDB } from '../config/database';
import logger from '../utils/logger';
import { runJiraSync } from './evaluationJiraCron';

async function main(): Promise<void> {
  await connectDB();
  try {
    const result = await runJiraSync();
    logger.info('[JiraRunOnce] Sync terminée', result);
  } finally {
    await disconnectDB();
    logger.info('[JiraRunOnce] MongoDB déconnecté');
  }
}

main().catch((err: unknown) => {
  logger.error('[JiraRunOnce] Échec', err instanceof Error ? err : new Error(String(err)));
  process.exitCode = 1;
});
