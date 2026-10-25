import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../config.js';
import { sql } from '../db.js';
import { stableStringify } from '../domain/audit.js';
import { jsonbValue } from '../lib/jsonb-value.js';

/** Phase B の Skill カタログ定義（スクリプト実体は scripts/skills/windows/ 配下）。 */
export interface SkillDefinition {
  id: string;
  version: string;
  title: string;
  summary: string;
  symptoms: string[];
  os: string[];
  riskLevel: number;
  requires: Record<string, unknown>;
  paramsSchema: Record<string, unknown>;
  scriptPath: string;
  args: string[];
  verify: unknown;
  rollback: unknown;
  timeoutSec: number;
  resultSchema: Record<string, unknown>;
  outputPolicy: Record<string, unknown>;
}

/** DB から読み出した Skill（API / proposer 用の camelCase 表現）。 */
export interface SkillRecord {
  id: string;
  version: string;
  title: string;
  summary: string;
  symptoms: string[];
  os: string[];
  riskLevel: number;
  requires: Record<string, unknown>;
  paramsSchema: Record<string, unknown>;
  scriptPath: string;
  args: unknown[];
  verify: unknown;
  rollback: unknown;
  timeoutSec: number;
  resultSchema: unknown;
  outputPolicy: unknown;
  status: string;
  contentHash: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface SkillRow {
  id: string;
  version: string;
  title: string;
  summary: string;
  symptoms: unknown;
  os: unknown;
  risk_level: number;
  requires: unknown;
  params_schema: unknown;
  script_path: string;
  args: unknown;
  verify: unknown;
  rollback: unknown;
  timeout_sec: number;
  result_schema: unknown;
  output_policy: unknown;
  status: string;
  content_hash: string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  created_at: Date | string;
}

const READ_ONLY_REQUIRES = {
  userConfirm: true,
  adminApproval: false,
  elevation: false,
} as const;

/**
 * 修復系（変更を伴う）Skill の `requires` で、実行に昇格が必要なもの。
 *
 * リスク 4 以上ではないため管理者承認は要求しない（`adminApproval: false`）が、
 * Windows の仕様上 Stop-Service / Start-Service / BitLocker 参照などは昇格が要る。
 * `requires` は承認ハッシュにも含まれるメタデータであり、エージェントの実行権限を
 * 自動で昇格させるものではない（昇格は別エージェント・別承認。docs/25 §12）。
 */
const CHANGE_ELEVATED_REQUIRES = {
  userConfirm: true,
  adminApproval: false,
  elevation: true,
} as const;

/** 修復系のうち、ユーザー権限のままで実行できる Skill の `requires`。 */
const CHANGE_STANDARD_REQUIRES = {
  userConfirm: true,
  adminApproval: false,
  elevation: false,
} as const;

/**
 * Skill カタログ。
 * - Phase B: 読み取り専用 5 件（risk_level 1）
 * - Phase 2: 修復系 7 件（risk_level 1〜3 / verify・rollback 付き）
 *
 * スクリプト文字列は保持せず、許可済みの引数配列だけを持つ。
 * `args` はテンプレート（`{{param}}`）で、端末エージェントが配列のまま
 * PowerShell へ渡す（シェル文字列連結はしない）。
 *
 * 注意: 端末エージェント（scripts/endpoint-command-agent.mjs）の実行タイムアウトは
 * 60 秒固定のため、`timeoutSec` は 60 以下にする（skills.test.ts で検証）。
 * `verify` / `rollback` は現時点ではメタデータ（画面表示・承認ハッシュの対象）で、
 * 実行は Phase D の範囲。verify は「実行後の確認条件」を宣言する。
 */
export const SKILL_CATALOG: SkillDefinition[] = [
  {
    id: 'os.info',
    version: '1.0.0',
    title: 'OS の基本情報を確認する',
    summary: 'Windows のエディション・バージョン・起動時間などを読み取りで確認します。',
    symptoms: [
      'OS のバージョンを知りたい',
      'Windows の更新状態を確認したい',
      '端末の基本情報を確認したい',
    ],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/os-info.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    // 実スクリプト（os-info.ps1）の出力キーに合わせる。computerName は端末識別子なので AI へ渡さない。
    resultSchema: {
      osName: 'string',
      version: 'string',
      buildNumber: 'string',
      architecture: 'string',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['osName', 'version', 'buildNumber', 'architecture'],
      maskPii: true,
    },
  },
  {
    id: 'disk.space',
    version: '1.0.0',
    title: 'ディスクの空き容量を確認する',
    summary: '各ドライブの合計容量・空き容量・使用率を読み取りで確認します。',
    symptoms: ['空き容量が少ない', '保存できない', 'ディスクがいっぱい'],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/disk-space.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    // 実スクリプト（disk-space.ps1）は volumes を返す。
    resultSchema: {
      volumes: [{ deviceId: 'string', freeGB: 'number', totalGB: 'number' }],
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['volumes'],
      maskPii: true,
    },
  },
  {
    id: 'spooler.status',
    version: '1.0.0',
    title: '印刷スプーラの状態を確認する',
    summary: '印刷スプーラサービスと印刷キューの状態を読み取りで確認します。',
    symptoms: ['印刷できない', '印刷キューに残る', 'プリンタが応答しない'],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/spooler-status.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    // 実スクリプト（spooler-status.ps1）は name / displayName / status / startType を返す。
    resultSchema: {
      name: 'string',
      displayName: 'string',
      status: 'string',
      startType: 'string',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['name', 'status', 'startType'],
      maskPii: true,
    },
  },
  {
    id: 'service.status',
    version: '1.0.0',
    title: '指定サービスの状態を確認する',
    summary: '許可された Windows サービスの状態とスタートアップの種類を読み取りで確認します。',
    symptoms: [
      'サービスが起動しない',
      'サービスの状態を知りたい',
      '自動起動になっているか確認したい',
    ],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['service'],
      properties: {
        service: { type: 'string', enum: ['Spooler', 'W32Time', 'Winmgmt'] },
      },
    },
    scriptPath: 'scripts/skills/windows/service-status.ps1',
    args: ['-Service', '{{service}}'],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    // 実スクリプト（service-status.ps1）は name / displayName / status / startType を返す。
    resultSchema: {
      name: 'string',
      displayName: 'string',
      status: 'string',
      startType: 'string',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['name', 'status', 'startType'],
      maskPii: true,
    },
  },
  {
    id: 'network.adapters',
    version: '1.0.0',
    title: 'ネットワークアダプタの状態を確認する',
    summary: 'ネットワークアダプタの接続状態・種類・IP の有無を読み取りで確認します。',
    symptoms: ['ネットワークにつながらない', 'VPN の状態を知りたい', '通信が不安定'],
    os: ['windows'],
    riskLevel: 1,
    requires: READ_ONLY_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/network-adapters.ps1',
    args: [],
    verify: null,
    rollback: null,
    timeoutSec: 60,
    // 実スクリプト（network-adapters.ps1）の adapters[] のキーに合わせる。
    resultSchema: {
      adapters: [
        {
          name: 'string',
          status: 'string',
          linkSpeed: 'string',
          interfaceDescription: 'string',
        },
      ],
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['adapters'],
      maskPii: true,
    },
  },
  // ── Phase 2: 修復系 7 件 ─────────────────────────────────────────────
  // 変更系 Skill は rollback を必ず持つ。取消不可のものは reversible:false と
  // 影響範囲を description に明記する（承認画面と承認ハッシュの対象）。
  {
    id: 'spooler.restart',
    version: '1.0.0',
    title: '印刷スプーラを再起動する',
    summary: '印刷ジョブが処理されないとき、Spooler サービスを再起動し、起動状態を確認します。',
    symptoms: [
      '印刷が止まる',
      '印刷キューに残る',
      'プリンタが応答しない',
      'スプーラを再起動したい',
    ],
    os: ['windows'],
    riskLevel: 2,
    requires: CHANGE_ELEVATED_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/spooler-restart.ps1',
    args: [],
    // 実行後の確認条件: 再起動後に Spooler が Running であること（既存の読み取り Script で確認）。
    verify: {
      description: '再起動後に Spooler が Running であること',
      script: 'scripts/skills/windows/service-status.ps1',
      args: ['-Service', 'Spooler'],
      expect: { status: 'Running' },
    },
    // 可逆: 再起動のみで設定は変えない。自動復元は行わない。
    rollback: {
      reversible: true,
      script: null,
      args: [],
      description:
        '再起動前の状態に戻せる。起動していた場合は再起動のみで設定は変わらない。停止していた場合は service.start で Spooler を起動する（自動復元は行わない）。',
    },
    timeoutSec: 60,
    // 実スクリプト（spooler-restart.ps1）の出力キーに合わせる。
    resultSchema: {
      name: 'string',
      displayName: 'string',
      status: 'string',
      startType: 'string',
      previousStatus: 'string',
      restarted: 'boolean',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['name', 'status', 'startType', 'previousStatus', 'restarted'],
      maskPii: true,
    },
  },
  {
    id: 'spooler.queue.purge',
    version: '1.0.0',
    title: 'エラーになった印刷ジョブを削除する',
    summary:
      '印刷キューに残ったエラー状態の印刷ジョブを削除します。削除したジョブは元に戻せません。',
    symptoms: ['印刷ジョブが消えない', '印刷キューが詰まる', 'エラーの印刷ジョブを消したい'],
    os: ['windows'],
    riskLevel: 3,
    requires: CHANGE_ELEVATED_REQUIRES,
    // confirm:'PURGE' を必須にし、利用者の Y/N（承認ハッシュ）と合わせて二重確認とする。
    // 端末エージェントも params.confirm を再検証し、正しいときだけ -ConfirmPurge を渡す。
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['confirm'],
      properties: { confirm: { type: 'string', enum: ['PURGE'] } },
    },
    scriptPath: 'scripts/skills/windows/spooler-queue-purge.ps1',
    args: ['-ConfirmPurge'],
    verify: {
      description: '削除後にエラー状態の印刷ジョブが 0 件であること',
      resultField: 'remainingErrorCount',
      equals: 0,
    },
    // 取消不可: 削除したジョブは復元できない。影響範囲を明記する。
    rollback: {
      reversible: false,
      script: null,
      args: [],
      description:
        '取消不可。削除した印刷ジョブは復元できない。影響範囲: 対象端末の全プリンタの印刷キューにあるエラー状態のジョブ（他ユーザーのジョブを削除するには管理者権限が必要）。必要なら利用者が再印刷する。',
    },
    timeoutSec: 60,
    // 実スクリプト（spooler-queue-purge.ps1）は件数だけを返す（プリンタ名・ジョブ名は返さない）。
    resultSchema: {
      purgedCount: 'number',
      failedCount: 'number',
      remainingErrorCount: 'number',
      irreversible: 'boolean',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['purgedCount', 'failedCount', 'remainingErrorCount', 'irreversible'],
      maskPii: true,
    },
  },
  {
    id: 'service.start',
    version: '1.0.0',
    title: '指定サービスを起動する',
    summary: '許可された Windows サービス（Spooler / W32Time）を起動し、起動状態を確認します。',
    symptoms: ['サービスが停止している', 'サービスを起動したい', '時刻同期が止まっている'],
    os: ['windows'],
    riskLevel: 2,
    requires: CHANGE_ELEVATED_REQUIRES,
    // 起動対象は enum で限定する（サービス.status より狭くし、昇格操作の対象を増やさない）。
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string', enum: ['Spooler', 'W32Time'] },
      },
    },
    scriptPath: 'scripts/skills/windows/service-start.ps1',
    args: ['-Service', '{{name}}'],
    verify: {
      description: '起動後にサービスが Running であること',
      script: 'scripts/skills/windows/service-status.ps1',
      args: ['-Service', '{{name}}'],
      expect: { status: 'Running' },
    },
    // 可逆: 起動したサービスは停止して元に戻せる（自動停止はしない）。
    rollback: {
      reversible: true,
      script: null,
      args: [],
      description:
        '起動したサービスを停止して元に戻せる（自動停止は行わない。必要なら管理者が Stop-Service を実行する）。',
    },
    timeoutSec: 60,
    // 実スクリプト（service-start.ps1）の出力キーに合わせる。
    resultSchema: {
      name: 'string',
      displayName: 'string',
      status: 'string',
      startType: 'string',
      previousStatus: 'string',
      started: 'boolean',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['name', 'status', 'startType', 'previousStatus', 'started'],
      maskPii: true,
    },
  },
  {
    id: 'temp.cleanup',
    version: '1.0.0',
    title: '古い一時ファイルを削除する',
    summary:
      '実行ユーザーの TEMP フォルダから、指定日数より前に更新されたファイルを削除し、前後の空き容量を計測します。',
    symptoms: ['ディスクが圧迫されている', '一時ファイルを消したい', 'PC が重い'],
    os: ['windows'],
    riskLevel: 2,
    requires: CHANGE_STANDARD_REQUIRES,
    // 削除対象の古さは 1〜30 日。範囲外・未知パラメータはサーバとエージェントの両方で拒否する。
    paramsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['olderThanDays'],
      properties: {
        olderThanDays: { type: 'integer', minimum: 1, maximum: 30 },
      },
    },
    scriptPath: 'scripts/skills/windows/temp-cleanup.ps1',
    args: ['-OlderThanDays', '{{olderThanDays}}'],
    verify: {
      // 旧定義は freedBytes >= 0 で、常に真になるため「解決候補」を誤って作っていた
      // （2026-10-25 の実測）。削除実績（deletedBytes）で判定する。
      // 削除できたファイルが 0 件なら、この修復は効果が無かったとみなし停止しない。
      description: '一時ファイルを1件以上削除できたこと（deletedBytes >= 1）',
      resultField: 'deletedBytes',
      minimum: 1,
    },
    // 復元不可: 削除した一時ファイルは戻せない。影響範囲を明記する。
    rollback: {
      reversible: false,
      script: null,
      args: [],
      description:
        '削除した一時ファイルは復元できない。影響範囲: 実行ユーザーの %TEMP% 配下で olderThanDays より古いファイルのみ（フォルダ・システム TEMP・他ユーザーの領域は対象外）。未保存の作業ファイルが含まれる場合がある。',
    },
    timeoutSec: 60,
    // 実スクリプト（temp-cleanup.ps1）の出力キーに合わせる。TEMP のフルパスは返さない。
    resultSchema: {
      freeBytesBefore: 'number',
      freeBytesAfter: 'number',
      freedBytes: 'number',
      freedMB: 'number',
      deletedBytes: 'number',
      deletedCount: 'number',
      skippedCount: 'number',
      truncated: 'boolean',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['freedMB', 'deletedCount', 'skippedCount', 'truncated'],
      maskPii: true,
    },
  },
  {
    id: 'dns.flush',
    version: '1.0.0',
    title: 'DNS キャッシュをクリアする',
    summary: '名前解決のキャッシュをクリアします（ipconfig /flushdns）。設定は変更しません。',
    symptoms: ['名前解決がおかしい', '特定のサイトが開かない', 'DNS キャッシュを消したい'],
    os: ['windows'],
    // 変更はキャッシュのみで設定を変えないためリスク 1。昇格も不要。
    riskLevel: 1,
    requires: CHANGE_STANDARD_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/dns-flush.ps1',
    args: [],
    verify: {
      description: 'ipconfig /flushdns が終了コード 0 で完了したこと',
      resultField: 'flushed',
      equals: true,
    },
    // 取消不要: キャッシュは参照時に自動再構築される。
    rollback: {
      reversible: true,
      script: null,
      args: [],
      description: 'DNS キャッシュは参照時に自動再構築されるため取消操作は不要（設定変更なし）。',
    },
    timeoutSec: 30,
    // 実スクリプト（dns-flush.ps1）の出力キーに合わせる。
    resultSchema: { flushed: 'boolean', exitCode: 'number' },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['flushed', 'exitCode'],
      maskPii: true,
    },
  },
  {
    id: 'bitlocker.status',
    version: '1.0.0',
    title: 'BitLocker の状態を確認する',
    summary:
      '各ドライブの BitLocker 保護状態・暗号化方式・進捗を読み取りで確認します。回復キーは取得しません。',
    symptoms: [
      'BitLocker の状態を知りたい',
      '暗号化されているか確認したい',
      '保護が有効か知りたい',
    ],
    os: ['windows'],
    riskLevel: 1,
    requires: CHANGE_ELEVATED_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/bitlocker-status.ps1',
    args: [],
    verify: {
      description: 'ボリューム状態が 1 件以上取得できたこと',
      resultField: 'volumeCount',
      minimum: 1,
    },
    // 読み取りのみ。回復キーは取得も出力もしない。
    rollback: {
      reversible: true,
      script: null,
      args: [],
      description:
        '読み取りのみのため変更なし（ロールバック不要）。回復キーの取得・出力は行わない。',
    },
    timeoutSec: 60,
    // 実スクリプト（bitlocker-status.ps1）の出力キーに合わせる。
    // bdeStatusExitCode は manage-bde フォールバック時だけ数値（通常は null）。
    resultSchema: {
      supported: 'boolean',
      volumeCount: 'number',
      volumes: [
        {
          mountPoint: 'string',
          volumeStatus: 'string',
          protectionStatus: 'string',
          encryptionMethod: 'string',
          encryptionPercentage: 'number',
        },
      ],
      bdeStatusExitCode: 'number',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['supported', 'volumeCount', 'volumes'],
      maskPii: true,
    },
  },
  {
    id: 'defender.quickscan',
    version: '1.0.0',
    title: 'Defender のクイックスキャンを開始する',
    summary:
      'Microsoft Defender のクイックスキャンを開始します（完了は待たず、開始だけを確認します）。',
    symptoms: ['ウイルスチェックをしたい', 'Defender でスキャンしたい', 'PC が重いので確認したい'],
    os: ['windows'],
    riskLevel: 1,
    requires: CHANGE_ELEVATED_REQUIRES,
    paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
    scriptPath: 'scripts/skills/windows/defender-quickscan.ps1',
    args: [],
    verify: {
      description: 'クイックスキャンが開始されたこと',
      resultField: 'started',
      equals: true,
    },
    // スキャン開始のみ。設定変更なし。実行中スキャンの自動中止はしない。
    rollback: {
      reversible: true,
      script: null,
      args: [],
      description:
        'スキャン開始のみで設定変更はない。実行中のスキャンは Windows セキュリティ画面から中止できる（自動中止は行わない）。',
    },
    timeoutSec: 45,
    // 実スクリプト（defender-quickscan.ps1）の出力キーに合わせる。検知名・検出パスは返さない。
    resultSchema: {
      started: 'boolean',
      scanType: 'string',
      startedAt: 'string',
    },
    outputPolicy: {
      maxBytes: 8192,
      fieldsToAi: ['started', 'scanType', 'startedAt'],
      maskPii: true,
    },
  },
];

