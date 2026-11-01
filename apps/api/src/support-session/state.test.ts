import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../config.js';
import {
  ASSIST_LIMITS,
  executionPhase,
  executionVerification,
  summarizeExecutions,
} from './state.js';

const row = (fields: Record<string, unknown> = {}) => ({
  status: 'queued',
  started_at: null,
  result_received_at: null,
  result_status: null,
  stop_outcome: null,
  report_expired_at: null,
  verify_ok: null,
  ...fields,
});
const at = new Date('2026-11-01T00:00:00Z');

describe('実行の段階', () => {
  it.each([
    [{ status: 'queued' }, 'not_started'],
    [{ status: 'delivered' }, 'not_started'],
    [{ status: 'cancelled', stop_outcome: 'not_running' }, 'cancelled_before_start'],
    [{ status: 'expired', stop_outcome: 'not_running' }, 'expired_before_start'],
    [{ status: 'rejected_at_start', stop_outcome: 'not_running' }, 'rejected_before_start'],
    // /start の応答を失った場合はサーバに started_at がある。ヘルパーは実行していないと報告する。
    [
      { status: 'rejected_by_helper', started_at: at, result_received_at: at },
      'rejected_before_start',
    ],
    [{ status: 'executing', started_at: at }, 'started'],
    [{ status: 'timed_out', started_at: at }, 'stop_unconfirmed'],
    [{ status: 'executing', started_at: at, stop_outcome: 'stop_unconfirmed' }, 'stop_unconfirmed'],
    [{ status: 'timed_out', started_at: at, report_expired_at: at }, 'stop_unconfirmed'],
    [
      { status: 'completed', started_at: at, result_received_at: at, result_status: 'ok' },
      'completed',
    ],
    [
      { status: 'failed', started_at: at, result_received_at: at, result_status: 'failed' },
      'failed',
    ],
  ])('%j → %s', (fields, phase) => {
    expect(executionPhase(row(fields))).toBe(phase);
  });

  it('検証は完了と別に返す。実行していないものは対象外', () => {
    const done = {
      status: 'completed',
      started_at: at,
      result_received_at: at,
      result_status: 'ok',
    };
    expect(executionVerification(row({ ...done, verify_ok: true }))).toBe('passed');
    expect(executionVerification(row({ ...done, verify_ok: false }))).toBe('failed');
    expect(executionVerification(row(done))).toBe('unverified');
    expect(executionVerification(row({ status: 'executing', started_at: at }))).toBe('unverified');
    expect(executionVerification(row({ status: 'rejected_at_start', verify_ok: null }))).toBe(
      'not_applicable',
    );
  });

  it('報告の期限切れを、報告済みにも停止確認済みにも数えない', () => {
    const summary = summarizeExecutions([
      row({
        status: 'timed_out',
        started_at: at,
        stop_outcome: 'stop_unconfirmed',
        report_expired_at: at,
      }),
      row({
        status: 'failed',
        started_at: at,
        result_received_at: at,
        result_status: 'cancelled',
        stop_outcome: 'stopped',
      }),
      row({ status: 'completed', started_at: at, result_received_at: at, result_status: 'ok' }),
      row({ status: 'rejected_at_start', stop_outcome: 'not_running' }),
      row({ status: 'queued' }),
    ]);
    expect(summary).toEqual({
      started: 3,
      reported: 2,
      stopConfirmed: 1,
      stopUnconfirmed: 1,
      notRun: 1,
    });
  });
});

describe('端末のローカル保持期限（scripts/windows/folder-helper.ps1）', () => {
  it('報告専用トークンの期限は、サーバの報告の受付より長い', () => {
    const script = readFileSync(path.join(repoRoot, 'scripts/windows/folder-helper.ps1'), 'utf8');
    const hours = Number(/\$script:ReportTokenRetentionHours = (\d+)/.exec(script)?.[1]);
    expect(hours).toBeGreaterThan(ASSIST_LIMITS.revokedReportHours);
  });
});
