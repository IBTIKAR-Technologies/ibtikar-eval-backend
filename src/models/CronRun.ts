import { Schema, model, Document, Types } from 'mongoose';
import type { CronRunStatus, CronTrigger } from '../types';

export interface ICronRunError {
  at: string;
  message: string;
}

export interface ICronRun extends Document {
  _id: Types.ObjectId;
  startedAt: Date;
  finishedAt?: Date;
  status: CronRunStatus;
  periodStart?: Date;
  periodEnd?: Date;
  counters: {
    reposScanned: number;
    commitsFetched: number;
    commitsNew: number;
    developersEvaluated: number;
    evaluationsCreated: number;
    errors: number;
  };
  /** Journal d'erreurs du run (nom différent de `Document.errors` Mongoose) */
  errorLog: ICronRunError[];
  trigger: CronTrigger;
  createdAt: Date;
  updatedAt: Date;
}

const CronRunSchema = new Schema<ICronRun>(
  {
    startedAt: { type: Date, default: Date.now },
    finishedAt: Date,
    status: {
      type: String,
      enum: ['running', 'success', 'partial', 'failed'],
      default: 'running',
      index: true,
    },
    periodStart: Date,
    periodEnd: Date,

    counters: {
      reposScanned: { type: Number, default: 0 },
      commitsFetched: { type: Number, default: 0 },
      commitsNew: { type: Number, default: 0 },
      developersEvaluated: { type: Number, default: 0 },
      evaluationsCreated: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
    },

    errorLog: { type: [{ at: String, message: String }], default: [] },
    trigger: { type: String, enum: ['schedule', 'manual', 'startup'], default: 'schedule' },
  },
  { timestamps: true }
);

export const CronRun = model<ICronRun>('CronRun', CronRunSchema);
