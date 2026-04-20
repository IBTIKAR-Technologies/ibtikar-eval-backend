import config from '../config';
import logger from '../utils/logger';
import type { JiraEvaluationContext, JiraIssueSummary, Period } from '../types';

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      summary?: string;
      status?: { name?: string; statusCategory?: { key?: string } };
      issuetype?: { name?: string };
      priority?: { name?: string };
      labels?: string[];
      updated?: string;
      customfield_10016?: number; // story points (common field in Jira Cloud)
      assignee?: {
        accountId?: string;
        displayName?: string;
        emailAddress?: string;
        active?: boolean;
      };
    };
  }>;
}

export interface JiraProjectSummary {
    key: string;
  name: string;
  id: string;
  projectTypeKey?: string;
}

export interface JiraAssigneeSummary {
  accountId: string;
  displayName: string;
  email?: string;
  issueCount: number;
}

export interface JiraProjectWorkSummary {
  totalIssues: number;
  backlogCount: number;
  inProgressCount: number;
  doneCount: number;
  statusBreakdown: Array<{ status: string; count: number }>;
  sampleIssues: Array<{
    key: string;
    summary: string;
    status: string;
    assignee?: string;
    updatedAt?: string;
  }>;
}

class JiraService {
  private readonly enabled: boolean;
  private readonly baseUrl?: string;
  private readonly email?: string;
  private readonly token?: string;
  private readonly projectKeys: string[];
  private readonly accountCache = new Map<string, string>();

  constructor() {
    this.enabled = config.jira.enabled;
    this.baseUrl = config.jira.baseUrl;
    this.email = config.jira.email;
    this.token = config.jira.apiToken;
    this.projectKeys = config.jira.projectKeys;
  }

