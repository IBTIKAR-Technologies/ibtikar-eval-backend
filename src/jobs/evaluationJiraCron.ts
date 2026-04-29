import cron from 'node-cron';
import { Types } from 'mongoose';
import config from '../config';
import logger from '../utils/logger';
import { Developer, Group, Projet } from '../models';
import jiraService from '../services/jiraService';

let isRunning = false;

export interface JiraSyncResult {
  projectsProcessed: number;
  groupsTouched: number;
  projetsTouched: number;
  developersTouched: number;
  totalDevelopersInDb: number;
  totalGroupsInDb: number;
  totalProjetsInDb: number;
}

function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function jiraUsername(accountId: string): string {
  const s = accountId.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `jira-${s}`.slice(0, 96);
}

async function upsertProjectGroup(project: { key: string; name: string }): Promise<Types.ObjectId> {
  const slug = slugify(`jira-project-${project.key}`);
  const name = `${project.name} (${project.key})`;
  const g = await Group.findOneAndUpdate(
    { slug },
    {
      $setOnInsert: {
        slug,
        category: 'mixed',
        description: `Projet Jira ${project.key}`,
        repositories: [],
        leads: [],
      },
      $set: {
        name,
        isActive: true,
      },
    },
    { upsert: true, new: true }
  );
  return g._id;
}

async function upsertJiraDeveloper(params: {
  accountId: string;
  displayName: string;
  email?: string;
  groupId: Types.ObjectId;
}): Promise<void> {
  const username = jiraUsername(params.accountId);
  const emails = params.email ? [params.email.toLowerCase()] : [];
  await Developer.findOneAndUpdate(
    { githubUsername: username },
    {
      $setOnInsert: {
        githubUsername: username,
        fullName: params.displayName,
        joinedAt: new Date(),
      },
      $set: {
        email: params.email?.toLowerCase(),
        githubEmails: emails,
        role: 'other',
        isActive: true,
      },
      $addToSet: { groups: params.groupId },
    },
    { upsert: true }
  );
}

async function upsertProjetDoc(params: {
  key: string;
  jiraProjectId: string;
  name: string;
  projectTypeKey?: string;
  stats: {
    totalIssues: number;
    backlogCount: number;
    inProgressCount: number;
    doneCount: number;
    statusBreakdown: Array<{ status: string; count: number }>;
  };
  sampleIssues: Array<{
    key: string;
    summary: string;
    status: string;
    assignee?: string;
    updatedAt?: string;
  }>;
}): Promise<void> {
  await Projet.findOneAndUpdate(
    { key: params.key.toUpperCase() },
    {
      $setOnInsert: {
        key: params.key.toUpperCase(),
        jiraProjectId: params.jiraProjectId,
      },
      $set: {
        name: params.name,
        projectTypeKey: params.projectTypeKey,
        isActive: true,
        stats: params.stats,
        sampleIssues: params.sampleIssues,
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

/**
 * Synchronise Jira vers MongoDB : projets → Groups, assignees → Developers.
 * Peut être appelé depuis le cron, le serveur (startup) ou un script CLI.
 * Ne gère pas la connexion DB (doit être déjà établie).
 */
export async function runJiraSync(): Promise<JiraSyncResult> {
  if (!jiraService.isEnabled()) {
    throw new Error(
      '[JiraCron] Jira non configuré. Vérifie JIRA_ENABLED, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.'
    );
  }

  const lookbackDays = config.jira.syncLookbackDays;
  const projects = await jiraService.listProjects();
  logger.info(`[JiraCron] ${projects.length} projet(s) Jira récupéré(s)`);

  let groupsTouched = 0;
  let developersTouched = 0;
  let projetsTouched = 0;
  let projectErrors = 0;

  for (const project of projects) {
    try {
      const groupId = await upsertProjectGroup({ key: project.key, name: project.name });
      groupsTouched += 1;

      const work = await jiraService.getProjectWorkSummary(project.key, lookbackDays);
      await upsertProjetDoc({
        key: project.key,
        jiraProjectId: project.id,
        name: project.name,
        projectTypeKey: project.projectTypeKey,
        stats: {
          totalIssues: work.totalIssues,
          backlogCount: work.backlogCount,
          inProgressCount: work.inProgressCount,
          doneCount: work.doneCount,
          statusBreakdown: work.statusBreakdown,
        },
        sampleIssues: work.sampleIssues,
      });
      projetsTouched += 1;

      const assignees = await jiraService.listProjectAssignees(project.key, lookbackDays);
      for (const a of assignees) {
        await upsertJiraDeveloper({
          accountId: a.accountId,
          displayName: a.displayName,
          email: a.email,
          groupId,
        });
        developersTouched += 1;
      }

      logger.info(
        `[JiraCron] Projet ${project.key}: ${assignees.length} dev(s), ${work.totalIssues} ticket(s) (${work.backlogCount} backlog, ${work.inProgressCount} en cours, ${work.doneCount} done) sur ${lookbackDays}j`
      );
    } catch (err) {
      projectErrors += 1;
      logger.error(
        `[JiraCron] Projet ${project.key}: échec sync (le traitement continue avec le projet suivant)`,
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  if (projectErrors > 0) {
    logger.warn(`[JiraCron] ${projectErrors} projet(s) en erreur pendant la sync (traitement global poursuivi)`);
  }

  const [totalDevelopersInDb, totalGroupsInDb, totalProjetsInDb] = await Promise.all([
    Developer.countDocuments({}),
    Group.countDocuments({}),
    Projet.countDocuments({}),
  ]);

  return {
    projectsProcessed: projects.length,
    groupsTouched,
    projetsTouched,
    developersTouched,
    totalDevelopersInDb,
    totalGroupsInDb,
    totalProjetsInDb,
  };
}

/** Garde de concurrence : empêche deux syncs Jira de tourner en parallèle. */
export async function runJiraSyncSafely(): Promise<void> {
  if (isRunning) {
    logger.warn('[JiraCron] Une sync Jira est déjà en cours, skip');
    return;
  }
  isRunning = true;
  try {
    const result = await runJiraSync();
    logger.info('[JiraCron] Sync terminée', result);
  } catch (err) {
    logger.error('[JiraCron] Erreur durant la sync', err);
  } finally {
    isRunning = false;
  }
}

export function startJiraCron(): void {
  if (!jiraService.isEnabled()) {
    logger.info('[JiraCron] Jira désactivé — cron ignoré');
    return;
  }
  const { cronSchedule: schedule, cronTimezone: tz, cronRunOnStart } = config.jira;

  if (!cron.validate(schedule)) {
    throw new Error(`[JiraCron] Schedule invalide : ${schedule}`);
  }
  logger.info(`[JiraCron] Programmé : ${schedule} (${tz})`);

  cron.schedule(
    schedule,
    () => {
      logger.info('[JiraCron] Déclenchement programmé');
      void runJiraSyncSafely();
    },
    { timezone: tz }
  );

  if (cronRunOnStart) {
    logger.info('[JiraCron] JIRA_CRON_RUN_ON_START=true → lancement immédiat');
    setTimeout(() => void runJiraSyncSafely(), 3000);
  }
}
