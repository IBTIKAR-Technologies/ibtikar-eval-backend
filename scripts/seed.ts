import '../src/config';
import config from '../src/config';
import { Types } from 'mongoose';
import { connectDB, disconnectDB } from '../src/config/database';
import { Developer, Group, Repository } from '../src/models';
import logger from '../src/utils/logger';

/** Slugs de repos réels sous `GITHUB_ORG` (override possible via variables d'environnement). */
function repoSlug(envKey: string, fallback: string): string {
  return (process.env[envKey] ?? fallback).trim();
}

interface SeedGroupDef {
  name: string;
  slug: string;
  description: string;
  category: 'web' | 'mobile' | 'api' | 'mixed';
  repos: Array<{ fullName: string; platform: 'web' | 'mobile' | 'backend' | 'api' | 'other' }>;
}

interface SeedDevDef {
  fullName: string;
  githubUsername: string;
  email: string;
  role: 'frontend' | 'backend' | 'fullstack' | 'mobile' | 'lead';
  groupSlugs: string[];
}

function buildGroups(org: string): SeedGroupDef[] {
  const o = org.trim();
  return [
    {
      name: 'Mahaba',
      slug: 'mahaba',
      description: 'Produits web et mobile Mahaba',
      category: 'mixed',
      repos: [
        {
          fullName: `${o}/${repoSlug('SEED_REPO_MAHABA_WEB', 'guarrini-fe')}`,
          platform: 'web',
        },
        {
          fullName: `${o}/${repoSlug('SEED_REPO_MAHABA_MOBILE', 'guarrini-player')}`,
          platform: 'mobile',
        },
      ],
    },
    {
      name: 'Tawakel',
      slug: 'tawakel',
      description: 'API et services Tawakel',
      category: 'api',
      repos: [
        {
          fullName: `${o}/${repoSlug('SEED_REPO_TAWAKEL_API', 'guarrini-be')}`,
          platform: 'api',
        },
      ],
    },
    {
      name: 'Plateforme interne',
      slug: 'plateforme-interne',
      description: 'Outils internes et automatisations',
      category: 'mixed',
      repos: [
        {
          fullName: `${o}/${repoSlug('SEED_REPO_INTERNAL', 'onboarding')}`,
          platform: 'other',
        },
      ],
    },
  ];
}

const DEVELOPERS: SeedDevDef[] = [
  {
    fullName: 'Ahmed El Mansour',
    githubUsername: 'ahmed-dev',
    email: 'ahmed.dev@example.com',
    role: 'fullstack',
    groupSlugs: ['mahaba', 'tawakel'],
  },
  {
    fullName: 'Fatima Sidi',
    githubUsername: 'fatima-code',
    email: 'fatima.code@example.com',
    role: 'frontend',
    groupSlugs: ['mahaba'],
  },
  {
    fullName: 'Moussa Diop',
    githubUsername: 'moussa-backend',
    email: 'moussa.backend@example.com',
    role: 'backend',
    groupSlugs: ['tawakel'],
  },
  {
    fullName: 'Aicha Kane',
    githubUsername: 'aicha-mobile',
    email: 'aicha.mobile@example.com',
    role: 'mobile',
    groupSlugs: ['mahaba'],
  },
  {
    fullName: 'Oumar Ba',
    githubUsername: 'oumar-lead',
    email: 'oumar.lead@example.com',
    role: 'lead',
    groupSlugs: ['mahaba', 'plateforme-interne'],
  },
];

async function upsertGroup(def: SeedGroupDef): Promise<Types.ObjectId> {
  const group = await Group.findOneAndUpdate(
    { slug: def.slug },
    {
      $setOnInsert: {
        name: def.name,
        slug: def.slug,
        description: def.description,
        category: def.category,
        repositories: [],
        leads: [],
        isActive: true,
      },
    },
    { upsert: true, new: true }
  );
  return group._id;
}

async function ensureRepositories(groupId: Types.ObjectId, def: SeedGroupDef): Promise<void> {
  const group = await Group.findById(groupId);
  if (!group) return;

  const repoIds: Types.ObjectId[] = [];
  for (const r of def.repos) {
    const repo = await Repository.findOneAndUpdate(
      { fullName: r.fullName },
      {
        $setOnInsert: {
          fullName: r.fullName,
          name: r.fullName.split('/').pop() ?? r.fullName,
          platform: r.platform,
          group: groupId,
          defaultBranch: 'main',
          isPrivate: true,
          isArchived: false,
        },
      },
      { upsert: true, new: true }
    );
    repoIds.push(repo._id);
  }

  const existingIds = (group.repositories ?? []).map(String);
  const merged = Array.from(new Set([...existingIds, ...repoIds.map(String)])).map(
    (id) => new Types.ObjectId(id)
  );
  group.repositories = merged;
  await group.save();
}

async function upsertDeveloper(def: SeedDevDef, slugToGroupId: Map<string, Types.ObjectId>): Promise<void> {
  const groupIds = def.groupSlugs.map((s) => slugToGroupId.get(s)).filter((id): id is Types.ObjectId => !!id);

  await Developer.findOneAndUpdate(
    { githubUsername: def.githubUsername.toLowerCase() },
    {
      $set: {
        fullName: def.fullName,
        email: def.email,
        role: def.role,
        githubEmails: [def.email],
        groups: groupIds,
        isActive: true,
      },
      $setOnInsert: {
        githubUsername: def.githubUsername.toLowerCase(),
        joinedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

async function main(): Promise<void> {
  await connectDB();
  try {
    const org = config.github.org;
    const GROUPS = buildGroups(org);
    logger.info(`[Seed] Organisation GitHub : ${org}`);

    const slugToGroupId = new Map<string, Types.ObjectId>();

    for (const g of GROUPS) {
      const id = await upsertGroup(g);
      slugToGroupId.set(g.slug, id);
      await ensureRepositories(id, g);
      logger.info(`[Seed] Groupe prêt : ${g.slug}`);
    }

    for (const d of DEVELOPERS) {
      await upsertDeveloper(d, slugToGroupId);
      logger.info(`[Seed] Développeur prêt : ${d.githubUsername}`);
    }

    logger.info('[Seed] Terminé (idempotent)');
  } finally {
    await disconnectDB();
  }
}

main().catch((err: unknown) => {
  logger.error('[Seed] Échec', err instanceof Error ? err : new Error(String(err)));
  process.exitCode = 1;
});
