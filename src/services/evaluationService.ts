import pLimit from 'p-limit';
import {
  Developer,
  Repository,
  Commit,
  Evaluation,
  CronRun,
  type IDeveloper,
  type IRepository,
  type ICommit,
  type ICronRun,
} from '../models';
import githubService from './githubService';
import geminiService, { GeminiQuotaBlockedError } from './geminiService';
import config from '../config';
import logger from '../utils/logger';
import type { Period, CronTrigger, DeveloperEvaluationPayload } from '../types';

interface RunOptions {
  periodStart?: Date;
  periodEnd?: Date;
  trigger?: CronTrigger;
}

interface FetchResult {
  total: number;
  saved: number;
}

interface EvalResult {
  evaluated: number;
  created: number;
  errors: Array<{ at: string; message: string }>;
}

class EvaluationService {
  /** Cycle complet : sync repos → fetch commits → évaluations Gemini → save */
  async runFullCycle({ periodStart, periodEnd, trigger = 'schedule' }: RunOptions = {}): Promise<ICronRun> {
    const period = this.resolvePeriod(periodStart, periodEnd);
    const run = await CronRun.create({
      startedAt: new Date(),
      status: 'running',
      periodStart: period.start,
      periodEnd: period.end,
      trigger,
      errorLog: [],
    });

    logger.info(
      `[Cycle] Démarrage — ${period.label} (${period.start.toISOString()} → ${period.end.toISOString()})`
    );

    try {
      const reposScanned = await this.syncOrgRepos();
      run.counters.reposScanned = reposScanned;

      const fetched = await this.fetchPeriodCommits(period);
      run.counters.commitsFetched = fetched.total;
      run.counters.commitsNew = fetched.saved;

      const evalRes = await this.evaluateAllDevelopers(period);
      run.counters.developersEvaluated = evalRes.evaluated;
      run.counters.evaluationsCreated = evalRes.created;
      run.counters.errors = evalRes.errors.length;
      run.errorLog = evalRes.errors;

      run.status = evalRes.errors.length === 0 ? 'success' : 'partial';
      run.finishedAt = new Date();
      await run.save();

      logger.info(`[Cycle] Terminé — ${run.status}`, run.counters);
      return run;
    } catch (err) {
      const e = err as Error;
      logger.error('[Cycle] Échec global', e);
      run.status = 'failed';
      run.finishedAt = new Date();
      run.errorLog.push({ at: 'global', message: e.message });
      await run.save();
      throw err;
    }
  }