/** スクリプト内容の SHA-256（`sha256:<hex>` 形式）。 */
export function computeScriptHash(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** 人間がレビューして承認した Skill の記録（リポジトリで管理する）。 */
export interface ApprovedSkillEntry {
  id: string;
  version: string;
  scriptHash: string;
  contentHash: string;
  approvedBy: string;
  approvedAt: string;
  note?: string;
}

export interface ApprovalManifest {
  version: number;
  skills: ApprovedSkillEntry[];
}

export const APPROVAL_MANIFEST_PATH = 'scripts/skills/approved.json';

/**
 * Skill 定義全体の SHA-256。スクリプトだけでなく、引数・リスク・パラメータスキーマ・
 * verify/rollback・出力ポリシーまで含める。1 つでも変われば承認は無効になる。
 */
export function computeSkillDefinitionHash(skill: SkillDefinition, scriptHash: string): string {
  const definition = {
    id: skill.id,
    version: skill.version,
    title: skill.title,
    summary: skill.summary,
    symptoms: skill.symptoms,
    os: skill.os,
    riskLevel: skill.riskLevel,
    requires: skill.requires,
    paramsSchema: skill.paramsSchema,
    scriptPath: skill.scriptPath,
    args: skill.args,
    verify: skill.verify,
    rollback: skill.rollback,
    timeoutSec: skill.timeoutSec,
    resultSchema: skill.resultSchema,
    outputPolicy: skill.outputPolicy,
    scriptHash,
  };
  return `sha256:${createHash('sha256').update(stableStringify(definition)).digest('hex')}`;
}

export function readApprovalManifest(repoRootPath: string): ApprovalManifest {
  const file = path.join(repoRootPath, APPROVAL_MANIFEST_PATH);
  if (!existsSync(file)) return { version: 1, skills: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ApprovalManifest;
    return Array.isArray(parsed.skills) ? parsed : { version: 1, skills: [] };
  } catch {
    return { version: 1, skills: [] };
  }
}

/** jsonb 列が文字列で保存されていても（旧データ）オブジェクトとして読む。 */
export function normalizeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  const normalized = normalizeJsonValue(value);
  if (Array.isArray(normalized)) return normalized.map((item) => String(item));
  return [];
}

