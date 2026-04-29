import type { Types } from 'mongoose';

export type ID = Types.ObjectId;

export type DeveloperRole =
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'mobile'
  | 'devops'
  | 'lead'
  | 'qa'
  | 'other';

export type GroupCategory = 'web' | 'mobile' | 'fullstack' | 'api' | 'mixed' | 'internal' | 'other';

export type RepoPlatform = 'web' | 'mobile' | 'backend' | 'api' | 'library' | 'infra' | 'other';

export type EvaluationStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export type CronRunStatus = 'running' | 'success' | 'partial' | 'failed';
export type CronTrigger = 'schedule' | 'manual' | 'startup';
export type EvaluationPeriodType = 'week' | 'month' | 'quarter';

export type ProposalType =
  | 'promotion'
  | 'bonus'
  | 'training'
  | 'mentoring'
  | 'recognition'
  | 'warning'
  | 'none';

export type Priority = 'low' | 'medium' | 'high';

export interface Period {
  start: Date;
  end: Date;
  label: string;
  type: EvaluationPeriodType;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  priority?: string;
  storyPoints?: number;
  updatedAt?: string;
  url?: string;
}

export interface JiraEvaluationContext {
  accountId?: string;
  issuesCount: number;
  backlogCount: number;
  doneCount: number;
  inProgressCount: number;
  storyPointsCompleted: number;
  labels: string[];
  statusBreakdown: Array<{ status: string; count: number }>;
  issues: JiraIssueSummary[];
}

/** Métriques GitHub collectées via l'API (non évaluées par le LLM) */
export interface GithubAuditData {
  reposCount: number;    // repos distincts touchés par le dev sur la période
  pullsCount: number;    // PRs ouvertes/fusionnées par le dev sur la période
  commitsCount: number;  // = stats.commitsCount, dupliqué ici pour le bloc audit
  clonesCount: number;   // champ conservé pour compatibilité, non utilisé comme KPI développeur
}

/** Sortie JSON attendue du modèle d'évaluation */
export interface LlmEvaluationOutput {
  scores: {
    commits: {
      normsScore: number;       // 0-100 : qualité des messages (conventional commits)
      separationScore: number;  // 0-100 : atomicité des commits
      frequencyScore: number;   // 0-100 : régularité sur la période
    };
    codeQuality: number;        // 0-100 : qualité globale du code produit
    productivity: number;       // 0-100 : volume et complexité du travail utile
    overall: number;            // 0-100 : score global pondéré
  };
  analysis: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
    notableCommits: Array<{ sha: string; comment: string }>;
  };
  proposal: {
    type: ProposalType;
    title: string;
    rationale: string;
    priority: Priority;
  };
}

export interface LlmEvaluationResult extends LlmEvaluationOutput {
  _meta: {
    model: string;
    tokensUsed: { input: number; output: number };
  };
}

/** Payload envoyé au LLM pour évaluer un dev */
export interface DeveloperEvaluationPayload {
  developer: {
    fullName: string;
    githubUsername: string;
    role: DeveloperRole;
  };
  period: Period;
  stats: {
    commitsCount: number;
    additions: number;
    deletions: number;
    filesChanged: number;
    activeDays: number;
    languages: string[];
    groupNames: string[];
  };
  commits: Array<{
    sha: string;
    message: string;
    committedAt: string | undefined;
    additions: number;
    deletions: number;
    filesChanged: number;
    files: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string;
    }>;
    repoFullName: string | undefined;
    repoPlatform: string | undefined;
  }>;
  jira?: JiraEvaluationContext;
  githubAudit?: GithubAuditData;
}
