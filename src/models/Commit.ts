import { Schema, model, Document, Types } from 'mongoose';

export interface ICommitFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface ICommit extends Document {
  _id: Types.ObjectId;
  sha: string;
  repository: Types.ObjectId;
  group?: Types.ObjectId;
  developer?: Types.ObjectId;
  authorName?: string;
  authorEmail?: string;
  authorGithubLogin?: string;
  message?: string;
  committedAt?: Date;
  url?: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  files: ICommitFile[];
  analyzed: boolean;
  analyzedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CommitSchema = new Schema<ICommit>(
  {
    sha: { type: String, required: true, index: true },
    repository: { type: Schema.Types.ObjectId, ref: 'Repository', required: true, index: true },
    group: { type: Schema.Types.ObjectId, ref: 'Group', index: true },
    developer: { type: Schema.Types.ObjectId, ref: 'Developer', index: true },

    authorName: String,
    authorEmail: String,
    authorGithubLogin: String,
    message: String,
    committedAt: { type: Date, index: true },
    url: String,

    additions: { type: Number, default: 0 },
    deletions: { type: Number, default: 0 },
    filesChanged: { type: Number, default: 0 },

    files: [
      {
        filename: String,
        status: String,
        additions: Number,
        deletions: Number,
        patch: String,
      },
    ],

    analyzed: { type: Boolean, default: false, index: true },
    analyzedAt: Date,
  },
  { timestamps: true }
);

CommitSchema.index({ sha: 1, repository: 1 }, { unique: true });

export const Commit = model<ICommit>('Commit', CommitSchema);
