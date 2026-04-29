/**
 * Import depuis GitHub : membres org → Developers, métadonnées des repos → Repositories.
 * Les Group ne sont pas créés/modifiés ici et les nouveaux repositories ne sont pas insérés.
 * Ce script met à jour uniquement les dépôts déjà présents en base.
 *
 * Usage : yarn sync:github
 */
import '../src/config';
import pLimit from 'p-limit';
import config from '../src/config';
import { Types } from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/database';
import { Developer, Group, Repository } from '../src/models';
import githubService from '../src/services/githubService';
import type { OrgRepoInfo } from '../src/services/githubService';
import logger from '../src/utils/logger';
import type { RepoPlatform } from '../src/types';

function inferPlatform(language: string | null): RepoPlatform {
  if (!language) return 'other';
  const L = language.toLowerCase();
  const web = ['typescript', 'javascript', 'vue', 'html', 'css', 'scss', 'svelte'];
  const mobile = ['kotlin', 'swift', 'dart', 'objective-c'];
  if (web.includes(L)) return 'web';
  if (mobile.includes(L)) return 'mobile';
  const backendish = ['python', 'go', 'ruby', 'php', 'java', 'c#', 'rust', 'elixir', 'c++', 'scala'];
  if (backendish.includes(L)) return 'backend';
  return 'other';
}

async function upsertDeveloper(login: string, userId: number, displayName?: string): Promise<void> {
  const uname = login.toLowerCase();
  await Developer.findOneAndUpdate(
    { githubUsername: uname },
    {
      $setOnInsert: {
        githubUsername: uname,
        role: 'other',
        joinedAt: new Date(),
        groups: [],
      },
      $set: {
        githubUserId: userId,
        fullName: (displayName?.trim() || login).slice(0, 200),
        isActive: true,
      },
    },
    { upsert: true }
  );
}

async function syncOrgMembers(enrichProfiles: boolean): Promise<void> {
  const members = await githubService.listOrgMembers();
  logger.info(`[SyncGH] ${members.length} membres dans l’org GitHub`);

  if (enrichProfiles && members.length > 0) {
    const limit = pLimit(6);
    await Promise.all(
      members.map((m) =>
        limit(async () => {
          try {
            const u = await githubService.getUser(m.login);
            await upsertDeveloper(m.login, m.id, u.name ?? undefined);
          } catch {
            await upsertDeveloper(m.login, m.id);
          }
        })
      )
    );
  } else {
    for (const m of members) {
      await upsertDeveloper(m.login, m.id);
    }
  }
}

async function syncRepositoryMetadata(r: OrgRepoInfo): Promise<'updated' | 'skipped'> {
  const setFields = {
    githubRepoId: r.githubRepoId,
    name: r.name,
    language: r.language ?? undefined,
    defaultBranch: r.defaultBranch,
    isPrivate: r.isPrivate,
    isArchived: r.isArchived,
    platform: inferPlatform(r.language),
  };

  const existing = await Repository.findOne({ fullName: r.fullName }).select('_id group');
  if (existing) {
    await Repository.updateOne({ _id: existing._id }, { $set: setFields });
    return 'updated';
  }

  return 'skipped';
}

async function resolveDefaultGroupIdForCreation(): Promise<Types.ObjectId | null> {
  const configured = config.github.defaultRepoGroupId?.trim();
  if (configured) {
    if (!Types.ObjectId.isValid(configured)) {
      logger.warn(`[SyncGH] GITHUB_DEFAULT_REPO_GROUP_ID invalide (${configured})`);
      return null;
    }
    return new Types.ObjectId(configured);
  }

  const fallbackSlug = 'github-unassigned';
  const group = await Group.findOneAndUpdate(
    { slug: fallbackSlug },
    {
      $setOnInsert: {
        name: 'GitHub Unassigned',
        slug: fallbackSlug,
        category: 'other',
        description: 'Groupe automatique pour les dépôts GitHub non encore rattachés.',
      },
    },
    { upsert: true, new: true }
  ).select('_id slug');

  logger.info('[SyncGH] Groupe fallback actif pour la création des repos', {
    groupId: String(group._id),
    slug: group.slug,
  });
  return group._id as Types.ObjectId;
}