  isEnabled(): boolean {
    return !!(this.enabled && this.baseUrl && this.email && this.token);
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}`;
  }

  private async requestJson<T>(path: string): Promise<T> {
    if (!this.baseUrl) throw new Error('[Jira] JIRA_BASE_URL manquant');
    const url = `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`[Jira] HTTP ${resp.status} sur ${path} — ${body.slice(0, 300)}`);
    }
    return (await resp.json()) as T;
  }

  private async resolveAccountId(emailOrUsername: string): Promise<string | null> {
    const key = emailOrUsername.trim().toLowerCase();
    if (!key) return null;
    const cached = this.accountCache.get(key);
    if (cached) return cached;

    try {
      const users = await this.requestJson<Array<{ accountId?: string }>>(
        `/rest/api/3/user/search?query=${encodeURIComponent(emailOrUsername)}&maxResults=5`
      );
      const id = users.find((u) => !!u.accountId)?.accountId ?? null;
      if (id) this.accountCache.set(key, id);
      return id;
    } catch (err) {
      logger.warn(`[Jira] Impossible de résoudre accountId pour ${emailOrUsername}`);
      return null;
    }
  }

  private normalizeIssue(issue: JiraSearchResponse['issues'][number]): JiraIssueSummary {
    const points = issue.fields.customfield_10016;
    const out: JiraIssueSummary = {
      key: issue.key,
      summary: issue.fields.summary ?? '',
      status: issue.fields.status?.name ?? 'Unknown',
      issueType: issue.fields.issuetype?.name ?? 'Unknown',
      priority: issue.fields.priority?.name,
      storyPoints: typeof points === 'number' ? points : undefined,
      updatedAt: issue.fields.updated,
      url: this.baseUrl ? `${this.baseUrl.replace(/\/$/, '')}/browse/${issue.key}` : undefined,
    };
    return out;
  }

  private isDoneCategory(issue: JiraIssueSummary): boolean {
    const s = issue.status.toLowerCase();
    return s.includes('done') || s.includes('closed') || s.includes('resolved');
  }

  private isInProgressCategory(issue: JiraIssueSummary): boolean {
    const s = issue.status.toLowerCase();
    return s.includes('progress') || s.includes('review') || s.includes('qa') || s.includes('testing');
  }

  private isBacklogCategory(issue: JiraIssueSummary): boolean {
    const s = issue.status.toLowerCase();
    return s.includes('backlog') || s.includes('to do') || s.includes('todo') || s.includes('open');
  }

  async getDeveloperContext(params: {
    developerEmail?: string;
    developerUsername: string;
    period: Period;
    maxIssues?: number;
  }): Promise<JiraEvaluationContext | null> {
    if (!this.isEnabled()) return null;

    const accountId =
      (params.developerEmail ? await this.resolveAccountId(params.developerEmail) : null) ??
      (await this.resolveAccountId(params.developerUsername));

    if (!accountId) {
      return {
        issuesCount: 0,
        backlogCount: 0,
        doneCount: 0,
        inProgressCount: 0,
        storyPointsCompleted: 0,
        labels: [],
        statusBreakdown: [],
        issues: [],
      };
    }

    const max = params.maxIssues ?? 25;
    const start = params.period.start.toISOString().slice(0, 10);
    const end = params.period.end.toISOString().slice(0, 10);
    const jql = `assignee = "${accountId}" AND updated >= "${start}" AND updated <= "${end}" ORDER BY updated DESC`;

    try {
      const data = await this.requestJson<JiraSearchResponse>(
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=summary,status,issuetype,priority,labels,updated,customfield_10016`
      );
      const issues = data.issues.map((i) => this.normalizeIssue(i));
      const backlog = issues.filter((i) => this.isBacklogCategory(i));
      const done = issues.filter((i) => this.isDoneCategory(i));
      const inProgress = issues.filter((i) => this.isInProgressCategory(i));
      const labels = Array.from(new Set(data.issues.flatMap((i) => i.fields.labels ?? []))).slice(0, 20);
      const statusMap = new Map<string, number>();
      for (const i of issues) {
        statusMap.set(i.status, (statusMap.get(i.status) ?? 0) + 1);
      }
      const statusBreakdown = Array.from(statusMap.entries())
        .map(([status, count]) => ({ status, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
      const storyPointsCompleted = done.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);

      return {
        accountId,
        issuesCount: issues.length,
        backlogCount: backlog.length,
        doneCount: done.length,
        inProgressCount: inProgress.length,
        storyPointsCompleted,
        labels,
        statusBreakdown,
        issues,
      };
    } catch (err) {
      logger.error('[Jira] Échec récupération activités', err);
      return null;
    }
  }

  async listProjects(): Promise<JiraProjectSummary[]> {
    if (!this.isEnabled()) return [];
    type JiraProjectSearchResponse = {
      values?: Array<{ id: string; key: string; name: string; projectTypeKey?: string }>;
    };

    const projectList: JiraProjectSummary[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const page = await this.requestJson<JiraProjectSearchResponse>(
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`
      );
      const values = page.values ?? [];
      projectList.push(
        ...values.map((p) => ({
          key: p.key,
          name: p.name,
          id: p.id,
          projectTypeKey: p.projectTypeKey,
        }))
      );
      if (values.length < maxResults) break;
      startAt += maxResults;
    }

    return projectList;
  }

  async listProjectAssignees(projectKey: string, lookbackDays: number): Promise<JiraAssigneeSummary[]> {
    if (!this.isEnabled()) return [];
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - lookbackDays);
    const since = date.toISOString().slice(0, 10);
    const jql = `project = "${projectKey}" AND assignee is not EMPTY AND updated >= "${since}" ORDER BY updated DESC`;

    const maxResults = 100;
    let startAt = 0;
    const counts = new Map<string, JiraAssigneeSummary>();

    while (true) {
      const data = await this.requestJson<JiraSearchResponse>(
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=assignee`
      );
      for (const issue of data.issues) {
        const a = issue.fields.assignee;
        if (!a?.accountId) continue;
        const existing = counts.get(a.accountId);
        if (existing) {
          existing.issueCount += 1;
        } else {
          counts.set(a.accountId, {
            accountId: a.accountId,
            displayName: a.displayName ?? a.accountId,
            email: a.emailAddress,
            issueCount: 1,
          });
        }
      }
      if (data.issues.length < maxResults) break;
      startAt += maxResults;
    }

    return Array.from(counts.values()).sort((a, b) => b.issueCount - a.issueCount);
  }

  async getProjectWorkSummary(projectKey: string, lookbackDays: number): Promise<JiraProjectWorkSummary> {
    if (!this.isEnabled()) {
      return {
        totalIssues: 0,
        backlogCount: 0,
        inProgressCount: 0,
        doneCount: 0,
        statusBreakdown: [],
        sampleIssues: [],
      };
    }
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - lookbackDays);
    const since = date.toISOString().slice(0, 10);
    const jql = `project = "${projectKey}" AND updated >= "${since}" ORDER BY updated DESC`;

    const maxResults = 100;
    let startAt = 0;
    const all: JiraSearchResponse['issues'] = [];

    while (true) {
      const data = await this.requestJson<JiraSearchResponse>(
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=summary,status,assignee,updated`
      );
      all.push(...data.issues);
      if (data.issues.length < maxResults) break;
      startAt += maxResults;
    }

    const normalized = all.map((i) => this.normalizeIssue(i));
    const backlogCount = normalized.filter((i) => this.isBacklogCategory(i)).length;
    const inProgressCount = normalized.filter((i) => this.isInProgressCategory(i)).length;
    const doneCount = normalized.filter((i) => this.isDoneCategory(i)).length;

    const statusMap = new Map<string, number>();
    for (const i of normalized) {
      statusMap.set(i.status, (statusMap.get(i.status) ?? 0) + 1);
    }
    const statusBreakdown = Array.from(statusMap.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const sampleIssues = all.slice(0, 30).map((i) => ({
      key: i.key,
      summary: i.fields.summary ?? '',
      status: i.fields.status?.name ?? 'Unknown',
      assignee: i.fields.assignee?.displayName,
      updatedAt: i.fields.updated,
    }));

    return {
      totalIssues: all.length,
      backlogCount,
      inProgressCount,
      doneCount,
      statusBreakdown,
      sampleIssues,
    };
  }
}

export const jiraService = new JiraService();
export default jiraService;
