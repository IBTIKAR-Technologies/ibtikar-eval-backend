import { Schema, model, Document, Types } from 'mongoose';
import type { EvaluationStatus, ProposalType, Priority, EvaluationPeriodType } from '../types';

export interface IEvaluation extends Omit<Document, 'model'> {
  _id: Types.ObjectId;
  developer: Types.ObjectId;
  periodStart: Date;
  periodEnd: Date;
  periodLabel?: string;
  periodType: EvaluationPeriodType;
  groups: Types.ObjectId[];
  repositories: Types.ObjectId[];
  commits: Types.ObjectId[];

  stats: {
    commitsCount: number;
    additions: number;
    deletions: number;
    filesChanged: number;
    activeDays: number;
    languages: string[];
  };

  scores: {
    commits?: {
      normsScore: number;
      separationScore: number;
      frequencyScore: number;
    };
    codeQuality?: number;
    productivity?: number;
    overall?: number;
  };

  analysis: {
    summary?: string;
    strengths: string[];
    weaknesses: string[];
    recommendations: string[];
    notableCommits: Array<{ sha: string; comment: string }>;
  };

  githubAudit?: {
    reposCount: number;
    pullsCount: number;
    commitsCount: number;
    clonesCount: number;
  };

  jira?: {
    accountId?: string;
    issuesCount: number;
    backlogCount: number;
    doneCount: number;
    inProgressCount: number;
    storyPointsCompleted: number;
    labels: string[];
    statusBreakdown: Array<{ status: string; count: number }>;
    issues: Array<{
      key: string;
      summary: string;
      status: string;
      issueType: string;
      priority?: string;
      storyPoints?: number;
      updatedAt?: string;
      url?: string;
    }>;
  };

  proposal: {
    type: ProposalType;
    title?: string;
    rationale?: string;
    priority: Priority;
  };

  model?: string;
  tokensUsed?: { input: number; output: number };
  status: EvaluationStatus;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EvaluationSchema = new Schema<IEvaluation>(
  {
    developer: { type: Schema.Types.ObjectId, ref: 'Developer', required: true, index: true },

    periodStart: { type: Date, required: true, index: true },
    periodEnd: { type: Date, required: true, index: true },
    periodLabel: { type: String },
    periodType: { type: String, enum: ['week', 'month', 'quarter'], default: 'week', index: true },

    groups: [{ type: Schema.Types.ObjectId, ref: 'Group' }],
    repositories: [{ type: Schema.Types.ObjectId, ref: 'Repository' }],
    commits: [{ type: Schema.Types.ObjectId, ref: 'Commit' }],

    stats: {
      commitsCount: { type: Number, default: 0 },
      additions: { type: Number, default: 0 },
      deletions: { type: Number, default: 0 },
      filesChanged: { type: Number, default: 0 },
      activeDays: { type: Number, default: 0 },
      languages: [String],
    },

    scores: {
      commits: {
        normsScore: { type: Number, min: 0, max: 100 },
        separationScore: { type: Number, min: 0, max: 100 },
        frequencyScore: { type: Number, min: 0, max: 100 },
      },
      codeQuality: { type: Number, min: 0, max: 100 },
      productivity: { type: Number, min: 0, max: 100 },
      overall: { type: Number, min: 0, max: 100, index: true },
    },

    analysis: {
      summary: String,
      strengths: [String],
      weaknesses: [String],
      recommendations: [String],
      notableCommits: [{ sha: String, comment: String }],
    },

    githubAudit: {
      reposCount: { type: Number, default: 0 },
      pullsCount: { type: Number, default: 0 },
      commitsCount: { type: Number, default: 0 },
      clonesCount: { type: Number, default: 0 },
    },

    jira: {
      accountId: String,
      issuesCount: { type: Number, default: 0 },
      backlogCount: { type: Number, default: 0 },
      doneCount: { type: Number, default: 0 },
      inProgressCount: { type: Number, default: 0 },
      storyPointsCompleted: { type: Number, default: 0 },
      labels: [String],
      statusBreakdown: [{ status: String, count: Number }],
      issues: [
        {
          key: String,
          summary: String,
          status: String,
          issueType: String,
          priority: String,
          storyPoints: Number,
          updatedAt: String,
          url: String,
        },
      ],
    },

    proposal: {
      type: {
        type: String,
        enum: ['promotion', 'bonus', 'training', 'mentoring', 'recognition', 'warning', 'none'],
        default: 'none',
      },
      title: String,
      rationale: String,
      priority: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    },

    model: String,
    tokensUsed: {
      input: Number,
      output: Number,
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
      default: 'pending',
      index: true,
    },
    error: String,
  },
  { timestamps: true }
);

EvaluationSchema.index({ developer: 1, periodStart: 1, periodEnd: 1 }, { unique: true });

export const Evaluation = model<IEvaluation>('Evaluation', EvaluationSchema);