async function main(): Promise<void> {
  const org = config.github.org;
  const enrich =
    process.env.SYNC_GITHUB_ENRICH_PROFILES !== 'false' &&
    process.env.SYNC_GITHUB_ENRICH_PROFILES !== '0';
  const createMissingRepos =
    process.env.SYNC_GITHUB_CREATE_MISSING_REPOS === 'true' ||
    process.env.SYNC_GITHUB_CREATE_MISSING_REPOS === '1';

  await connectDB();
  try {
    logger.info(`[SyncGH] Organisation : ${org}`);
    logger.info(
      createMissingRepos
        ? '[SyncGH] Mode insertion: les dépôts manquants seront créés'
        : '[SyncGH] Mode strict: seuls les dépôts déjà en base seront mis à jour'
    );

    const defaultGroupId = createMissingRepos ? await resolveDefaultGroupIdForCreation() : null;

    try {
      await syncOrgMembers(enrich);
    } catch (err) {
      logger.warn(
        '[SyncGH] Impossible de synchroniser les membres org (GitHub timeout/5xx après retries). Poursuite avec les repos.',
        err instanceof Error ? err : new Error(String(err))
      );
    }

    const allRepos = await githubService.listOrgRepos();
    let archived = 0;
    let updated = 0;
    let inserted = 0;
    let skippedNew = 0;
    const skippedExamples: string[] = [];

    for (const r of allRepos) {
      if (r.isArchived) {
        const ex = await Repository.findOne({ fullName: r.fullName }).select('_id');
        if (ex) {
          await Repository.updateOne(
            { _id: ex._id },
            {
              $set: {
                githubRepoId: r.githubRepoId,
                name: r.name,
                language: r.language ?? undefined,
                defaultBranch: r.defaultBranch,
                isPrivate: r.isPrivate,
                isArchived: true,
                platform: inferPlatform(r.language),
              },
            }
          );
          updated++;
        } else {
          archived++;
        }
        continue;
      }
      const res = await syncRepositoryMetadata(r);
      if (res === 'updated') {
        updated++;
      }
      else {
        if (createMissingRepos && defaultGroupId) {
          await Repository.create({
            fullName: r.fullName,
            githubRepoId: r.githubRepoId,
            name: r.name,
            language: r.language ?? undefined,
            defaultBranch: r.defaultBranch,
            isPrivate: r.isPrivate,
            isArchived: r.isArchived,
            platform: inferPlatform(r.language),
            group: defaultGroupId,
          });
          inserted++;
        } else {
          skippedNew++;
          if (skippedExamples.length < 25) skippedExamples.push(r.fullName);
        }
      }
    }

    const devCount = await Developer.countDocuments({});
    const repoCount = await Repository.countDocuments({});

    if (skippedNew > 0) {
      const extra = skippedNew > skippedExamples.length ? ` (+${skippedNew - skippedExamples.length} autres)` : '';
      logger.warn(
        `[SyncGH] ${skippedNew} nouveau(x) dépôt(s) ignoré(s) (non présents en base). ` +
          `Exemples : ${skippedExamples.join(', ')}${extra}.`
      );
    }

    logger.info('[SyncGH] Terminé', {
      developers: devCount,
      repositories: repoCount,
      reposArchivedNotInDb: archived,
      reposMetadataUpdated: updated,
      reposInserted: inserted,
      reposSkippedNewNotInDb: skippedNew,
    });
  } finally {
    await disconnectDB();
    logger.info('[SyncGH] MongoDB déconnecté');
  }
}

main().catch((err: unknown) => {
  logger.error('[SyncGH] Échec', err instanceof Error ? err : new Error(String(err)));
  process.exitCode = 1;
});
