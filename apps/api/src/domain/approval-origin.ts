/**
 * 承認済み KB の出所。AI の根拠にしてよいかの判定（findApprovedKnowledge）は変えず、
 * 誰の承認かを事実のまま区別して表示とプロンプトへ渡す（docs/64 §9）。
 */
export type ApprovalOrigin = 'other_person' | 'shared_identity' | 'seed';

export const APPROVAL_ORIGIN_LABEL: Readonly<Record<ApprovalOrigin, string>> = {
  other_person: '別の担当者が承認',
  shared_identity: '同一人物の別アカウントが承認',
  seed: '初期登録の資料（人の承認記録なし）',
};

/** config に依存しない（scripts/seed.ts が dotenv の前に読み込むため）。auth/shared-identity.ts からも使う。 */
export function parseSharedIdentityGroups(raw: string): string[][] {
  return String(raw || '')
    .split(';')
    .map((group) =>
      group
        .split('|')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    )
    .filter((group) => group.length >= 2);
}

export const UNKNOWN_ORIGIN_LABEL = '出所を確認できません';

export function approvalOriginLabel(origin: unknown): string {
  return typeof origin === 'string' && Object.hasOwn(APPROVAL_ORIGIN_LABEL, origin)
    ? APPROVAL_ORIGIN_LABEL[origin as ApprovalOrigin]
    : UNKNOWN_ORIGIN_LABEL;
}

/**
 * scripts/seed.ts が作る利用者の固定 ID。seed の判定の根拠にする。
 * メールのドメインは使わない（@example.com は検証の実アカウントにも使い得る）。
 * 本番で同じ ID か確かめるには report-state-kb-provenance.mjs の db.usableSeed を見る。
 */
export const SEED_USER_IDS = {
  yamada: '11111111-1111-4111-8111-111111111111',
  kimura: '22222222-2222-4222-8222-222222222222',
  ogawa: '33333333-3333-4333-8333-333333333333',
  sato: '44444444-4444-4444-8444-444444444444',
  takahashi: '55555555-5555-4555-8555-555555555555',
  watanabe: '66666666-6666-4666-8666-666666666666',
} as const;

const SEED_IDS: ReadonlySet<string> = new Set(Object.values(SEED_USER_IDS));

export interface ApprovalParties {
  authorId: string;
  approverId: string;
  authorEmail?: string | null;
  approverEmail?: string | null;
}

/** 作成者と承認者の両方がシードの利用者なら seed。承認者が同一人物の別アカウントなら shared_identity。 */
export function approvalOriginOf(parties: ApprovalParties, sharedGroups: string): ApprovalOrigin {
  if (SEED_IDS.has(parties.authorId) && SEED_IDS.has(parties.approverId)) return 'seed';
  const author = String(parties.authorEmail ?? '').toLowerCase();
  const approver = String(parties.approverEmail ?? '').toLowerCase();
  const shared =
    Boolean(author && approver) &&
    author !== approver &&
    parseSharedIdentityGroups(sharedGroups).some(
      (group) => group.includes(author) && group.includes(approver),
    );
  return shared ? 'shared_identity' : 'other_person';
}
