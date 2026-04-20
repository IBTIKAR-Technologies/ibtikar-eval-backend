/**
 * Import Jira -> MongoDB
 * - Projets Jira => Groups
 * - Développeurs Jira (assignees) => Developers
 * - Liaison Developers.groups[] selon les projets Jira
 *
 * Usage: npm run sync:jira
 */
import '../src/config';
import config from '../src/config';
import { Types } from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/database';
import { Developer, Group, Projet } from '../src/models';
import jiraService from '../src/services/jiraService';
import logger from '../src/utils/logger';

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
        joinedAt: new Date(),
      },
      $set: {
        fullName: params.displayName,
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

async function main(): Promise<void> {
  if (!jiraService.isEnabled()) {
    throw new Error(
      '[SyncJira] Jira non configuré. Vérifie JIRA_ENABLED, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.'
    );
  }

  await connectDB();
  try {
    const lookbackDays = config.jira.syncLookbackDays;
    const projects = await jiraService.listProjects();
    logger.info(`[SyncJira] ${projects.length} projet(s) Jira récupéré(s)`);

    let groupsCreated = 0;
    let developersTouched = 0;
    let projetsTouched = 0;

    for (const project of projects) {
      const groupId = await upsertProjectGroup({ key: project.key, name: project.name });
      groupsCreated += 1;

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
        `[SyncJira] Projet ${project.key}: ${assignees.length} développeur(s), ${work.totalIssues} ticket(s) (${work.backlogCount} backlog, ${work.inProgressCount} en cours, ${work.doneCount} done) sur ${lookbackDays} jours`
      );
    }

    const devCount = await Developer.countDocuments({});
    const groupCount = await Group.countDocuments({});
    const projetCount = await Projet.countDocuments({});
    logger.info('[SyncJira] Terminé', {
      projectsProcessed: projects.length,
      groupsTouched: groupsCreated,
      projetsTouched,
      developersTouched,
      totalDevelopersInDb: devCount,
      totalGroupsInDb: groupCount,
      totalProjetsInDb: projetCount,
    });
  } finally {
    await disconnectDB();
    logger.info('[SyncJira] MongoDB déconnecté');
  }
}

main().catch((err: unknown) => {
  logger.error('[SyncJira] Échec', err instanceof Error ? err : new Error(String(err)));
  process.exitCode = 1;
});
