import cron from 'node-cron';
import config from '../config';
import logger from '../utils/logger';
import evaluationService from '../services/evaluationService';
import type { CronTrigger, EvaluationPeriodType } from '../types';
import { Evaluation } from '../models';

let isRunning = false;

function resolvePeriodType(): EvaluationPeriodType {
  const raw = (process.env.CRON_PERIOD_TYPE ?? process.env.EVAL_PERIOD_TYPE ?? config.cron.periodType).toLowerCase();
  if (raw === 'week' || raw === 'month' || raw === 'quarter') return raw;
  if (raw === '3mois' || raw === '3months' || raw === 'trimester' || raw === 'trimestre') return 'quarter';
  logger.warn(`[Cron] CRON_PERIOD_TYPE invalide (${raw}), fallback "${config.cron.periodType}"`);
  return config.cron.periodType;
}

function addPeriod(date: Date, type: EvaluationPeriodType): Date {
  const next = new Date(date);
  if (type === 'week') next.setUTCDate(next.getUTCDate() + 7);
  else if (type === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 3);
  return next;
}

async function isPeriodTypeDue(type: EvaluationPeriodType, now: Date): Promise<boolean> {
  const latest = await Evaluation.findOne({
    periodType: type,
    status: { $in: ['completed', 'skipped'] },
  })
    .sort({ periodEnd: -1 })
    .select('periodEnd periodLabel')
    .lean();

  if (!latest?.periodEnd) {
    logger.info(`[Cron] ${type}: aucune évaluation existante, run initial requis`);
    return true;
  }

  const nextDueAt = addPeriod(new Date(latest.periodEnd), type);
  const due = now.getTime() >= nextDueAt.getTime();
  logger.info(
    `[Cron] ${type}: dernière=${new Date(latest.periodEnd).toISOString()} prochaine=${nextDueAt.toISOString()} due=${due}`
  );
  return due;
}

export async function runSafely(trigger: CronTrigger = 'schedule'): Promise<void> {
  if (isRunning) {
    logger.warn('[Cron] Un cycle est déjà en cours, skip');
    return;
  }
  isRunning = true;
  try {
    const forcedType = process.env.CRON_PERIOD_TYPE ?? process.env.EVAL_PERIOD_TYPE;
    if (forcedType) {
      await evaluationService.runFullCycle({ trigger, periodType: resolvePeriodType() });
      return;
    }

    const now = new Date();
    const types: EvaluationPeriodType[] = ['week', 'month', 'quarter'];
    for (const type of types) {
      const due = await isPeriodTypeDue(type, now);
      if (!due) continue;
      logger.info(`[Cron] Lancement automatique pour le type ${type}`);
      await evaluationService.runFullCycle({ trigger, periodType: type });
    }
  } catch (err) {
    logger.error('[Cron] Erreur durant le cycle', err);
  } finally {
    isRunning = false;
  }
}

export function startCron(): void {
  if (!cron.validate(config.cron.schedule)) {
    throw new Error(`Schedule cron invalide : ${config.cron.schedule}`);
  }
  logger.info(
    `[Cron] Programmé : ${config.cron.schedule} (${config.cron.timezone}) — mode auto multi-périodes`
  );

  cron.schedule(
    config.cron.schedule,
    () => {
      logger.info('[Cron] Déclenchement programmé');
      void runSafely('schedule');
    },
    { timezone: config.cron.timezone }
  );

  if (config.cron.runOnStart) {
    logger.info('[Cron] CRON_RUN_ON_START=true → lancement immédiat');
    setTimeout(() => void runSafely('startup'), 2000);
  }
}
