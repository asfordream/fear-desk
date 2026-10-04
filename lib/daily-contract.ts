export const PIPELINE_VERSION = 2;
export const SLICE_BUDGET_MS = 25_000;
export const LEASE_MS = 120_000;
export const WORK_BUDGET_MS = 30 * 60_000;
export const MAX_FAILED_ATTEMPTS = 3;
export type RequestSource = 'manual' | 'schedule';
export type SendIntent = 'none' | 'original_schedule';
export type DailyStage = 'freezePool' | 'resolveSPY' | 'fetchMarket' | 'earnings' | 'calculate' | 'validate' | 'publish';
export type DailyStatus = 'queued' | 'running' | 'retry_wait' | 'ready' | 'reused' | 'partial' | 'failed';
export const TERMINAL_STATUSES = ['ready', 'reused', 'partial', 'failed'] as const;
export type DailyJobRow = {
  id: string; status: DailyStatus; stage: DailyStage; started_at: string;
  requested_closed_day: string; trade_date: string | null; report_id: string | null;
  checkpoint: number; active_token: string | null; lease_epoch: number; lease_until: number; slice_until: number;
  failed_attempts: number; active_budget_ms: number; reserved_ms: number;
  next_eligible_at: number; last_progress_at: string | null; message: string | null;
  scope_hash: string; pool_version: string; algorithm_version: string; card_version: string; validation_hash: string | null; input_revision: number; attempt_id: string | null;
};
export type WriteFence = {jobId: string; token: string; epoch: number; cursor: number; inputRevision: number};
export type DailyRequest = {requestId: string; source: RequestSource; sendIntent: SendIntent; scopeHash: string; scheduleOccurrence: string | null};
export function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/.test(value);
}
export function jobDto(job: DailyJobRow, now = Date.now()) {
  const interrupted = job.status === 'running' && job.lease_until <= now;
  return {
    id: job.id, status: interrupted ? 'interrupted' : job.status, stage: job.stage,
    requestedClosedDay: job.requested_closed_day, tradeDate: job.trade_date,
    reportId: job.report_id, requestedAt: job.started_at,
    checkpoint: job.checkpoint, failedAttempts: job.failed_attempts,
    workBudgetUsedMs: job.active_budget_ms + job.reserved_ms,
    lastProgressAt: job.last_progress_at, nextEligibleAt: job.next_eligible_at,
    waitingBackground: job.status === 'queued' || job.status === 'retry_wait' || interrupted,
    message: interrupted ? '执行已中断；等待后台每小时检查续跑，实际恢复可能延迟' : job.message,
  };
}
export async function hashFacts(value: unknown) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))))
    .map(x => x.toString(16).padStart(2, '0')).join('');
}
