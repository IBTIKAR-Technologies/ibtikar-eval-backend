/**
 * Import depuis GitHub : membres org → Developers, repos → Repositories + Groups
 * (équipes GitHub si le token le permet, sinon groupes par langage principal).
 *
 * Usage : yarn sync:github
 */
import '../src/config';
import config from '../src/config';
import { Types } from 'mongoose';
import pLimit from 'p-limit';
import { connectDB, disconnectDB } from '../src/config/database';
import { Developer, Group, Repository } from '../src/models';
import githubService from '../src/services/githubService';
import type { OrgRepoInfo } from '../src/services/githubService';
import logger from '../src/utils/logger';
import type { RepoPlatform } from '../src/types';

function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

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

async function upsertGroupTeam(
  org: string,
  slug: string,
  name: string,
  description: string | null
): Promise<Types.ObjectId> {
  const groupSlug = slugify(`gh-team-${org}-${slug}`);
  const groupName = `${name} · ${org}`;
  const doc = await Group.findOneAndUpdate(
    { slug: groupSlug },
    {
      $setOnInsert: {
        name: groupName,
        slug: groupSlug,
        description: description ?? `Équipe GitHub « ${slug} »`,
        category: 'mixed',
        repositories: [],
        leads: [],
        isActive: true,
      },
    },
    { upsert: true, new: true }
  );
  return doc._id;
}

async function upsertGroupLanguage(org: string, languageLabel: string): Promise<Types.ObjectId> {
  const groupSlug = slugify(`gh-lang-${org}-${languageLabel}`);
  const groupName = `Langage — ${languageLabel} · ${org}`;
  const doc = await Group.findOneAndUpdate(
    { slug: groupSlug },
    {
      $setOnInsert: {
        name: groupName,
        slug: groupSlug,
        description: 'Dépôts sans équipe GitHub dédiée (regroupement par langage)',
        category: 'mixed',
        repositories: [],
        leads: [],
        isActive: true,
      },
    },
    { upsert: true, new: true }
  );
  return doc._id;
}

async function syncTeamsAndRepos(
  org: string
): Promise<Map<string, Types.ObjectId>> {
  const repoToGroup = new Map<string, Types.ObjectId>();
  const teams = await githubService.listOrgTeams();

  if (teams.length === 0) {
    logger.info('[SyncGH] Aucune équipe GitHub exploitable — tous les repos iront dans des groupes par langage');
    return repoToGroup;
  }

  logger.info(`[SyncGH] ${teams.length} équipe(s) GitHub`);

  for (const t of teams) {
    let groupId: Types.ObjectId;
    try {
      groupId = await upsertGroupTeam(org, t.slug, t.name, t.description);
    } catch (err) {
      logger.warn(`[SyncGH] Ignorer équipe ${t.slug}`, err);
      continue;
    }

    const teamRepos = await githubService.listTeamRepos(t.slug);
    for (const r of teamRepos) {
      if (!r.isArchived) {
        repoToGroup.set(r.fullName, groupId);
      }
    }

    try {
      const teamMembers = await githubService.listTeamMembers(t.slug);
      for (const mem of teamMembers) {
        await Developer.findOneAndUpdate(
          { githubUsername: mem.login.toLowerCase() },
          {
            $setOnInsert: {
              githubUsername: mem.login.toLowerCase(),
              fullName: mem.login,
              role: 'other',
              joinedAt: new Date(),
              groups: [],
            },
            $addToSet: { groups: groupId },
            $set: { githubUserId: mem.id, isActive: true },
          },
          { upsert: true }
        );
      }
      logger.info(`[SyncGH] Équipe « ${t.name} » : ${teamRepos.length} repo(s), ${teamMembers.length} membre(s)`);
    } catch (err: unknown) {
      const e = err as { status?: number };
      logger.warn(`[SyncGH] Membres équipe ${t.slug} indisponibles (${e.status ?? '?'})`);
    }
  }

  return repoToGroup;
}

async function upsertRepositoryDoc(r: OrgRepoInfo, groupId: Types.ObjectId): Promise<void> {
  await Repository.findOneAndUpdate(
    { fullName: r.fullName },
    {
      $set: {
        githubRepoId: r.githubRepoId,
        name: r.name,
        language: r.language ?? undefined,
        defaultBranch: r.defaultBranch,
        isPrivate: r.isPrivate,
        isArchived: r.isArchived,
        group: groupId,
        platform: inferPlatform(r.language),
      },
      $setOnInsert: {
        fullName: r.fullName,
      },
    },
    { upsert: true }
  );
}

async function rebuildGroupRepositories(): Promise<void> {
  const groups = await Group.find({}).select('_id').lean();
  for (const g of groups) {
    const ids = await Repository.find({ group: g._id }).distinct('_id');
    await Group.updateOne({ _id: g._id }, { $set: { repositories: ids } });
  }
}

async function main(): Promise<void> {
  const org = config.github.org;
  const enrich =
    process.env.SYNC_GITHUB_ENRICH_PROFILES !== 'false' &&
    process.env.SYNC_GITHUB_ENRICH_PROFILES !== '0';

  await connectDB();
  try {
    logger.info(`[SyncGH] Organisation : ${org}`);

    await syncOrgMembers(enrich);

    const repoToGroup = await syncTeamsAndRepos(org);

    const allRepos = await githubService.listOrgRepos();
    let archived = 0;
    let linked = 0;
    let byLang = 0;

    for (const r of allRepos) {
      if (r.isArchived) {
        archived++;
        continue;
      }

      let groupId = repoToGroup.get(r.fullName);
      if (!groupId) {
        const label = r.language ?? 'Autre';
        groupId = await upsertGroupLanguage(org, label);
        byLang++;
      } else {
        linked++;
      }

      await upsertRepositoryDoc(r, groupId);
    }

    await rebuildGroupRepositories();

    const devCount = await Developer.countDocuments({});
    const repoCount = await Repository.countDocuments({});
    const groupCount = await Group.countDocuments({});

    logger.info('[SyncGH] Terminé', {
      developers: devCount,
      repositories: repoCount,
      groups: groupCount,
      reposArchivedSkipped: archived,
      reposViaTeam: linked,
      reposViaLanguageFallback: byLang,
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
