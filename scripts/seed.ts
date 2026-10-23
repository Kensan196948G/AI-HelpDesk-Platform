import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import postgres from 'postgres';
import { hashPassword } from '../apps/api/src/auth/password.js';
import { computeAuditHash, GENESIS_HASH } from '../apps/api/src/domain/audit.js';
import { buildDemoPcSnapshot } from '../apps/api/src/domain/pc.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const envFile = process.env.NODE_ENV === 'test' ? '.env.test.local' : '.env.local';
if (existsSync(path.join(root, envFile))) {
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

const U = {
  yamada: '11111111-1111-4111-8111-111111111111',
  kimura: '22222222-2222-4222-8222-222222222222',
  ogawa: '33333333-3333-4333-8333-333333333333',
  sato: '44444444-4444-4444-8444-444444444444',
  takahashi: '55555555-5555-4555-8555-555555555555',
  watanabe: '66666666-6666-4666-8666-666666666666',
};

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
];

const auditPayload = {
  actorId: null,
  action: 'seed_demo_data',
  targetType: 'system',
  targetId: 'seed',
  detail: { cases: 3, knowledge: 4 },
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
        ${JSON.stringify(caseOnePc.items)}::jsonb, ${JSON.stringify(caseOnePc.concerns)}::jsonb, true, 'demo'
      ) ON CONFLICT (case_id) DO NOTHING
    `;
    await tx`
      INSERT INTO pc_snapshots (id, case_id, collected_at, items, concerns, shared, source)
      VALUES (
        ${'b0000002-0000-4000-8000-000000000002'}, ${C.two}, now() - interval '3 hours',
        ${JSON.stringify(caseTwoPc.items)}::jsonb, ${JSON.stringify(caseTwoPc.concerns)}::jsonb, true, 'demo'
      ) ON CONFLICT (case_id) DO NOTHING
    `;

    await tx`
      INSERT INTO tickets (
        id, case_id, tkt_no, inc_no, assignee_id, status, handoff_memo, shared_fields, created_at, updated_at
      ) VALUES (
        ${'d0000001-0000-4000-8000-000000000001'}, ${C.one}, 'TKT-2026-0001', 'INC-2026-0001',
        ${U.sato}, 'resolved',
        '推定分野: ID・アクセス権 / 共有フォルダ。推奨: 共有フォルダの ACL を確認し、所属グループを追加。',
        ${JSON.stringify(['consultation', 'ai', 'device', 'pc'])}::jsonb,
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
        ${JSON.stringify(['consultation', 'ai', 'device', 'pc'])}::jsonb,
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
        ${JSON.stringify(['consultation', 'ai'])}::jsonb,
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
          ${JSON.stringify(auditPayload.detail)}::jsonb, ${GENESIS_HASH}, ${auditHash}
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
    '[seed] done（users=6, knowledge=4, cases=3, demo password は環境変数 SEED_PASSWORD）',
  );
} catch (error) {
  console.error('[seed] failed:', error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
