import { Schema, model, Document, Types } from 'mongoose';
import type { DeveloperRole } from '../types';

export interface IDeveloper extends Document {
  _id: Types.ObjectId;
  fullName: string;
  email?: string;
  role: DeveloperRole;
  department?: string;
  githubUsername: string;
  githubUserId?: number;
  githubEmails: string[];
  isActive: boolean;
  joinedAt: Date;
  groups: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const DeveloperSchema = new Schema<IDeveloper>(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    role: {
      type: String,
      enum: ['frontend', 'backend', 'fullstack', 'mobile', 'devops', 'lead', 'qa', 'other'],
      default: 'other',
    },
    department: { type: String, trim: true },

    githubUsername: { type: String, required: true, trim: true, unique: true, index: true },
    githubUserId: { type: Number, index: true },
    githubEmails: [{ type: String, lowercase: true }],

    isActive: { type: Boolean, default: true },
    joinedAt: { type: Date, default: Date.now },

    groups: [{ type: Schema.Types.ObjectId, ref: 'Group' }],
  },
  { timestamps: true }
);

DeveloperSchema.index({ fullName: 'text', email: 'text' });

export const Developer = model<IDeveloper>('Developer', DeveloperSchema);