  /** Résout la période : par défaut, les 7 derniers jours */
  private resolvePeriod(start?: Date, end?: Date): Period {
    if (start && end) {
      return {
        start: new Date(start),
        end: new Date(end),
        label: `Période ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`,
      };
    }
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setUTCHours(23, 59, 59, 999);
    const periodStart = new Date(periodEnd);
    periodStart.setUTCDate(periodStart.getUTCDate() - 7);
    periodStart.setUTCHours(0, 0, 0, 0);

    const weekNum = this.isoWeek(periodEnd);
    const label = `Semaine ${periodEnd.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    return { start: periodStart, end: periodEnd, label };
  }

  private isoWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  /** 1. Synchronise les repos GitHub → DB (doit être pré-rattachés à un Group) */
  private async syncOrgRepos(): Promise<number> {
    const orgRepos = await githubService.listOrgRepos();
    logger.info(`[Sync] ${orgRepos.length} repos trouvés sur GitHub`);

    let count = 0;
    const notInDb: string[] = [];
    for (const r of orgRepos) {
      if (r.isArchived) continue;

      const existing = await Repository.findOne({ fullName: r.fullName });
      if (!existing) {
        if (notInDb.length < 25) notInDb.push(r.fullName);
        continue;
      }

      existing.githubRepoId = r.githubRepoId;
      existing.name = r.name;
      if (r.language) existing.language = r.language;
      existing.defaultBranch = r.defaultBranch;
      existing.isPrivate = r.isPrivate;
      existing.isArchived = r.isArchived;
      await existing.save();
      count++;
    }

    const skipped = orgRepos.filter((x) => !x.isArchived).length - count;
    if (skipped > 0) {
      const extra = skipped > notInDb.length ? ` (+${skipped - notInDb.length} autres)` : '';
      logger.warn(
        `[Sync] ${skipped} repo(s) GitHub sans entrée en base (non rattachés à un Group). Exemples : ${notInDb.join(', ')}${extra}`
      );
    }
    logger.info(`[Sync] ${count} repos rattachés mis à jour`);
    return count;
  }

  /** 2. Récupère les commits de la période et les matche aux devs */
  private async fetchPeriodCommits(period: Period): Promise<FetchResult> {
    const repos = await Repository.find({ isArchived: false }).populate('group');
    const developers = await Developer.find({ isActive: true });

    const byLogin = new Map<string, IDeveloper>();
    const byEmail = new Map<string, IDeveloper>();
    for (const d of developers) {
      if (d.githubUsername) byLogin.set(d.githubUsername.toLowerCase(), d);
      for (const e of d.githubEmails ?? []) byEmail.set(e.toLowerCase(), d);
    }

    const limit = pLimit(4);
    let totalCommits = 0;
    let newCommits = 0;

    await Promise.all(
      repos.map((repo) =>
        limit(async () => {
          const [owner, name] = repo.fullName.split('/');
          const ghCommits = await githubService.listCommits(
            owner,
            name,
            period.start.toISOString(),
            period.end.toISOString()
          );
          totalCommits += ghCommits.length;

          for (const c of ghCommits) {
            const exists = await Commit.findOne({ sha: c.sha, repository: repo._id });
            if (exists) continue;

            const login = c.author?.login?.toLowerCase();
            const email = c.commit?.author?.email?.toLowerCase();
            const dev =
              (login ? byLogin.get(login) : undefined) ??
              (email ? byEmail.get(email) : undefined) ??
              null;

            let details = null;
            try {
              details = await githubService.getCommitDetails(owner, name, c.sha);
            } catch {
              logger.warn(`[Fetch] Détails indisponibles pour ${c.sha.slice(0, 7)}`);
            }

            const maxPatchSize = Math.floor(
              config.limits.maxDiffChars / config.limits.maxFilesPerCommit
            );
            const files = (details?.files ?? [])
              .slice(0, config.limits.maxFilesPerCommit)
              .map((f) => ({
                filename: f.filename,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                patch: (f.patch ?? '').slice(0, maxPatchSize),
              }));

            await Commit.create({
              sha: c.sha,
              repository: repo._id,
              group: repo.group,
              developer: dev?._id,
              authorName: c.commit?.author?.name,
              authorEmail: email,
              authorGithubLogin: login,
              message: c.commit?.message,
              committedAt: c.commit?.author?.date ? new Date(c.commit.author.date) : undefined,
              url: c.html_url,
              additions: details?.stats?.additions ?? 0,
              deletions: details?.stats?.deletions ?? 0,
              filesChanged: details?.files?.length ?? 0,
              files,
            });
            newCommits++;
          }

          repo.lastScannedAt = new Date();
          if (ghCommits[0]) repo.lastCommitSha = ghCommits[0].sha;
          await repo.save();
        })
      )
    );

    logger.info(`[Fetch] ${totalCommits} commits vus, ${newCommits} nouveaux`);
    return { total: totalCommits, saved: newCommits };
  }

  /** 3. Pour chaque dev actif, agrège ses commits et appelle Gemini */
  private async evaluateAllDevelopers(period: Period): Promise<EvalResult> {
    const developers = await Developer.find({ isActive: true }).populate('groups');
    const errors: Array<{ at: string; message: string }> = [];
    let evaluated = 0;
    let created = 0;

    const concurrency = config.gemini.concurrency;
    const delayMs = config.gemini.delayBetweenEvaluationsMs;
    const limit = pLimit(concurrency);

    logger.info(`[Eval] Gemini concurrence=${concurrency}, pause entre devs=${delayMs}ms`);

    let quotaStopped = false;

    await Promise.all(
      developers.map((dev) =>
        limit(async () => {
          if (quotaStopped) return;
          try {
            const res = await this.evaluateOneDeveloper(dev, period);
            evaluated++;
            if (res.created) created++;
          } catch (err) {
            if (err instanceof GeminiQuotaBlockedError) {
              quotaStopped = true;
              logger.error('[Eval] Arrêt du lot LLM — ', err.message);
              errors.push({ at: '__gemini_quota__', message: err.message });
              return;
            }
            const e = err as Error;
            logger.error(`[Eval] Échec pour ${dev.githubUsername}`, e);
            errors.push({ at: dev.githubUsername, message: e.message });
          } finally {
            if (delayMs > 0 && !quotaStopped) {
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }
        })
      )
    );

    if (quotaStopped) {
      logger.warn('[Eval] Suite au blocage quota Gemini, les développeurs non encore traités ont été ignorés.');
    }

    return { evaluated, created, errors };
  }

  private async evaluateOneDeveloper(
    dev: IDeveloper,
    period: Period
  ): Promise<{ created: boolean }> {
    const existing = await Evaluation.findOne({
      developer: dev._id,
      periodStart: period.start,
      periodEnd: period.end,
    });
    if (existing && existing.status === 'completed') {
      logger.info(`[Eval] ${dev.githubUsername} déjà évalué pour ${period.label}`);
      return { created: false };
    }

    const commits = await Commit.find({
      developer: dev._id,
      committedAt: { $gte: period.start, $lte: period.end },
    })
      .populate<{ repository: IRepository & { group: { name: string } } }>({
        path: 'repository',
        populate: { path: 'group' },
      })
      .sort({ committedAt: 1 })
      .limit(config.limits.maxCommitsPerDev);

    if (commits.length === 0) {
      await Evaluation.findOneAndUpdate(
        { developer: dev._id, periodStart: period.start, periodEnd: period.end },
        {
          developer: dev._id,
          periodStart: period.start,
          periodEnd: period.end,
          periodLabel: period.label,
          status: 'skipped',
          stats: { commitsCount: 0 },
          analysis: { summary: 'Aucun commit sur la période.', strengths: [], weaknesses: [], recommendations: [], notableCommits: [] },
          proposal: { type: 'none', title: 'Aucune action', priority: 'low' },
        },
        { upsert: true, new: true }
      );
      return { created: true };
    }

    const stats = this.aggregateStats(commits as unknown as ICommit[]);
    const groupNames = Array.from(
      new Set(
        commits
          .map((c) => (c.repository as unknown as { group?: { name?: string } })?.group?.name)
          .filter((n): n is string => !!n)
      )
    );

    const payload: DeveloperEvaluationPayload = {
      developer: {
        fullName: dev.fullName,
        githubUsername: dev.githubUsername,
        role: dev.role,
      },
      period,
      stats: { ...stats, groupNames },
      commits: commits.map((c) => ({
        sha: c.sha,
        message: c.message ?? '',
        committedAt: c.committedAt?.toISOString(),
        additions: c.additions,
        deletions: c.deletions,
        filesChanged: c.filesChanged,
        files: c.files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? '',
        })),
        repoFullName: (c.repository as unknown as IRepository)?.fullName,
        repoPlatform: (c.repository as unknown as IRepository)?.platform,
      })),
    };

    const llm = await geminiService.evaluateDeveloper(payload);

    await Evaluation.findOneAndUpdate(
      { developer: dev._id, periodStart: period.start, periodEnd: period.end },
      {
        developer: dev._id,
        periodStart: period.start,
        periodEnd: period.end,
        periodLabel: period.label,
        groups: Array.from(
          new Set(commits.map((c) => String(c.group)).filter(Boolean))
        ),
        repositories: Array.from(
          new Set(commits.map((c) => String((c.repository as unknown as IRepository)?._id)).filter(Boolean))
        ),
        commits: commits.map((c) => c._id),
        stats,
        scores: llm.scores,
        analysis: llm.analysis,
        proposal: llm.proposal,
        model: llm._meta.model,
        tokensUsed: llm._meta.tokensUsed,
        status: 'completed',
      },
      { upsert: true, new: true }
    );

    await Commit.updateMany(
      { _id: { $in: commits.map((c) => c._id) } },
      { analyzed: true, analyzedAt: new Date() }
    );

    return { created: true };
  }

  private aggregateStats(commits: ICommit[]) {
    const days = new Set<string>();
    const languages = new Set<string>();
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    for (const c of commits) {
      additions += c.additions ?? 0;
      deletions += c.deletions ?? 0;
      filesChanged += c.filesChanged ?? 0;
      if (c.committedAt) days.add(c.committedAt.toISOString().slice(0, 10));
      const lang = (c.repository as unknown as IRepository)?.language;
      if (lang) languages.add(lang);
    }

    return {
      commitsCount: commits.length,
      additions,
      deletions,
      filesChanged,
      activeDays: days.size,
      languages: Array.from(languages),
    };
  }
}

export const evaluationService = new EvaluationService();
export default evaluationService;
