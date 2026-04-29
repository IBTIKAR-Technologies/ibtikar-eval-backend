import '../config';
import config from '../config';
import { connectDB, disconnectDB } from '../config/database';
import evaluationService from '../services/evaluationService';
import logger from '../utils/logger';
import type { EvaluationPeriodType } from '../types';

function resolvePeriodType(): EvaluationPeriodType {
  const raw = (
    process.argv[2] ??
    process.env.CRON_PERIOD_TYPE ??
    process.env.EVAL_PERIOD_TYPE ??
    config.cron.periodType
  ).toLowerCase();
  if (raw === 'week' || raw === 'month' || raw === 'quarter') return raw;
  if (raw === '3mois' || raw === '3months' || raw === 'trimester' || raw === 'trimestre') return 'quarter';
  logger.warn(`[RunOnce] Period type invalide (${raw}), fallback "${config.cron.periodType}"`);
  return config.cron.periodType;
}

async function main(): Promise<void> {
  await connectDB();
  try {
    const periodType = resolvePeriodType();
    const run = await evaluationService.runFullCycle({ trigger: 'manual', periodType });
    logger.info('[RunOnce] Cycle terminé', {
      id: String(run._id),
      status: run.status,
      periodType,
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