function asObject(value: unknown): Record<string, unknown> {
  const normalized = normalizeJsonValue(value);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    return normalized as Record<string, unknown>;
  }
  return {};
}

function asArgs(value: unknown): unknown[] {
  const normalized = normalizeJsonValue(value);
  return Array.isArray(normalized) ? normalized : [];
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toSkillRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    summary: row.summary,
    symptoms: asStringArray(row.symptoms),
    os: Array.isArray(row.os) ? row.os.map((item) => String(item)) : asStringArray(row.os),
    riskLevel: Number(row.risk_level),
    requires: asObject(row.requires),
    paramsSchema: asObject(row.params_schema),
    scriptPath: row.script_path,
    args: asArgs(row.args),
    verify: normalizeJsonValue(row.verify),
    rollback: normalizeJsonValue(row.rollback),
    timeoutSec: Number(row.timeout_sec),
    resultSchema: normalizeJsonValue(row.result_schema),
    outputPolicy: normalizeJsonValue(row.output_policy),
    status: row.status,
    contentHash: row.content_hash,
    approvedBy: row.approved_by,
    approvedAt: toIso(row.approved_at),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

/**
 * JSON Schema のうち、カタログで使う範囲を検証する。
 * object / string enum / required / additionalProperties:false / 型 / minimum / maximum。
 *
 * `minimum` / `maximum` は temp.cleanup の olderThanDays（1〜30）のような
 * 数値範囲をサーバ側でも強制するために見る（端末エージェント側でも再検証する）。
 * テンプレート引数に使う値だけを許可する。
 */
export function validateParams(
  schema: unknown,
  params: unknown,
): { ok: true } | { ok: false; message: string } {
  const root = asObject(schema);
  const value = normalizeJsonValue(params);
  if (value === null || value === undefined) {
    return { ok: false, message: 'パラメータが必要です。' };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'パラメータはオブジェクトで指定してください。' };
  }
  const record = value as Record<string, unknown>;
  const properties = asObject(root.properties);
  const required = asStringArray(root.required);
  for (const key of required) {
    if (!(key in record)) return { ok: false, message: `パラメータ ${key} が必要です。` };
  }
  for (const [key, raw] of Object.entries(record)) {
    const propertySchema = asObject(properties[key]);
    if (Object.keys(propertySchema).length === 0) {
      if (root.additionalProperties === false) {
        return { ok: false, message: `パラメータ ${key} は許可されていません。` };
      }
      continue;
    }
    const type = typeof propertySchema.type === 'string' ? propertySchema.type : undefined;
    if (type === 'string' && typeof raw !== 'string') {
      return { ok: false, message: `パラメータ ${key} は文字列で指定してください。` };
    }
    if (type === 'number' && typeof raw !== 'number') {
      return { ok: false, message: `パラメータ ${key} は数値で指定してください。` };
    }
    if (type === 'integer' && !Number.isInteger(raw)) {
      return { ok: false, message: `パラメータ ${key} は整数で指定してください。` };
    }
    if (type === 'boolean' && typeof raw !== 'boolean') {
      return { ok: false, message: `パラメータ ${key} は真偽値で指定してください。` };
    }
    if (type === 'number' || type === 'integer') {
      const numeric = typeof raw === 'number' ? raw : Number.NaN;
      const minimum = typeof propertySchema.minimum === 'number' ? propertySchema.minimum : null;
      const maximum = typeof propertySchema.maximum === 'number' ? propertySchema.maximum : null;
      if (minimum !== null && numeric < minimum) {
        return { ok: false, message: `パラメータ ${key} は ${minimum} 以上で指定してください。` };
      }
      if (maximum !== null && numeric > maximum) {
        return { ok: false, message: `パラメータ ${key} は ${maximum} 以下で指定してください。` };
      }
    }
    const allowed = asStringArray(propertySchema.enum);
    if (allowed.length > 0 && !allowed.includes(String(raw))) {
      return { ok: false, message: `パラメータ ${key} の値が許可されていません。` };
    }
  }
  return { ok: true };
}

