export type JobLockName =
  | 'weekly-rollup'
  | 'hourly-processing'
  | 'daily-backup'
  | 'data-validation';

type Waiter = {
  job: JobLockName;
  conflicts: JobLockName[];
  resolve: (release: () => void) => void;
};

/**
 * Lightweight in-memory lock manager used to coordinate long-running jobs
 * so that maintenance tasks (backups, validation) never run in parallel with
 * critical reward processing.
 */
class JobLockManager {
  private readonly active = new Set<JobLockName>();
  private readonly waiters: Waiter[] = [];

  async acquire(job: JobLockName, conflicts: JobLockName[]): Promise<() => void> {
    return await new Promise<() => void>((resolve) => {
      const attempt = (): boolean => {
        if (!this.hasConflict(job, conflicts)) {
          this.active.add(job);
          resolve(() => this.release(job));
          return true;
        }
        return false;
      };

      if (!attempt()) {
        this.waiters.push({ job, conflicts, resolve });
      }
    });
  }

  private hasConflict(job: JobLockName, conflicts: JobLockName[]): boolean {
    if (this.active.has(job)) {
      return true;
    }
    return conflicts.some((conflict) => this.active.has(conflict));
  }

  private release(job: JobLockName): void {
    this.active.delete(job);
    this.processQueue();
  }

  private processQueue(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const waiter = this.waiters[i];
      if (!this.hasConflict(waiter.job, waiter.conflicts)) {
        this.waiters.splice(i, 1);
        this.active.add(waiter.job);
        waiter.resolve(() => this.release(waiter.job));
      } else {
        i += 1;
      }
    }
  }
}

export const jobLockManager = new JobLockManager();

export async function withJobLock<T>(
  job: JobLockName,
  conflicts: JobLockName[],
  fn: () => Promise<T>
): Promise<T> {
  const release = await jobLockManager.acquire(job, conflicts);
  let result: T;
  try {
    result = await fn();
  } finally {
    release();
  }
  return result;
}
