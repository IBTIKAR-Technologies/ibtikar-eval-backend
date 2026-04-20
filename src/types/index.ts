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

export type ProposalType =
  | 'promotion'
  | 'bonus'
  | 'training'
  | 'mentoring'
  | 'recognition'
  | 'warning'
  | 'none';

export type Priority = 'low' | 'medium' | 'high';

/** Période d'évaluation (semaine ISO typiquement) */
export interface Period {
  start: Date;
  end: Date;
  label: string;
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

/** Sortie JSON attendue du modèle d'évaluation (Gemini, etc.) */
export interface LlmEvaluationOutput {
  scores: {
    codeQuality: number;
    commitFrequency: number;
    conventionAdherence: number;
    technicalComplexity: number;
    overall: number;
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

/** Métadonnées retournées avec la sortie du LLM */
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
}
