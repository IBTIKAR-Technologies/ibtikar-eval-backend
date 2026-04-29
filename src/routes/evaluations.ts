import { Router } from 'express';
import { Types } from 'mongoose';
import { Evaluation, Developer } from '../models';
import type { EvaluationStatus, ProposalType, EvaluationPeriodType } from '../types';
import asyncHandler from '../middleware/asyncHandler';
import { HttpError } from '../middleware/errorHandler';

const router = Router();

function paramString(v: string | string[] | undefined): string {
  if (v === undefined) return '';
  return Array.isArray(v) ? (v[0] ?? '') : v;
}

const STATUSES: readonly EvaluationStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'skipped'];

const PROPOSALS: readonly ProposalType[] = [
  'promotion',
  'bonus',
  'training',
  'mentoring',
  'recognition',
  'warning',
  'none',
];
const PERIOD_TYPES: readonly EvaluationPeriodType[] = ['week', 'month', 'quarter'];

function isEvaluationStatus(v: string): v is EvaluationStatus {
  return (STATUSES as readonly string[]).includes(v);
}

function isProposalType(v: string): v is ProposalType {
  return (PROPOSALS as readonly string[]).includes(v);
}

function isPeriodType(v: string): v is EvaluationPeriodType {
  return (PERIOD_TYPES as readonly string[]).includes(v);
}

function parsePagination(req: { query: Record<string, unknown> }): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const limitRaw = parseInt(String(req.query.limit ?? '20'), 10) || 20;
  const limit = Math.min(100, Math.max(1, limitRaw));
  return { page, limit };
}

router.get(
  '/stats/overview',
  asyncHandler(async (_req, res) => {
    const latest = await Evaluation.findOne({ status: 'completed' }).sort({ periodEnd: -1 }).lean();
    if (!latest) {
      res.json({
        data: {
          period: null,
          averageOverall: null,
          evaluationsCount: 0,
          proposalDistribution: {},
          topDevelopers: [],
        },
      });
      return;
    }

    const periodStart = latest.periodStart;
    const periodEnd = latest.periodEnd;

    const list = await Evaluation.find({
      periodStart,
      periodEnd,
      status: 'completed',
    })
      .populate<{ developer: { fullName: string; githubUsername: string } }>('developer', 'fullName githubUsername')
      .lean();

    const scores = list.map((e) => e.scores?.overall).filter((n): n is number => typeof n === 'number');
    const averageOverall =
      scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null;

    const proposalDistribution: Record<string, number> = {};
    for (const e of list) {
      const t = e.proposal?.type ?? 'none';
      proposalDistribution[t] = (proposalDistribution[t] ?? 0) + 1;
    }

    const withOverall = list
      .map((e) => {
        const dev = e.developer as unknown;
        const developerId =
          dev && typeof dev === 'object' && '_id' in dev
            ? String((dev as { _id: Types.ObjectId })._id)
            : String(e.developer);
        const fullName =
          dev && typeof dev === 'object' && 'fullName' in dev
            ? String((dev as { fullName?: string }).fullName ?? '')
            : undefined;
        const githubUsername =
          dev && typeof dev === 'object' && 'githubUsername' in dev
            ? String((dev as { githubUsername?: string }).githubUsername ?? '')
            : undefined;
        return {
          evaluationId: String(e._id),
          developerId,
          fullName,
          githubUsername,
          scores: e.scores,
          githubAudit: e.githubAudit ?? null,
          overall: e.scores?.overall ?? 0,
        };
      })
      .sort((a, b) => b.overall - a.overall)
      .slice(0, 5);

    res.json({
      data: {
        period: {
          periodStart,
          periodEnd,
          label: latest.periodLabel,
          periodType: latest.periodType ?? 'week',
        },
        averageOverall,
        evaluationsCount: list.length,
        proposalDistribution,
        topDevelopers: withOverall,
      },
    });
  })
);

router.get(
  '/developer/:developerId/timeline',
  asyncHandler(async (req, res) => {
    const developerId = paramString(req.params.developerId);
    if (!Types.ObjectId.isValid(developerId)) {
      throw new HttpError(400, 'Identifiant développeur invalide');
    }
    const exists = await Developer.exists({ _id: developerId });
    if (!exists) {
      throw new HttpError(404, 'Développeur introuvable');
    }

    const items = await Evaluation.find({ developer: developerId })
      .sort({ periodEnd: -1 })
      .limit(12)
      .select(
        'periodStart periodEnd periodLabel periodType scores githubAudit proposal status stats createdAt updatedAt'
      )
      .lean();

    const series = items
      .slice()
      .reverse()
      .map((e) => ({
        id: String(e._id),
        periodStart: e.periodStart,
        periodEnd: e.periodEnd,
        periodLabel: e.periodLabel,
        periodType: e.periodType ?? 'week',
        stats: e.stats,
        scores: e.scores,
        githubAudit: e.githubAudit ?? null,
        proposal: e.proposal,
        status: e.status,
      }));

    res.json({ data: { series } });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req);
    const filter: Record<string, unknown> = {};

    if (typeof req.query.developer === 'string' && Types.ObjectId.isValid(req.query.developer)) {
      filter.developer = new Types.ObjectId(req.query.developer);
    }
    if (typeof req.query.group === 'string' && Types.ObjectId.isValid(req.query.group)) {
      filter.groups = new Types.ObjectId(req.query.group);
    }
    if (typeof req.query.periodStart === 'string' && !Number.isNaN(Date.parse(req.query.periodStart))) {
      filter.periodStart = { $gte: new Date(req.query.periodStart) };
    }
    if (typeof req.query.periodEnd === 'string' && !Number.isNaN(Date.parse(req.query.periodEnd))) {
      filter.periodEnd = { $lte: new Date(req.query.periodEnd) };
    }
    if (typeof req.query.periodType === 'string' && isPeriodType(req.query.periodType)) {
      filter.periodType = req.query.periodType;
    }
    if (typeof req.query.minScore === 'string') {
      const n = Number(req.query.minScore);
      if (!Number.isNaN(n)) {
        filter['scores.overall'] = { $gte: n };
      }
    }
    if (typeof req.query.proposalType === 'string' && isProposalType(req.query.proposalType)) {
      filter['proposal.type'] = req.query.proposalType;
    }
    if (typeof req.query.status === 'string' && isEvaluationStatus(req.query.status)) {
      filter.status = req.query.status;
    }

    const skip = (page - 1) * limit;
    const [total, data] = await Promise.all([
      Evaluation.countDocuments(filter),
      Evaluation.find(filter).sort({ periodEnd: -1 }).skip(skip).limit(limit).lean(),
    ]);

    res.json({
      data,
      pagination: { page, limit, total },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = paramString(req.params.id);
    if (!Types.ObjectId.isValid(id)) {
      throw new HttpError(400, 'Identifiant invalide');
    }
    const evaluation = await Evaluation.findById(id)
      .populate('developer')
      .populate('groups')
      .populate('repositories')
      .populate({ path: 'commits', options: { limit: 20, sort: { committedAt: -1 } } })
      .lean();

    if (!evaluation) {
      throw new HttpError(404, 'Évaluation introuvable');
    }
    res.json({ data: evaluation });
  })
);

export default router;
