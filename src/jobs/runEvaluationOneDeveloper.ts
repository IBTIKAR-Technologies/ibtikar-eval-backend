import '../config';
import config from '../config';
import { connectDB, disconnectDB } from '../config/database';
import evaluationService from '../services/evaluationService';
import logger from '../utils/logger';
import type { EvaluationPeriodType } from '../types';

function normalizeGithubUsername(raw: string | undefined): string {
  return (raw ?? '').trim().toLowerCase().replace(/^@+/, '');
}

function resolvePeriodType(rawInput?: string): EvaluationPeriodType {
  const raw = (rawInput ?? process.env.EVAL_PERIOD_TYPE ?? config.cron.periodType).toLowerCase();
  if (raw === 'week' || raw === 'month' || raw === 'quarter') return raw;
  if (raw === '3mois' || raw === '3months' || raw === 'trimester' || raw === 'trimestre') return 'quarter';
  logger.warn(`[RunOne] Period type invalide (${raw}), fallback "${config.cron.periodType}"`);
  return config.cron.periodType;
}

async function main(): Promise<void> {
  const usernameArg = normalizeGithubUsername(process.argv[2]);
  if (!usernameArg) {
    throw new Error('Usage: tsx src/jobs/runEvaluationOneDeveloper.ts <github-username> [week|month|quarter]');
  }

  const periodType = resolvePeriodType(process.argv[3]);

  await connectDB();
  try {
    const run = await evaluationService.runFullCycle({
      trigger: 'manual',
      periodType,
      githubUsernames: [usernameArg],
    });

    logger.info('[RunOne] Cycle développeur terminé', {
      username: usernameArg,
      id: String(run._id),
      status: run.status,
      periodType,
      counters: run.counters,
    });
  } finally {
    await disconnectDB();
    logger.info('[RunOne] MongoDB déconnecté');
  }
}

main().catch((err: unknown) => {
  logger.warn('[RunOne] Échec non bloquant (exitCode=0)', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 0;
});
