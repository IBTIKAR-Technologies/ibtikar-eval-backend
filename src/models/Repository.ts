import { Schema, model, Document, Types } from 'mongoose';
import type { RepoPlatform } from '../types';

export interface IRepository extends Document {
  _id: Types.ObjectId;
  fullName: string;
  name: string;
  githubRepoId?: number;
  platform: RepoPlatform;
  language?: string;
  defaultBranch: string;
  isPrivate: boolean;
  isArchived: boolean;
  group: Types.ObjectId;
  lastScannedAt?: Date;
  lastCommitSha?: string;
  createdAt: Date;
  updatedAt: Date;
}

const RepositorySchema = new Schema<IRepository>(
  {
    fullName: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    githubRepoId: { type: Number, index: true },

    platform: {
      type: String,
      enum: ['web', 'mobile', 'backend', 'api', 'library', 'infra', 'other'],
      default: 'other',
    },
    language: { type: String },
    defaultBranch: { type: String, default: 'main' },
    isPrivate: { type: Boolean, default: true },
    isArchived: { type: Boolean, default: false },

    group: { type: Schema.Types.ObjectId, ref: 'Group', required: true, index: true },

    lastScannedAt: { type: Date },
    lastCommitSha: { type: String },
  },
  { timestamps: true }
);

export const Repository = model<IRepository>('Repository', RepositorySchema);
