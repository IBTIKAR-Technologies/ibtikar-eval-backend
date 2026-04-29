import '../src/config';
import { connectDB, disconnectDB } from '../src/config/database';
import config from '../src/config';
import logger from '../src/utils/logger';
import { Developer } from '../src/models';
import jiraService from '../src/services/jiraService';

interface JiraAssignee {
  accountId: string;
  displayName: string;
  email?: string;
}

interface Stats {
  projectsScanned: number;
  jiraAssigneesSeen: number;
  jiraAssigneesWithEmail: number;
  githubDevelopersMatched: number;
  githubDevelopersUpdated: number;
  jiraGroupLinksApplied: number;
  skippedNoEmail: number;
  skippedNoMatch: number;
  skippedAmbiguous: number;
}

function normalizeName(input?: string): string {
  return (input ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isJiraShadowUsername(username?: string): boolean {
  return !!username && username.toLowerCase().startsWith('jira-');
}

async function collectJiraAssignees(): Promise<{
  projectsScanned: number;
  assignees: Map<string, JiraAssignee>;
}> {
  const lookbackDays = config.jira.syncLookbackDays;
  const projects = await jiraService.listProjects();
  const assignees = new Map<string, JiraAssignee>();

  for (const p of projects) {
    try {
      const list = await jiraService.listProjectAssignees(p.key, lookbackDays);
      for (const a of list) {
        if (!assignees.has(a.accountId)) {
          assignees.set(a.accountId, {
            accountId: a.accountId,
            displayName: a.displayName,
            email: a.email?.toLowerCase(),
          });
        } else {
          const prev = assignees.get(a.accountId)!;
          if (!prev.email && a.email) prev.email = a.email.toLowerCase();
        }
      }
      logger.info(`[JiraEmailLink] Projet ${p.key}: ${list.length} assignee(s) collecté(s)`);
    } catch (err) {
      logger.error(
        `[JiraEmailLink] Projet ${p.key}: impossible de collecter les assignees (continue)`,
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  return { projectsScanned: projects.length, assignees };
}

async function main(): Promise<void> {
  if (!jiraService.isEnabled()) {
    throw new Error(
      '[JiraEmailLink] Jira non configuré. Vérifie JIRA_ENABLED, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN.'
    );
  }

  await connectDB();
  const stats: Stats = {
    projectsScanned: 0,
    jiraAssigneesSeen: 0,
    jiraAssigneesWithEmail: 0,
    githubDevelopersMatched: 0,
    githubDevelopersUpdated: 0,
    jiraGroupLinksApplied: 0,
    skippedNoEmail: 0,
    skippedNoMatch: 0,
    skippedAmbiguous: 0,
  };

  try {
    const { projectsScanned, assignees } = await collectJiraAssignees();
    stats.projectsScanned = projectsScanned;
    stats.jiraAssigneesSeen = assignees.size;

    for (const jiraUser of assignees.values()) {
      const jiraEmail = jiraUser.email?.trim().toLowerCase();
      if (!jiraEmail) {
        stats.skippedNoEmail += 1;
        continue;
      }
      stats.jiraAssigneesWithEmail += 1;

      const byEmail = await Developer.find({
        githubUsername: { $not: /^jira-/i },
        $or: [{ email: jiraEmail }, { githubEmails: jiraEmail }],
      });

      let candidates = byEmail;
      if (candidates.length === 0) {
        const nameKey = normalizeName(jiraUser.displayName);
        if (!nameKey) {
          stats.skippedNoMatch += 1;
          continue;
        }
        const byName = await Developer.find({
          githubUsername: { $not: /^jira-/i },
          fullName: { $exists: true, $ne: '' },
        });
        candidates = byName.filter((d) => normalizeName(d.fullName) === nameKey);
      }

      if (candidates.length === 0) {
        stats.skippedNoMatch += 1;
        continue;
      }
      if (candidates.length > 1) {
        stats.skippedAmbiguous += 1;
        logger.warn(
          `[JiraEmailLink] Mapping ambigu pour ${jiraUser.displayName} <${jiraEmail}> (${candidates.length} candidats)`
        );
        continue;
      }

      const githubDev = candidates[0];
      stats.githubDevelopersMatched += 1;

      const update: Record<string, unknown> = { $addToSet: { githubEmails: jiraEmail } };
      if (!githubDev.email) {
        update.$set = { email: jiraEmail };
      }

      const jiraShadow = await Developer.findOne({
        githubUsername: `jira-${jiraUser.accountId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 96),
      });

      if (jiraShadow?.groups?.length) {
        update.$addToSet = {
          ...(update.$addToSet as object),
          groups: { $each: jiraShadow.groups },
        };
      }

      await Developer.updateOne({ _id: githubDev._id }, update);
      stats.githubDevelopersUpdated += 1;
      if (jiraShadow?.groups?.length) stats.jiraGroupLinksApplied += 1;
    }

    logger.info('[JiraEmailLink] Terminé', stats);
  } finally {
    await disconnectDB();
    logger.info('[JiraEmailLink] MongoDB déconnecté');
  }
}

main().catch((err: unknown) => {
  logger.error('[JiraEmailLink] Échec', err instanceof Error ? err : new Error(String(err)));
  process.exitCode = 1;
});

