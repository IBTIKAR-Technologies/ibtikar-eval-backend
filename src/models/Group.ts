import { Schema, model, Document, Types } from 'mongoose';
import type { GroupCategory } from '../types';

export interface IGroup extends Document {
  _id: Types.ObjectId;
  name: string;
  slug: string;
  description?: string;
  client?: string;
  category: GroupCategory;
  repositories: Types.ObjectId[];
  leads: Types.ObjectId[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const GroupSchema = new Schema<IGroup>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    description: { type: String, trim: true },
    client: { type: String, trim: true },
    category: {
      type: String,
      enum: ['web', 'mobile', 'fullstack', 'api', 'mixed', 'internal', 'other'],
      default: 'mixed',
    },
    repositories: [{ type: Schema.Types.ObjectId, ref: 'Repository' }],
    leads: [{ type: Schema.Types.ObjectId, ref: 'Developer' }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Group = model<IGroup>('Group', GroupSchema);
