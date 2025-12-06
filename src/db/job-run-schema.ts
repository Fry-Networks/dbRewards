/**
 * Tracking schema for long-running reward jobs (weekly roll-up, etc.).
 * Stores execution status, metrics, and error details so jobs are resumable
 * and observable across multiple service instances.
 */
import mongoose from 'mongoose';

const jobRunMetricsSchema = new mongoose.Schema(
  {
    eligible_devices: { type: Number, default: 0 },
    rewarded_devices: { type: Number, default: 0 },
    weekly_entries_created: { type: Number, default: 0 },
    duplicate_entries_skipped: { type: Number, default: 0 },
    errors: { type: Number, default: 0 },
    amount_by_asset: { type: mongoose.Schema.Types.Mixed, default: {} },
    device_type_summary: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false, suppressReservedKeysWarning: true },
);

const jobRunSchema = new mongoose.Schema(
  {
    job_key: { type: String, required: true, unique: true },
    job_name: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'running', 'completed', 'failed'],
      default: 'pending',
    },
    window_start: { type: Date, required: true },
    window_end: { type: Date, required: true },
    unlock_at: { type: Date, required: true },
    started_at: { type: Date },
    finished_at: { type: Date },
    last_heartbeat: { type: Date },
    metrics: { type: jobRunMetricsSchema, default: () => ({}) },
    error_messages: { type: [String], default: [] },
    notes: { type: String },
  },
  {
    collection: 'rewards_job_runs',
    timestamps: false,
  },
);

jobRunSchema.index({ job_name: 1, unlock_at: 1 }, { unique: true, name: 'unique_job_window' });

export interface JobRun extends mongoose.Document {
  job_key: string;
  job_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  window_start: Date;
  window_end: Date;
  unlock_at: Date;
  started_at?: Date;
  finished_at?: Date;
  last_heartbeat?: Date;
  metrics: {
    eligible_devices: number;
    rewarded_devices: number;
    weekly_entries_created: number;
    duplicate_entries_skipped: number;
    errors: number;
    amount_by_asset?: Record<string, unknown>;
    device_type_summary?: Record<string, unknown>;
  };
  error_messages: string[];
  notes?: string;
}

export const JobRunModel = mongoose.model<JobRun>('rewards_job_run', jobRunSchema);
export const TestJobRunModel = mongoose.model<JobRun>('test_rewards_job_run', jobRunSchema);
