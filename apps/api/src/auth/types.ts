// 4 職務の分離（docs/43 Phase B）。`auditor` は読み取り専用、`itops` は端末系の担当。
// 既存の 3 ロールは挙動を変えない（移行期は Access グループ未設定でも現行動作を維持する）。
export type Role = 'requester' | 'helpdesk' | 'approver' | 'auditor' | 'itops';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  /** 主ロール（users.role）。後方互換のため残す。 */
  role: Role;
  /** 実際のロール集合（user_roles。空なら [role]）。docs/49 */
  roles?: Role[];
}

export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    sessionTokenHash?: string;
    uiEmail?: string;
    // ログインに使われた生のメール（別名の正規化前）。表示用。
    loginEmail?: string;
    // RSP のサーバ間連携で認証されたリクエスト（[docs/36-rsp-integration.md]）。
    integration?: 'rsp';
  }
}
