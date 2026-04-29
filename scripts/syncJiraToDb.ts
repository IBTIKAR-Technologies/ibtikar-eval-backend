/**
 * Import Jira -> MongoDB (script CLI)
 * Équivalent de `npm run cron:jira`, gardé pour compatibilité.
 *
 * Usage: npm run sync:jira
 */
import '../src/config';
import { connectDB, disconnectDB } from '../src/config/database';
import { runJiraSync } from '../src/jobs/evaluationJiraCron';
import logger from '../src/utils/logger';

async function main(): Promise<void> {
  await connectDB();
  try {
    const result = await runJiraSync();
    logger.info('[SyncJira] Terminé', result);
  } finally {
    await disconnectDB();
    logger.info('[SyncJira] MongoDB déconnecté');
  }
}

main().catch((err: unknown) => {
  logger.error('[SyncJira] Échec', err instanceof Error ? err : new Error(String(err)));
  process.exitCode = 1;
});