/**
 * カタログ定義を DB へ upsert する（サーバ起動時）。
 * - スクリプトが存在すれば SHA-256 を保存し status=approved。
 * - 未作成なら status=draft（起動は止めない）。
 * - 内容が変わった場合だけ status / approved_by / approved_at をリセットする
 *   （再承認が必要。無変更の再起動で承認を失わない）。
 */
export async function ensureSkillCatalog(): Promise<void> {
  const manifest = readApprovalManifest(repoRoot);
  const approved = new Map(manifest.skills.map((entry) => [`${entry.id}@${entry.version}`, entry]));
  for (const skill of SKILL_CATALOG) {
    const absolutePath = path.join(repoRoot, skill.scriptPath);
    let scriptHash: string | null = null;
    let definitionHash: string | null = null;
    try {
      scriptHash = computeScriptHash(readFileSync(absolutePath));
      definitionHash = computeSkillDefinitionHash(skill, scriptHash);
    } catch {
      scriptHash = null;
      definitionHash = null;
    }
    // 人間が承認した manifest と完全一致したときだけ approved にする。
    // スクリプト・引数・リスク・スキーマ等が変われば自動的に draft へ戻る。
    const entry = approved.get(`${skill.id}@${skill.version}`);
    const isApproved = Boolean(
      entry &&
        scriptHash &&
        definitionHash &&
        entry.scriptHash === scriptHash &&
        entry.contentHash === definitionHash,
    );
    const status = isApproved ? 'approved' : 'draft';
    const approvedBy = isApproved ? entry!.approvedBy : null;
    const approvedAt = isApproved ? new Date(entry!.approvedAt) : null;

    await sql`
      INSERT INTO skills (
        id, version, title, summary, symptoms, os, risk_level, requires, params_schema,
        script_path, args, verify, rollback, timeout_sec, result_schema, output_policy,
        status, content_hash, approved_by, approved_at
      ) VALUES (
        ${skill.id}, ${skill.version}, ${skill.title}, ${skill.summary},
        ${jsonbValue(skill.symptoms)}, ${skill.os}::text[], ${skill.riskLevel},
        ${jsonbValue(skill.requires)}, ${jsonbValue(skill.paramsSchema)},
        ${skill.scriptPath}, ${jsonbValue(skill.args)},
        ${skill.verify === null ? null : jsonbValue(skill.verify)},
        ${skill.rollback === null ? null : jsonbValue(skill.rollback)},
        ${skill.timeoutSec},
        ${skill.resultSchema === null ? null : jsonbValue(skill.resultSchema)},
        ${skill.outputPolicy === null ? null : jsonbValue(skill.outputPolicy)},
        ${status}, ${definitionHash}, ${approvedBy}, ${approvedAt}
      )
      ON CONFLICT (id, version) DO UPDATE SET
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        symptoms = EXCLUDED.symptoms,
        os = EXCLUDED.os,
        risk_level = EXCLUDED.risk_level,
        requires = EXCLUDED.requires,
        params_schema = EXCLUDED.params_schema,
        script_path = EXCLUDED.script_path,
        args = EXCLUDED.args,
        verify = EXCLUDED.verify,
        rollback = EXCLUDED.rollback,
        timeout_sec = EXCLUDED.timeout_sec,
        result_schema = EXCLUDED.result_schema,
        output_policy = EXCLUDED.output_policy,
        content_hash = EXCLUDED.content_hash,
        status = EXCLUDED.status,
        approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at
    `;
  }
}

/** 承認済み Skill の一覧（画面のカタログ表示・提案候補）。 */
export async function listApprovedSkills(): Promise<SkillRecord[]> {
  const rows = await sql<SkillRow[]>`
    SELECT * FROM skills
    WHERE status = 'approved'
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map(toSkillRecord);
}

/** id + version で承認済み Skill を取得する（承認直前の再検証）。 */
export async function getApprovedSkill(id: string, version: string): Promise<SkillRecord | null> {
  const rows = await sql<SkillRow[]>`
    SELECT * FROM skills
    WHERE id = ${id} AND version = ${version} AND status = 'approved'
    LIMIT 1
  `;
  const row = rows[0];
  return row ? toSkillRecord(row) : null;
}
