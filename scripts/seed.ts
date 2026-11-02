import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { hashPassword } from '../apps/api/src/auth/password.js';
import { SEED_USER_IDS } from '../apps/api/src/domain/approval-origin.js';
import { computeAuditHash, GENESIS_HASH } from '../apps/api/src/domain/audit.js';
import { buildDemoPcSnapshot } from '../apps/api/src/domain/pc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const envFile =
  process.env.NODE_ENV === 'test'
    ? '.env.test.local'
    : process.env.NODE_ENV === 'production'
      ? null
      : '.env.local';
if (envFile && existsSync(path.join(root, envFile))) {
  config({ path: path.join(root, envFile), override: true });
} else {
  config({ path: path.join(root, '.env') });
}

const databaseUrl = process.env.DATABASE_URL;
const seedPassword = process.env.SEED_PASSWORD;
if (!databaseUrl) {
  console.error('[seed] DATABASE_URL が設定されていません。');
  process.exit(1);
}
if (!seedPassword) {
  console.error('[seed] SEED_PASSWORD が設定されていません。');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

// 承認の出所の判定（seed）に使うので、固定 ID は domain/approval-origin.ts に置く。
const U = SEED_USER_IDS;

const C = {
  one: 'c0000001-0000-4000-8000-000000000001',
  two: 'c0000002-0000-4000-8000-000000000002',
  three: 'c0000003-0000-4000-8000-000000000003',
};

const K = {
  one: 'a0000001-0000-4000-8000-000000000001',
  two: 'a0000002-0000-4000-8000-000000000002',
  three: 'a0000003-0000-4000-8000-000000000003',
  four: 'a0000004-0000-4000-8000-000000000004',
  five: 'a0000005-0000-4000-8000-000000000005',
  six: 'a0000006-0000-4000-8000-000000000006',
  seven: 'a0000007-0000-4000-8000-000000000007',
  eight: 'a0000008-0000-4000-8000-000000000008',
  nine: 'a0000009-0000-4000-8000-000000000009',
};

const demoPasswordHash = hashPassword(seedPassword);

const caseOnePc = buildDemoPcSnapshot({
  category: 'file_share',
  subject: '共有フォルダが開けません',
  body: '工事写真を保存しようとすると「アクセスが拒否されました」と表示されます。先週までは使えていました。VPNには接続しています。',
});
const caseTwoPc = buildDemoPcSnapshot({
  category: 'pc_network',
  subject: 'VPNにつながらない（現場）',
  body: '現場から社内の共有フォルダに接続できません。VPNクライアントは起動していますが、つながりません。',
});

const knowledgeRows = [
  {
    id: K.one,
    kbNo: 'KB-2026-0001',
    caseId: C.one,
    title: '共有フォルダにアクセスできないときの確認手順',
    symptom: '共有フォルダを開くと「アクセスが拒否されました」と表示される。VPN接続は正常。',
    cause: '共有フォルダのセキュリティグループに、利用者が所属していないため。',
    steps:
      '1. 共有フォルダの ACL を確認する\n2. 所属部署のセキュリティグループを追加する（権限付与の手続き）\n3. 利用者に再接続を依頼し、保存できることを確認する',
    keywords: ['共有フォルダ', 'アクセス拒否', 'セキュリティグループ', 'VPN', '保存'],
    status: 'approved',
    authorId: U.sato,
    approverId: U.watanabe,
    version: 3,
  },
  {
    id: K.two,
    kbNo: 'KB-2026-0002',
    caseId: null,
    title: 'Teamsの音が出ないとき（出力先の確認）',
    symptom: 'Teams の会議で相手の音が聞こえない。PC の音は出ている。',
    cause: '音声の出力先がモニター（HDMI）になっているため。',
    steps:
      '1. Windows の音声出力先をヘッドセットに変更する\n2. Teams の設定でスピーカーを確認する\n3. 会議を再参加して音を確認する',
    keywords: ['Teams', '音', 'ヘッドセット', 'スピーカー', '会議'],
    status: 'approved',
    authorId: U.takahashi,
    approverId: U.watanabe,
    version: 2,
  },
  {
    id: K.three,
    kbNo: 'KB-2026-0003',
    caseId: null,
    title: '印刷ジョブが消えないときの対処',
    symptom: '印刷キューにジョブが残り、新しい印刷ができない。',
    cause: '印刷スプーラの停止、またはエラージョブの残存。',
    steps:
      '1. 印刷キューを開き、エラーのジョブを削除する\n2. 印刷スプーラを再起動する\n3. テスト印刷を実行する',
    keywords: ['印刷', 'プリンタ', 'スプーラ', 'キュー'],
    status: 'approved',
    authorId: U.sato,
    approverId: U.watanabe,
    version: 1,
  },
  {
    id: K.four,
    kbNo: 'KB-2026-0004',
    caseId: null,
    title: 'VPNにつながらないときの確認手順',
    symptom: 'VPN クライアントは起動するが、社内ポータルに到達できない。',
    cause: 'VPN 仮想アダプタの無効化、または接続先の一時的な障害。',
    steps:
      '1. VPN クライアントを切断し、再接続する\n2. 仮想アダプタが有効か確認する\n3. 社内ポータルに到達できるか確認する\n4. 改善しない場合は接続環境とあわせて担当者へ',
    keywords: ['VPN', '接続', 'ネットワーク', '現場'],
    status: 'approved',
    authorId: U.takahashi,
    approverId: U.watanabe,
    version: 1,
  },
  {
    id: K.five,
    kbNo: 'KB-2026-0005',
    caseId: null,
    title: 'PCが重い・動作が遅いときの一次切り分け',
    symptom: 'アプリの起動や操作が遅い、マウスが固まる、ファンが回り続ける。',
    cause: 'CPU・メモリ・ディスクの負荷、空き容量不足、更新の再起動待ち、常駐ソフトの影響。',
    steps: `1. Ctrl + Shift + Esc でタスクマネージャーを開き、「プロセス」タブで CPU・メモリ・ディスクの使用率が高いアプリを確認する（終了は作業に影響するため、まずアプリ名と使用率を控える）
2. 「パフォーマンス」タブでメモリとディスクの空きを確認する。C: の空きが 10〜15% 未満なら、不要なファイルや一時ファイルを整理する
3. Windows Update の再起動待ち、または前回の再起動から日数が長い場合は、作業を保存して再起動する
4. 改善しない場合は、PC基本情報（CPU・メモリ・ディスク・導入ソフト）を添えて担当者へ引き継ぐ`,
    keywords: [
      '重い',
      '遅い',
      '動作',
      'CPU',
      'メモリ',
      'ディスク',
      '空き容量',
      'タスクマネージャー',
      '再起動',
      'パフォーマンス',
    ],
    status: 'approved',
    authorId: U.sato,
    approverId: U.watanabe,
    version: 1,
  },
  {
    id: K.six,
    kbNo: 'KB-2026-0006',
    caseId: null,
    title: 'Windows Update・再起動待ちの確認手順',
    symptom: '更新の通知が消えない、再起動を求められる、更新後に動作が不安定。',
    cause: '更新プログラムの適用待ち、または再起動待ち。',
    steps: `1. 設定 > Windows Update を開き、更新の状態を確認する
2. 「再起動が必要」と表示されている場合は、作業を保存して再起動する
3. 再起動後にもう一度更新を確認し、エラーコードが出た場合は控える
4. 更新が失敗し続ける場合は、エラーコードと PC 基本情報を添えて担当者へ`,
    keywords: ['Windows Update', '更新', '再起動', '更新プログラム', 'KB', 'エラーコード'],
    status: 'approved',
    authorId: U.takahashi,
    approverId: U.watanabe,
    version: 1,
  },
  {
    id: K.seven,
    kbNo: 'KB-2026-0007',
    caseId: null,
    title: 'BitLocker・ディスク暗号化の状態確認',
    symptom: 'ディスク暗号化の状態を確認したい、回復キーが必要、端末の紛失・盗難が心配。',
    cause: 'BitLocker の保護状態が不明、または回復キーの保管場所が不明。',
    steps: `1. 設定 > プライバシーとセキュリティ > デバイスの暗号化（または BitLocker の管理）を開き、保護の状態を確認する
2. 管理者に確認できる場合は、コマンドプロンプトで manage-bde -status を実行し、Protection Status（保護の状態）を確認する
3. 保護がオフの場合は、自分で有効化せず、資産管理の担当者へ相談する
4. 回復キーが必要な場合も、自分で再発行せず担当者へ`,
    keywords: ['BitLocker', '暗号化', 'ディスク暗号化', '回復キー', '保護', '紛失', '盗難'],
    status: 'approved',
    authorId: U.sato,
    approverId: U.watanabe,
    version: 1,
  },
  {
    id: K.eight,
    kbNo: 'KB-2026-0008',
    caseId: null,
    title: 'Defender・ウイルス対策の状態確認',
    symptom: 'ウイルス対策が有効か確認したい、不審なファイルや警告が出た。',
    cause: 'Defender の保護が無効、定義ファイルが古い、または不審なファイルの実行。',
    steps: `1. Windows セキュリティ > ウイルスと脅威の防止 を開き、リアルタイム保護が有効か確認する
2. 定義ファイルの更新状態を確認し、更新があれば適用する
3. クイック スキャンを実行する
4. 不審なファイル・メール・警告が出た場合は、端末をネットワークから切断し、電源を切らずにセキュリティ担当へ連絡する（AIは判断しない）`,
    keywords: [
      'Defender',
      'ウイルス',
      'セキュリティ',
      '不審',
      '感染',
      'スキャン',
      '脅威',
      'リアルタイム保護',
    ],
    status: 'approved',
    authorId: U.takahashi,
    approverId: U.watanabe,
    version: 1,
  },
  {
    id: K.nine,
    kbNo: 'KB-2026-0009',
    caseId: null,
    title: 'ソフトウェア導入・ライセンスの確認手順',
    symptom: '必要なソフトが入っていない、バージョンを確認したい、導入を依頼したい。',
    cause: 'ソフト未導入、ライセンス未割当、または管理者権限の不足。',
    steps: `1. 設定 > アプリ > インストールされているアプリ で、必要なソフトが入っているか確認する
2. 必要なソフト名・バージョン・用途を担当者へ伝える
3. 管理者権限での自己インストールやライセンスの自己取得は行わない
4. 導入後は、設定 > アプリ でバージョンを確認する`,
    keywords: [
      'ソフト',
      'インストール',
      '導入',
      'ライセンス',
      'アプリ',
      'バージョン',
      '管理者権限',
    ],
    status: 'approved',
    authorId: U.sato,
    approverId: U.watanabe,
    version: 1,
  },
];

const auditPayload = {
  actorId: null,
  action: 'seed_demo_data',
  targetType: 'system',
  targetId: 'seed',
  detail: { cases: 3, knowledge: knowledgeRows.length },
};
const auditHash = computeAuditHash(GENESIS_HASH, auditPayload);

try {
  await sql.begin(async (tx) => {
    for (const user of [
      { id: U.yamada, email: 'yamada@example.com', name: '山田 太郎', role: 'requester' },
      { id: U.kimura, email: 'kimura@example.com', name: '木村 花子', role: 'requester' },
      { id: U.ogawa, email: 'ogawa@example.com', name: '小川 一郎', role: 'requester' },
      { id: U.sato, email: 'sato@example.com', name: '佐藤 健', role: 'helpdesk' },
      { id: U.takahashi, email: 'takahashi@example.com', name: '高橋 直人', role: 'helpdesk' },
      {
        id: U.watanabe,
        email: 'watanabe@example.com',
        name: '渡辺 修',
        role: 'approver',
      },
    ]) {
      await tx`
        INSERT INTO users (id, email, name, role, password_hash)
        VALUES (${user.id}, ${user.email}, ${user.name}, ${user.role}, ${demoPasswordHash})
        ON CONFLICT DO NOTHING
      `;
    }

    await tx`
      INSERT INTO cases (
        id, case_no, requester_id, category, subject, body, urgency, signal,
        current_step, status, shared_pc_info, resolved_at, completed_at, created_at, updated_at
      ) VALUES (
        ${C.one}, 'TKT-2026-0001', ${U.yamada}, 'file_share',
        '共有フォルダが開けません',
        '工事写真を保存しようとすると「アクセスが拒否されました」と表示されます。先週までは使えていました。VPNには接続しています。',
        'normal', 'blue', 7, 'completed', true,
        now() - interval '2 days', now() - interval '1 day',
        now() - interval '2 days', now() - interval '1 day'
      ) ON CONFLICT (case_no) DO NOTHING
    `;

    await tx`
      INSERT INTO cases (
        id, case_no, requester_id, category, subject, body, urgency, signal,
        current_step, status, shared_pc_info, created_at, updated_at
      ) VALUES (
        ${C.two}, 'TKT-2026-0002', ${U.ogawa}, 'pc_network',
        'VPNにつながらない（現場）',
        '現場から社内の共有フォルダに接続できません。VPNクライアントは起動していますが、つながりません。',
        'normal', 'amber', 5, 'in_progress', true,
        now() - interval '3 hours', now() - interval '2 hours'
      ) ON CONFLICT (case_no) DO NOTHING
    `;

    await tx`
      INSERT INTO cases (
        id, case_no, requester_id, category, subject, body, urgency, signal,
        current_step, status, shared_pc_info, created_at, updated_at
      ) VALUES (
        ${C.three}, 'TKT-2026-0003', ${U.kimura}, 'security',
        '不審なメールを開いてしまった',
        '件名に「請求書の確認」とあるメールの添付ファイルを開いてしまいました。ウイルスかもしれません。',
        'normal', 'red', 5, 'in_progress', false,
        now() - interval '90 minutes', now() - interval '80 minutes'
      ) ON CONFLICT (case_no) DO NOTHING
    `;

    await tx`
      INSERT INTO pc_snapshots (id, case_id, collected_at, items, concerns, shared, source)
      VALUES (
        ${'b0000001-0000-4000-8000-000000000001'}, ${C.one}, now() - interval '2 days',
        ${sql.json(caseOnePc.items)}, ${sql.json(caseOnePc.concerns)}, true, 'demo'
      ) ON CONFLICT (case_id) DO NOTHING
    `;
    await tx`
      INSERT INTO pc_snapshots (id, case_id, collected_at, items, concerns, shared, source)
      VALUES (
        ${'b0000002-0000-4000-8000-000000000002'}, ${C.two}, now() - interval '3 hours',
        ${sql.json(caseTwoPc.items)}, ${sql.json(caseTwoPc.concerns)}, true, 'demo'
      ) ON CONFLICT (case_id) DO NOTHING
    `;

    await tx`
      INSERT INTO tickets (
        id, case_id, tkt_no, inc_no, assignee_id, status, handoff_memo, shared_fields, created_at, updated_at
      ) VALUES (
        ${'d0000001-0000-4000-8000-000000000001'}, ${C.one}, 'TKT-2026-0001', 'INC-2026-0001',
        ${U.sato}, 'resolved',
        '推定分野: ID・アクセス権 / 共有フォルダ。推奨: 共有フォルダの ACL を確認し、所属グループを追加。',
        ${sql.json(['consultation', 'ai', 'device', 'pc'])},
        now() - interval '2 days', now() - interval '1 day'
      ) ON CONFLICT (case_id) DO NOTHING
    `;
    await tx`
      INSERT INTO tickets (
        id, case_id, tkt_no, inc_no, assignee_id, status, handoff_memo, shared_fields, created_at, updated_at
      ) VALUES (
        ${'d0000002-0000-4000-8000-000000000002'}, ${C.two}, 'TKT-2026-0002', 'INC-2026-0002',
        ${U.sato}, 'assigned',
        '推定分野: ネットワーク / VPN。推奨: VPN 仮想アダプタと接続先を確認。',
        ${sql.json(['consultation', 'ai', 'device', 'pc'])},
        now() - interval '3 hours', now() - interval '2 hours'
      ) ON CONFLICT (case_id) DO NOTHING
    `;
    await tx`
      INSERT INTO tickets (
        id, case_id, tkt_no, inc_no, assignee_id, status, handoff_memo, shared_fields, created_at, updated_at
      ) VALUES (
        ${'d0000003-0000-4000-8000-000000000003'}, ${C.three}, 'TKT-2026-0003', 'INC-2026-0003',
        ${U.takahashi}, 'assigned',
        'セキュリティ事象の可能性。AI は判断せず、初動手順のみ案内済み。',
        ${sql.json(['consultation', 'ai'])},
        now() - interval '90 minutes', now() - interval '80 minutes'
      ) ON CONFLICT (case_id) DO NOTHING
    `;

    await tx`
      INSERT INTO resolutions (id, ticket_id, case_id, author_id, cause, steps, duration_min)
      VALUES (
        ${'e0000001-0000-4000-8000-000000000001'}, ${'d0000001-0000-4000-8000-000000000001'}, ${C.one},
        ${U.sato},
        '共有フォルダのセキュリティグループに所属していなかったため。',
        '1. 共有フォルダの ACL を確認\n2. 所属部署のセキュリティグループを追加\n3. 再接続を依頼し、保存できることを確認',
        25
      ) ON CONFLICT (ticket_id) DO NOTHING
    `;

    for (const kb of knowledgeRows) {
      await tx`
        INSERT INTO knowledge (
          id, kb_no, case_id, resolution_id, title, symptom, cause, steps, keywords,
          status, author_id, approver_id, version, approved_at, created_at, updated_at
        ) VALUES (
          ${kb.id}, ${kb.kbNo}, ${kb.caseId},
          ${kb.kbNo === 'KB-2026-0001' ? 'e0000001-0000-4000-8000-000000000001' : null},
          ${kb.title}, ${kb.symptom}, ${kb.cause}, ${kb.steps}, ${kb.keywords},
          ${kb.status}, ${kb.authorId}, ${kb.approverId}, ${kb.version},
          now() - interval '1 day', now() - interval '2 days', now() - interval '1 day'
        ) ON CONFLICT (kb_no) DO NOTHING
      `;
    }

    const messages = [
      {
        id: 9001,
        caseId: C.one,
        authorId: U.yamada,
        role: 'user',
        kind: 'consultation',
        content: '共有フォルダが開けません。',
        minutesAgo: 2880,
      },
      {
        id: 9002,
        caseId: C.one,
        authorId: null,
        role: 'assistant',
        kind: 'ai_assessment',
        content:
          'PC基本情報を確認しました。気になる点が2件あります。承認済みナレッジ「共有フォルダにアクセスできないときの確認手順」を根拠に案内します。',
        minutesAgo: 2879,
      },
      {
        id: 9003,
        caseId: C.one,
        authorId: U.sato,
        role: 'system',
        kind: 'resolution',
        content: '共有フォルダのセキュリティグループ追加で解決しました。所要時間 25分。',
        minutesAgo: 1500,
      },
      {
        id: 9011,
        caseId: C.two,
        authorId: U.ogawa,
        role: 'user',
        kind: 'consultation',
        content: '現場から共有フォルダに接続できません。VPNがつながりません。',
        minutesAgo: 180,
      },
      {
        id: 9012,
        caseId: C.two,
        authorId: null,
        role: 'assistant',
        kind: 'ai_assessment',
        content:
          '承認済みナレッジ「VPNにつながらないときの確認手順」を根拠に案内します。VPNの再接続と仮想アダプタを確認してください。',
        minutesAgo: 179,
      },
      {
        id: 9013,
        caseId: C.two,
        authorId: null,
        role: 'system',
        kind: 'handoff',
        content: '担当者へ引き継ぎました（TKT-2026-0002 / INC-2026-0002）。',
        minutesAgo: 170,
      },
      {
        id: 9021,
        caseId: C.three,
        authorId: U.kimura,
        role: 'user',
        kind: 'consultation',
        content: '不審なメールの添付ファイルを開いてしまいました。',
        minutesAgo: 90,
      },
      {
        id: 9022,
        caseId: C.three,
        authorId: null,
        role: 'assistant',
        kind: 'ai_assessment',
        content:
          'セキュリティの心配として受け付けました。AIは判断しません。端末をネットワークから切断し、セキュリティ担当へ引き継いでください。',
        minutesAgo: 89,
      },
      {
        id: 9023,
        caseId: C.three,
        authorId: null,
        role: 'system',
        kind: 'handoff',
        content: 'セキュリティ担当へ引き継ぎました（TKT-2026-0003 / INC-2026-0003）。',
        minutesAgo: 85,
      },
    ];

    for (const message of messages) {
      await tx`
        INSERT INTO case_messages (id, case_id, author_id, role, kind, content, created_at)
        VALUES (
          ${message.id}, ${message.caseId}, ${message.authorId}, ${message.role}, ${message.kind},
          ${message.content}, now() - (${message.minutesAgo} * interval '1 minute')
        ) ON CONFLICT (id) DO NOTHING
      `;
    }

    const existingAudit = await tx<{ count: string }[]>`
      SELECT count(*)::text AS count FROM audit_log WHERE action = 'seed_demo_data'
    `;
    if (existingAudit[0]?.count === '0') {
      await tx`
        INSERT INTO audit_log (actor_id, action, target_type, target_id, detail, prev_hash, hash)
        VALUES (
          null, ${auditPayload.action}, ${auditPayload.targetType}, ${auditPayload.targetId},
          ${sql.json(auditPayload.detail)}, ${GENESIS_HASH}, ${auditHash}
        )
      `;
    }

    await tx`SELECT setval('case_no_seq', GREATEST((SELECT last_value FROM case_no_seq), (SELECT COALESCE(max(NULLIF(split_part(case_no, '-', 3), '')::int), 0) + 1 FROM cases), 100), true)`;
    await tx`SELECT setval('inc_no_seq', GREATEST((SELECT last_value FROM inc_no_seq), (SELECT COALESCE(max(NULLIF(split_part(inc_no, '-', 3), '')::int), 0) + 1 FROM tickets), 100), true)`;
    await tx`SELECT setval('kb_no_seq', GREATEST((SELECT last_value FROM kb_no_seq), (SELECT COALESCE(max(NULLIF(split_part(kb_no, '-', 3), '')::int), 0) + 1 FROM knowledge), 100), true)`;
    await tx`SELECT setval('case_messages_id_seq', GREATEST((SELECT last_value FROM case_messages_id_seq), (SELECT COALESCE(max(id), 0) + 1 FROM case_messages), 10000), true)`;
    await tx`SELECT setval('audit_log_id_seq', GREATEST((SELECT last_value FROM audit_log_id_seq), (SELECT COALESCE(max(id), 0) + 1 FROM audit_log), 10000), true)`;
  });

  console.log(
    '[seed] done（users=6, knowledge=' +
      knowledgeRows.length +
      ', cases=3, demo password は環境変数 SEED_PASSWORD）',
  );
} catch (error) {
  console.error('[seed] failed:', error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
