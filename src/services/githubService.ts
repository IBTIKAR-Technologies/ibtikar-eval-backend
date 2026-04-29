import { Octokit } from '@octokit/rest';
import config from '../config';
import logger from '../utils/logger';

export interface OrgRepoInfo {
  githubRepoId: number;
  fullName: string;
  name: string;
  language: string | null;
  defaultBranch: string;
  isPrivate: boolean;
  isArchived: boolean;
}

export interface OrgTeamSummary {
  slug: string;
  name: string;
  description: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isTransientGithubError(err: unknown): boolean {
  const e = err as { status?: number; message?: string; cause?: { code?: string } };
  const status = typeof e.status === 'number' ? e.status : 0;
  if (status === 429 || status === 408) return true;
  if (status >= 500 && status < 600) return true;
  const msg = `${e.message ?? ''} ${(e.cause as { message?: string })?.message ?? ''}`.toLowerCase();
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('eai_again') ||
    msg.includes('socket') ||
    msg.includes('network')
  ) {
    return true;
  }
  const code = e.cause?.code;
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
  return false;
}

class GitHubService {
  private octokit: Octokit;
  public readonly org: string;
  private readonly requestMaxRetries: number;

  constructor() {
    this.requestMaxRetries = config.github.requestMaxRetries;
    this.octokit = new Octokit({
      auth: config.github.token,
      userAgent: 'ibtikar-eval-backend/1.0',
      request: {
        timeout: config.github.requestTimeoutMs,
      },
    });
    this.org = config.github.org;
  }

  /** Retries avec backoff pour erreurs réseau / 5xx / 429 GitHub. */
  private async withGithubRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.requestMaxRetries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const canRetry = attempt < this.requestMaxRetries && isTransientGithubError(err);
        if (!canRetry) throw err;
        const backoffMs = Math.min(30_000, 1500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
        logger.warn(
          `[GitHub] ${label} échec (tentative ${attempt}/${this.requestMaxRetries}) → nouvel essai dans ${backoffMs}ms`
        );
        await sleep(backoffMs);
      }
    }
    throw lastErr;
  }

  /** Liste tous les repos de l'organisation (paginé) */
  async listOrgRepos(): Promise<OrgRepoInfo[]> {
    logger.info(`[GitHub] Liste des repos de l'org ${this.org}`);
    const repos = await this.withGithubRetry('listOrgRepos', () =>
      this.octokit.paginate(this.octokit.rest.repos.listForOrg, {
        org: this.org,
        per_page: 100,
        type: 'all',
      })
    );
    return repos.map((r) => ({
      githubRepoId: r.id,
      fullName: r.full_name,
      name: r.name,
      language: r.language ?? null,
      defaultBranch: r.default_branch ?? 'main',
      isPrivate: r.private,
      isArchived: r.archived ?? false,
    }));
  }

  /** Récupère les commits d'un repo entre deux dates ISO */
  async listCommits(owner: string, repo: string, since: string, until: string, author?: string) {
    try {
      return await this.octokit.paginate(this.octokit.rest.repos.listCommits, {
        owner,
        repo,
        since,
        until,
        author,
        per_page: 100,
      });
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 409 || e.status === 404) {
        logger.warn(`[GitHub] Repo ${owner}/${repo} inaccessible (${e.status})`);
        return [];
      }
      throw err;
    }
  }

  /** Détails d'un commit (fichiers + patch) */
  async getCommitDetails(owner: string, repo: string, sha: string) {
    const { data } = await this.octokit.rest.repos.getCommit({ owner, repo, ref: sha });
    return data;
  }

  /** Membres de l'organisation (login + id ; pas les détails profil). */
  async listOrgMembers(): Promise<Array<{ login: string; id: number }>> {
    const members = await this.withGithubRetry('listOrgMembers', () =>
      this.octokit.paginate(this.octokit.rest.orgs.listMembers, {
        org: this.org,
        per_page: 100,
      })
    );
    return members.map((m) => ({ login: m.login, id: m.id }));
  }

  /** Équipes GitHub de l'org (nécessite un token avec accès lecture équipes). */
  async listOrgTeams(): Promise<OrgTeamSummary[]> {
    try {
      const teams = await this.withGithubRetry('listOrgTeams', () =>
        this.octokit.paginate(this.octokit.rest.teams.list, {
          org: this.org,
          per_page: 100,
        })
      );
      return teams.map((t) => ({
        slug: t.slug,
        name: t.name,
        description: t.description ?? null,
      }));
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 403 || e.status === 404) {
        logger.warn(
          `[GitHub] Impossible de lister les équipes (403/404) — regroupement par langage uniquement`
        );
        return [];
      }
      throw err;
    }
  }

  /** Dépôts rattachés à une équipe (slug). */
  async listTeamRepos(teamSlug: string): Promise<OrgRepoInfo[]> {
    const repos = await this.withGithubRetry(`listTeamRepos(${teamSlug})`, () =>
      this.octokit.paginate(this.octokit.rest.teams.listReposInOrg, {
        org: this.org,
        team_slug: teamSlug,
        per_page: 100,
      })
    );
    return repos.map((r) => ({
      githubRepoId: r.id,
      fullName: r.full_name,
      name: r.name,
      language: r.language ?? null,
      defaultBranch: r.default_branch ?? 'main',
      isPrivate: r.private,
      isArchived: r.archived ?? false,
    }));
  }

  /** Membres d'une équipe (login + id). */
  async listTeamMembers(teamSlug: string): Promise<Array<{ login: string; id: number }>> {
    const members = await this.withGithubRetry(`listTeamMembers(${teamSlug})`, () =>
      this.octokit.paginate(this.octokit.rest.teams.listMembersInOrg, {
        org: this.org,
        team_slug: teamSlug,
        per_page: 100,
      })
    );
    return members.map((m) => ({ login: m.login, id: m.id }));
  }

  /** Info d'un user GitHub par username */
  async getUser(username: string) {
    const { data } = await this.withGithubRetry(`getUser(${username})`, () =>
      this.octokit.rest.users.getByUsername({ username })
    );
    return data;
  }

  /**
   * Nombre de clones d'un repo sur les 14 derniers jours (nécessite accès push).
   * Retourne 0 si le token n'a pas les droits ou si le repo est inaccessible.
   */
  async getRepoClones(owner: string, repo: string): Promise<number> {
    try {
      const { data } = await this.octokit.rest.repos.getClones({ owner, repo, per: 'week' });
      return data.count;
    } catch {
      return 0;
    }
  }

  /**
   * Nombre de PRs ouvertes/fusionnées par un développeur dans l'org sur une période.
   * Utilise l'API Search GitHub.
   */
  async getDeveloperPullRequestsCount(username: string, since: string, until: string): Promise<number> {
    try {
      const sinceDate = since.slice(0, 10);
      const untilDate = until.slice(0, 10);
      const q = `author:${username} type:pr org:${this.org} created:${sinceDate}..${untilDate}`;
      const { data } = await this.octokit.request('GET /search/issues', { q, per_page: 1 });
      return data.total_count;
    } catch {
      return 0;
    }
  }
}

export const githubService = new GitHubService();
export default githubService;
