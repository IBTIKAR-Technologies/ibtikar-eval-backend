import { Schema, model, Document, Types } from 'mongoose';

export interface IProjet extends Document {
  _id: Types.ObjectId;
  key: string;
  jiraProjectId: string;
  name: string;
  projectTypeKey?: string;
  isActive: boolean;
  stats: {
    totalIssues: number;
    backlogCount: number;
    inProgressCount: number;
    doneCount: number;
    statusBreakdown: Array<{ status: string; count: number }>;
  };
  sampleIssues: Array<{
    key: string;
    summary: string;
    status: string;
    assignee?: string;
    updatedAt?: string;
  }>;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ProjetSchema = new Schema<IProjet>(
  {
    key: { type: String, required: true, unique: true, index: true, uppercase: true, trim: true },
    jiraProjectId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    projectTypeKey: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    stats: {
      totalIssues: { type: Number, default: 0 },
      backlogCount: { type: Number, default: 0 },
      inProgressCount: { type: Number, default: 0 },
      doneCount: { type: Number, default: 0 },
      statusBreakdown: [{ status: String, count: Number }],
    },
    sampleIssues: [
      {
        key: String,
        summary: String,
        status: String,
        assignee: String,
        updatedAt: String,
      },
    ],
    lastSyncedAt: Date,
  },
  { timestamps: true }
);

export const Projet = model<IProjet>('Projet', ProjetSchema);
