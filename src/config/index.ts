import path from 'path';
import dotenv from 'dotenv';
import type { EvaluationPeriodType } from '../types';

const root = process.cwd();
dotenv.config({ path: path.resolve(root, '.env') });
dotenv.config({ path: path.resolve(root, '.env.local'), override: true });

function required(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`[CONFIG] Variable d'environnement manquante ou vide: ${key}`);
  return v;
}

function geminiApiKey(): string {
  const raw = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const v = raw?.trim();
  if (!v) {
    throw new Error(
      '[CONFIG] Variable manquante: GEMINI_API_KEY ou GOOGLE_API_KEY (Google AI Studio / Vertex)'
    );
  }
  return v;
}

function splitCsv(v?: string): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEvaluationPeriodType(raw?: string): EvaluationPeriodType {
  const v = (raw ?? 'week').trim().toLowerCase();
  if (v === 'week' || v === 'month' || v === 'quarter') return v;
  if (v === '3mois' || v === '3months' || v === 'trimester' || v === 'trimestre') return 'quarter';
  return 'week';
}

export interface AppConfig {
  env: string;
  port: number;
  mongo: { uri: string };
  github: {
    token: string;
    org: string;
    requestTimeoutMs: number;
    requestMaxRetries: number;
    /** ObjectId hex optionnel : utilisé comme `group` uniquement à la création d’un nouveau Repository (sync GitHub). */
    defaultRepoGroupId?: string;
  };
  gemini: {
    apiKey: string;
    model: string;
    maxRetries: number;
    concurrency: number;
    delayBetweenEvaluationsMs: number;
  };
  jira: {
    enabled: boolean;
    baseUrl?: string;
    email?: string;
    apiToken?: string;
    projectKeys: string[];
    syncLookbackDays: number;
    cronSchedule: string;
    cronTimezone: string;
    cronRunOnStart: boolean;
  };
  cron: {
    schedule: string;
    timezone: string;
    runOnStart: boolean;
    periodType: EvaluationPeriodType;
    lookbackDays: number;
  };
  limits: { maxCommitsPerDev: number; maxFilesPerCommit: number; maxDiffChars: number };
  dashboard: { origins: string[] };
}

const config: AppConfig = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),

  mongo: {
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/ibtikar_eval',
  },

  github: {
    token: required('GITHUB_TOKEN'),
    org: (process.env.GITHUB_ORG ?? '').trim() || 'Ibtikar',
    requestTimeoutMs: Math.max(10_000, parseInt(process.env.GITHUB_REQUEST_TIMEOUT_MS ?? '60000', 10)),
    requestMaxRetries: Math.max(1, parseInt(process.env.GITHUB_REQUEST_MAX_RETRIES ?? '5', 10)),
    defaultRepoGroupId: process.env.GITHUB_DEFAULT_REPO_GROUP_ID?.trim() || undefined,
  },

  gemini: {
    apiKey: geminiApiKey(),
    model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    maxRetries: Math.max(0, parseInt(process.env.GEMINI_MAX_RETRIES ?? '4', 10)),
    concurrency: Math.max(1, parseInt(process.env.GEMINI_CONCURRENCY ?? '1', 10)),
    delayBetweenEvaluationsMs: Math.max(
      0,
      parseInt(process.env.GEMINI_EVAL_DELAY_MS ?? '2000', 10)
    ),
  },

  jira: {
    enabled:
      process.env.JIRA_ENABLED === 'true' ||
      (!!process.env.JIRA_BASE_URL && !!process.env.JIRA_EMAIL && !!process.env.JIRA_API_TOKEN),
    baseUrl: process.env.JIRA_BASE_URL?.trim(),
    email: process.env.JIRA_EMAIL?.trim(),
    apiToken: process.env.JIRA_API_TOKEN?.trim(),
    projectKeys: splitCsv(process.env.JIRA_PROJECT_KEYS),
    syncLookbackDays: Math.max(1, parseInt(process.env.JIRA_SYNC_LOOKBACK_DAYS ?? '90', 10)),
    cronSchedule: process.env.JIRA_CRON_SCHEDULE ?? '0 3 * * *',
    cronTimezone: process.env.JIRA_CRON_TIMEZONE ?? 'Africa/Nouakchott',
    cronRunOnStart: process.env.JIRA_CRON_RUN_ON_START === 'true',
  },

  cron: {
    schedule: process.env.CRON_SCHEDULE ?? '0 2 * * 1',
    timezone: process.env.CRON_TIMEZONE ?? 'Africa/Nouakchott',
    runOnStart: process.env.CRON_RUN_ON_START === 'true',
    periodType: parseEvaluationPeriodType(process.env.CRON_PERIOD_TYPE ?? process.env.EVAL_PERIOD_TYPE),
    lookbackDays: Math.max(1, parseInt(process.env.EVAL_LOOKBACK_DAYS ?? '7', 10)),
  },

  limits: {
    maxCommitsPerDev: parseInt(process.env.MAX_COMMITS_PER_DEV ?? '30', 10),
    maxFilesPerCommit: parseInt(process.env.MAX_FILES_PER_COMMIT ?? '10', 10),
    maxDiffChars: parseInt(process.env.MAX_DIFF_CHARS ?? '15000', 10),
  },

  dashboard: {
    origins: (process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

export default config;
