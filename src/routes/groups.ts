import { Router } from 'express';
import { Types } from 'mongoose';
import { Group, Repository } from '../models';
import type { GroupCategory, RepoPlatform } from '../types';
import asyncHandler from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';

const router = Router();

function paramString(v: string | string[] | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

const CATEGORIES: readonly GroupCategory[] = [
  'web',
  'mobile',
  'fullstack',
  'api',
  'mixed',
  'internal',
  'other',
];

const PLATFORMS: readonly RepoPlatform[] = [
  'web',
  'mobile',
  'backend',
  'api',
  'library',
  'infra',
  'other',
];

function isGroupCategory(v: string): v is GroupCategory {
  return (CATEGORIES as readonly string[]).includes(v);
}

function isRepoPlatform(v: string): v is RepoPlatform {
  return (PLATFORMS as readonly string[]).includes(v);
}

function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const data = await Group.find({}).populate('repositories').populate('leads').sort({ name: 1 }).lean();
    res.json({ data });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = paramString(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      throw new HttpError(400, 'Identifiant invalide');
    }
    const group = await Group.findById(id).populate('repositories').populate('leads').lean();
    if (!group) {
      throw new HttpError(404, 'Groupe introuvable');
    }
    res.json({ data: group });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      throw new HttpError(400, 'name est requis');
    }
    let slug =
      typeof body.slug === 'string' && body.slug.trim() ? slugify(body.slug.trim()) : slugify(name);
    if (!slug) {
      throw new HttpError(400, 'Impossible de générer un slug valide');
    }

    const category =
      typeof body.category === 'string' && isGroupCategory(body.category)
        ? body.category
        : ('mixed' as GroupCategory);

    const description = typeof body.description === 'string' ? body.description.trim() : undefined;
    const client = typeof body.client === 'string' ? body.client.trim() : undefined;

    let leads: Types.ObjectId[] = [];
    if (Array.isArray(body.leads)) {
      leads = (body.leads as unknown[])
        .filter((id): id is string => typeof id === 'string' && Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
    }

    const existingSlug = await Group.findOne({ slug }).lean();
    if (existingSlug) {
      throw new HttpError(409, 'Ce slug existe déjà');
    }
    const existingName = await Group.findOne({ name }).lean();
    if (existingName) {
      throw new HttpError(409, 'Ce nom de groupe existe déjà');
    }

    const created = await Group.create({
      name,
      slug,
      description,
      client,
      category,
      leads,
      repositories: [],
      isActive: body.isActive === false ? false : true,
    });
    const populated = await Group.findById(created._id).populate('repositories').populate('leads').lean();
    res.status(201).json({ data: populated });
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = paramString(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      throw new HttpError(400, 'Identifiant invalide');
    }
    const body = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};

    if (typeof body.name === 'string') patch.name = body.name.trim();
    if (typeof body.slug === 'string' && body.slug.trim()) patch.slug = slugify(body.slug.trim());
    if (typeof body.description === 'string') patch.description = body.description.trim();
    if (typeof body.client === 'string') patch.client = body.client.trim();
    if (typeof body.category === 'string') {
      if (!isGroupCategory(body.category)) throw new HttpError(400, 'Catégorie invalide');
      patch.category = body.category;
    }
    if (Array.isArray(body.leads)) {
      patch.leads = (body.leads as unknown[])
        .filter((id): id is string => typeof id === 'string' && Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
    }
    if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;

    const updated = await Group.findByIdAndUpdate(id, patch, { new: true })
      .populate('repositories')
      .populate('leads')
      .lean();
    if (!updated) {
      throw new HttpError(404, 'Groupe introuvable');
    }
    res.json({ data: updated });
  })
);

router.post(
  '/:id/repositories',
  asyncHandler(async (req, res) => {
    const id = paramString(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      throw new HttpError(400, 'Identifiant invalide');
    }
    const group = await Group.findById(id);
    if (!group) {
      throw new HttpError(404, 'Groupe introuvable');
    }

    const body = req.body as Record<string, unknown>;
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const platform =
      typeof body.platform === 'string' && isRepoPlatform(body.platform)
        ? body.platform
        : ('other' as RepoPlatform);

    if (!fullName || !fullName.includes('/')) {
      throw new HttpError(400, 'fullName doit être au format owner/repo');
    }

    const name = fullName.split('/').pop() ?? fullName;

    let repo = await Repository.findOne({ fullName });
    if (!repo) {
      repo = await Repository.create({
        fullName,
        name,
        platform,
        group: group._id,
      });
    } else {
      if (String(repo.group) !== String(group._id)) {
        throw new HttpError(409, 'Ce dépôt est déjà rattaché à un autre groupe');
      }
    }

    const idStr = String(repo._id);
    if (!group.repositories.map(String).includes(idStr)) {
      group.repositories.push(repo._id);
      await group.save();
    }

    const populated = await Group.findById(group._id).populate('repositories').populate('leads').lean();
    res.status(201).json({ data: populated });
  })
);

export default router;
