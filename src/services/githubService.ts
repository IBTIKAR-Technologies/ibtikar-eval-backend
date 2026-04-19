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

class GitHubService {
  private octokit: Octokit;
  public readonly org: string;

  constructor() {
    this.octokit = new Octokit({
      auth: config.github.token,
      userAgent: 'ibtikar-eval-backend/1.0',
    });
    this.org = config.github.org;
  }

  /** Liste tous les repos de l'organisation (paginé) */
  async listOrgRepos(): Promise<OrgRepoInfo[]> {
    logger.info(`[GitHub] Liste des repos de l'org ${this.org}`);
    const repos = await this.octokit.paginate(this.octokit.rest.repos.listForOrg, {
      org: this.org,
      per_page: 100,
      type: 'all',
    });
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
  async listCommits(owner: string, repo: string, since: string, until: string) {
    try {
      return await this.octokit.paginate(this.octokit.rest.repos.listCommits, {
        owner,
        repo,
        since,
        until,
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
    const members = await this.octokit.paginate(this.octokit.rest.orgs.listMembers, {
      org: this.org,
      per_page: 100,
    });
    return members.map((m) => ({ login: m.login, id: m.id }));
  }

  /** Équipes GitHub de l'org (nécessite un token avec accès lecture équipes). */
  async listOrgTeams(): Promise<OrgTeamSummary[]> {
    try {
      const teams = await this.octokit.paginate(this.octokit.rest.teams.list, {
        org: this.org,
        per_page: 100,
      });
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
    const repos = await this.octokit.paginate(this.octokit.rest.teams.listReposInOrg, {
      org: this.org,
      team_slug: teamSlug,
      per_page: 100,
    });
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
    const members = await this.octokit.paginate(this.octokit.rest.teams.listMembersInOrg, {
      org: this.org,
      team_slug: teamSlug,
      per_page: 100,
    });
    return members.map((m) => ({ login: m.login, id: m.id }));
  }

  /** Info d'un user GitHub par username */
  async getUser(username: string) {
    const { data } = await this.octokit.rest.users.getByUsername({ username });
    return data;
  }
}

export const githubService = new GitHubService();
export default githubService;
