import { Router } from 'express';
import { Types } from 'mongoose';
import { CronRun } from '../models';
import config from '../config';
import asyncHandler from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';
import { runSafely } from '../jobs/evaluationCron';

const router = Router();

function paramString(v: string | string[] | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

function parsePagination(req: { query: Record<string, unknown> }): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limitRaw = parseInt(String(req.query.limit ?? '20'), 10) || 20;
  const limit = Math.min(100, Math.max(1, limitRaw));
  return { page, limit };
}

/** Estimation du prochain lundi 02:00 UTC (équivalent Africa/Nouakchott sans DST) */
function nextMondayTwoUtc(from: Date = new Date()): Date {
  const base = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const dow = from.getUTCDay();
  const minutesIntoDay = from.getUTCHours() * 60 + from.getUTCMinutes();
  const mondayTwoAm = 2 * 60;
  let addDays = (1 - dow + 7) % 7;
  if (addDays === 0 && minutesIntoDay >= mondayTwoAm) {
    addDays = 7;
  }
  base.setUTCDate(base.getUTCDate() + addDays);
  base.setUTCHours(2, 0, 0, 0);
  return base;
}

router.post(
  '/trigger',
  asyncHandler(async (_req, res) => {
    void runSafely('manual');
    res.status(202).json({
      data: {
        accepted: true,
        message: 'Cycle de démarré en arrière-plan',
      },
    });
  })
);

router.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req);
    const skip = (page - 1) * limit;
    const [total, data] = await Promise.all([
      CronRun.countDocuments({}),
      CronRun.find({}).sort({ startedAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    res.json({ data, pagination: { page, limit, total } });
  })
);

router.get(
  '/runs/:id',
  asyncHandler(async (req, res) => {
    const id = paramString(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      throw new HttpError(400, 'Identifiant invalide');
    }
    const run = await CronRun.findById(id).lean();
    if (!run) {
      throw new HttpError(404, 'Exécution introuvable');
    }
    res.json({ data: run });
  })
);

router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const lastRun = await CronRun.findOne({}).sort({ startedAt: -1 }).lean();
    const nextRunAt =
      config.cron.schedule === '0 2 * * 1' && config.cron.timezone === 'Africa/Nouakchott'
        ? nextMondayTwoUtc()
        : null;

    res.json({
      data: {
        lastRun,
        schedule: config.cron.schedule,
        timezone: config.cron.timezone,
        nextRunAt,
        nextRunNote:
          nextRunAt === null
            ? 'Estimation disponible uniquement pour schedule=0 2 * * 1 et timezone=Africa/Nouakchott'
            : 'Prochaine exécution estimée (lundi 02:00 UTC = Nouakchott)',
      },
    });
  })
);

export default router;
