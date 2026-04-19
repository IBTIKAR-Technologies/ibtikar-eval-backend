import cron from 'node-cron';
import config from '../config';
import logger from '../utils/logger';
import evaluationService from '../services/evaluationService';
import type { CronTrigger } from '../types';

let isRunning = false;

export async function runSafely(trigger: CronTrigger = 'schedule'): Promise<void> {
  if (isRunning) {
    logger.warn('[Cron] Un cycle est déjà en cours, skip');
    return;
  }
  isRunning = true;
  try {
    await evaluationService.runFullCycle({ trigger });
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
  logger.info(`[Cron] Programmé : ${config.cron.schedule} (${config.cron.timezone})`);

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
