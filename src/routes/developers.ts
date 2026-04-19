import { Router } from 'express';
import { Types } from 'mongoose';
import { Developer, Evaluation } from '../models';
import type { DeveloperRole } from '../types';
import asyncHandler from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';

const router = Router();

function paramString(v: string | string[] | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

const ROLES: readonly DeveloperRole[] = [
  'frontend',
  'backend',
  'fullstack',
  'mobile',
  'devops',
  'lead',
  'qa',
  'other',
];

function isDeveloperRole(v: string): v is DeveloperRole {
  return (ROLES as readonly string[]).includes(v);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = {};

    if (typeof req.query.active === 'string') {
      if (req.query.active === 'true') filter.isActive = true;
      else if (req.query.active === 'false') filter.isActive = false;
    }
    if (typeof req.query.role === 'string' && isDeveloperRole(req.query.role)) {
      filter.role = req.query.role;
    }
    if (typeof req.query.group === 'string' && Types.ObjectId.isValid(req.query.group)) {
      filter.groups = new Types.ObjectId(req.query.group);
    }
    if (typeof req.query.q === 'string' && req.query.q.trim()) {
      const rx = new RegExp(escapeRegex(req.query.q.trim()), 'i');
      filter.$or = [{ fullName: rx }, { email: rx }, { githubUsername: rx }];
    }

    const data = await Developer.find(filter).populate('groups').sort({ fullName: 1 }).lean();
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
    const developer = await Developer.findById(id).populate('groups').lean();
    if (!developer) {
      throw new HttpError(404, 'Développeur introuvable');
    }
    const evaluations = await Evaluation.find({ developer: developer._id })
      .sort({ periodEnd: -1 })
      .limit(12)
      .lean();
    res.json({ data: { developer, evaluations } });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    const githubUsername = typeof body.githubUsername === 'string' ? body.githubUsername.trim() : '';
    if (!fullName || !githubUsername) {
      throw new HttpError(400, 'fullName et githubUsername sont requis');
    }
    const role =
      typeof body.role === 'string' && isDeveloperRole(body.role) ? body.role : ('other' as DeveloperRole);

    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined;
    const department = typeof body.department === 'string' ? body.department.trim() : undefined;
    const githubEmails = Array.isArray(body.githubEmails)
      ? (body.githubEmails as unknown[])
          .filter((e): e is string => typeof e === 'string')
          .map((e) => e.toLowerCase())
      : [];

    let groups: Types.ObjectId[] = [];
    if (Array.isArray(body.groups)) {
      groups = (body.groups as unknown[])
        .filter((g): g is string => typeof g === 'string' && Types.ObjectId.isValid(g))
        .map((g) => new Types.ObjectId(g));
    }

    const dup = await Developer.findOne({ githubUsername: githubUsername.toLowerCase() }).lean();
    if (dup) {
      throw new HttpError(409, 'Ce githubUsername existe déjà');
    }

    const created = await Developer.create({
      fullName,
      githubUsername: githubUsername.toLowerCase(),
      email: email || undefined,
      role,
      department,
      githubEmails,
      groups,
      isActive: body.isActive === false ? false : true,
    });
    const populated = await Developer.findById(created._id).populate('groups').lean();
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

    if (typeof body.fullName === 'string') patch.fullName = body.fullName.trim();
    if (typeof body.email === 'string') patch.email = body.email.trim().toLowerCase();
    if (typeof body.department === 'string') patch.department = body.department.trim();
    if (typeof body.role === 'string') {
      if (!isDeveloperRole(body.role)) throw new HttpError(400, 'Rôle invalide');
      patch.role = body.role;
    }
    if (typeof body.githubUsername === 'string') {
      const u = body.githubUsername.trim().toLowerCase();
      const other = await Developer.findOne({ githubUsername: u, _id: { $ne: id } }).lean();
      if (other) throw new HttpError(409, 'Ce githubUsername existe déjà');
      patch.githubUsername = u;
    }
    if (Array.isArray(body.githubEmails)) {
      patch.githubEmails = (body.githubEmails as unknown[])
        .filter((e): e is string => typeof e === 'string')
        .map((e) => e.toLowerCase());
    }
    if (Array.isArray(body.groups)) {
      patch.groups = (body.groups as unknown[])
        .filter((g): g is string => typeof g === 'string' && Types.ObjectId.isValid(g))
        .map((g) => new Types.ObjectId(g));
    }
    if (typeof body.isActive === 'boolean') patch.isActive = body.isActive;

    const updated = await Developer.findByIdAndUpdate(id, patch, { new: true })
      .populate('groups')
      .lean();
    if (!updated) {
      throw new HttpError(404, 'Développeur introuvable');
    }
    res.json({ data: updated });
  })
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = paramString(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      throw new HttpError(400, 'Identifiant invalide');
    }
    const updated = await Developer.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    )
      .populate('groups')
      .lean();
    if (!updated) {
      throw new HttpError(404, 'Développeur introuvable');
    }
    res.json({ data: updated });
  })
);

export default router;
