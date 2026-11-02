import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('./honest-labels-bridge.js', import.meta.url), 'utf8');
const original = readFileSync(
  new URL(
    '../../../../Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html',
    import.meta.url,
  ),
  'utf8',
);

type Message = Record<string, unknown>;

const DEMO_SNAPSHOT = {
  device: 'MRK-NB-1024',
  items: [
    { k: 'OS', v: 'Windows 11 Enterprise 24H2' },
    { k: 'PCエージェント', v: 'v0.3（模擬）（署名あり・読み取りのみ）' },
  ],
};
const REAL_SNAPSHOT = {
  device: 'WEB-ABCD1234',
  items: [
    { k: 'OS', v: 'Windows 11 Pro' },
    { k: 'PCエージェント', v: 'ブラウザ取得（端末エージェント未導入）' },
  ],
};

function createSandbox(options: { snapshot?: unknown; locked?: boolean } = {}) {
  const intakeCalls: Array<Record<string, unknown>> = [];
  const ticketCalls: Array<Record<string, unknown>> = [];
  const state = {
    ui: { chat: 'chat-1', user: 'u1' },
    chats: [{ id: 'chat-1', userId: 'u1', messages: [] as Message[] }],
    cases: [] as Array<Record<string, unknown>>,
  };
  const sandbox: Record<string, unknown> = {
    S: state,
    msgMeta: (message: Message) => `${String(message.model)}|${String(message.conf)}`,
    renderMsg: (message: Message) => String(message.html ?? ''),
    asideHtml: () => '<li>AIが社内資料と端末の状態から対応しています</li>',
    paneHtml: () =>
      '<p class="lead">AIが社内資料と端末の状態（読み取りのみ）から答えます。修復の提案</p>' +
      '<b>AIの診断結果</b>' +
      '<b>端末の番号・OS</b><br><span class="u-small u-muted">MRK-NB-1024</span>',
    consentCard: (chat: { id: string }) => ({
      kind: 'consent',
      chatId: chat.id,
      reason:
        '本人がN（実行しない）を選択。提案: 取消（Lv3）／対象: 本人のエラージョブ：見積書_第3版.pdf／端末は変更していません。',
      ctx: {
        diag: ['PCエージェント接続：オンライン（MRK-NB-1024）', '印刷キュー：2件'],
        device: 'MRK-NB-1024／Windows 11 Enterprise 24H2',
        pc: [],
      },
    }),
    createTicket: (_state: unknown, ticket: Record<string, unknown>) => {
      ticketCalls.push(ticket);
      return ticket;
    },
    pcLines: () => ['実データの行'],
    pcCardHtml: () => '35項目を読み取りました',
    pcSnapshot: () => options.snapshot ?? null,
    USERS: { u1: { device: 'MRK-NB-1024' } },
    HD: {
      intake: (input: Record<string, unknown>) => {
        intakeCalls.push(input);
        return 'INC-1';
      },
    },
  };
  if (options.locked !== undefined) sandbox.PERSONA_LOCKED = options.locked;
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox);
  return { sandbox, state, intakeCalls, ticketCalls };
}

function call<T>(sandbox: Record<string, unknown>, name: string, ...args: unknown[]): T {
  return (sandbox[name] as (...values: unknown[]) => T)(...args);
}

describe('モデル表示（msgMeta）', () => {
  const metaOf = (message: Message) => call<string>(createSandbox().sandbox, 'msgMeta', message);

  it('実 AI（provider=deepseek）だけ DeepSeek と確信度を出す', () => {
    expect(
      metaOf({ model: 'DeepSeek-V4.1-Flash（自由記述のみ）', conf: '高', provider: 'deepseek' }),
    ).toBe('DeepSeek-V4.1-Flash|高');
  });

  it('ルールの回答は保存済みの DeepSeek 表示でもルールベースに直し、確信度を出さない', () => {
    const meta = metaOf({ model: 'DeepSeek-V4.1-Flash', conf: '高', after: undefined });
    expect(meta).toBe('ルールベース（デモデータ）|—');
    expect(meta).not.toContain('DeepSeek');
  });

  it('診断に続くルールの回答は実端末の結果でないことも出す', () => {
    expect(metaOf({ model: 'DeepSeek-V4.1-Flash', conf: '高', after: 'diag-1' })).toBe(
      'ルールベース（デモデータ・実端末の結果ではありません）|—',
    );
  });

  it('社内資料カード（provider なし）もルールベースとする', () => {
    expect(metaOf({ model: '社内ローカルLLM（模擬）', conf: '中', src: ['KB-001'] })).toBe(
      'ルールベース（デモデータ）|—',
    );
  });

  it('DeepSeek を使わなかったフォールバックに DeepSeek と出さない', () => {
    const meta = metaOf({ model: 'DeepSeek-V4.1-Flash', conf: '中', provider: 'fallback' });
    expect(meta).toBe('承認済みナレッジ検索（DeepSeek 未使用）|—');
  });

  it('担当者の追加質問（/api/ai/answer-case）の回答を実 AI とフォールバックで分ける', () => {
    // ahAskCase の新しい保存形式
    expect(metaOf({ model: 'deepseek-flash', conf: '高', provider: 'deepseek' })).toBe(
      'DeepSeek-V4.1-Flash|高',
    );
    expect(metaOf({ model: 'fallback', conf: '中', provider: 'fallback' })).toBe(
      '承認済みナレッジ検索（DeepSeek 未使用）|—',
    );
    // provider を保存する前の分（model が API の値）
    expect(metaOf({ model: 'deepseek-flash', conf: '高' })).toBe('DeepSeek-V4.1-Flash|高');
    expect(metaOf({ model: 'fallback', conf: '中' })).toBe(
      '承認済みナレッジ検索（DeepSeek 未使用）|—',
    );
    // サーバが案件へ追記した分
    expect(
      metaOf({ id: 'case-ai-1', model: 'DeepSeek-V4.1-Flash', provider: 'fallback', conf: '—' }),
    ).toBe('承認済みナレッジ検索（DeepSeek 未使用）|—');
    expect(metaOf({ id: 'case-ai-2', model: 'DeepSeek-V4.1-Flash', provider: 'deepseek' })).toBe(
      'DeepSeek-V4.1-Flash|undefined',
    );
    expect(metaOf({ id: 'case-ai-3', model: 'DeepSeek-V4.1-Flash' })).toBe(
      'DeepSeek-V4.1-Flash|undefined',
    );
  });

  it('由来が別のメッセージと、モデル欄のないメッセージは変えない', () => {
    expect(metaOf({ model: 'AIヘルプデスク連携', conf: undefined })).toBe(
      'AIヘルプデスク連携|undefined',
    );
    expect(metaOf({ model: 'システム' })).toBe('システム|undefined');
    expect(metaOf({ conf: undefined })).toBe('undefined|undefined');
  });

  it('端末エージェントが実行した結果はデモと表示しない', () => {
    expect(
      metaOf({ model: 'DeepSeek-V4.1-Flash', conf: '—', html: '<p>✅ 実端末で実行しました。</p>' }),
    ).toBe('端末エージェント（実端末）|—');
  });
});

describe('固定データの表示（renderMsg）', () => {
  const render = (kind: string, html: string) =>
    call<string>(createSandbox().sandbox, 'renderMsg', { kind, html });

  it('診断カードに実端末の結果でないと出し、取得したかのような説明を消す', () => {
    const html = render(
      'diag',
      '🔍 印刷トラブルの診断<span class="r">端末 MRK-NB-1024</span><div>取得するのは設定・サービス状態・件数のみ。ファイルの中身・閲覧履歴・画面は取得しません。</div>',
    );
    expect(html).toContain('デモデータ（実端末の結果ではありません）');
    expect(html).toContain('🔍 【デモデータ】印刷トラブル');
    expect(html).toContain('デモ端末 MRK-NB-1024');
    expect(html).not.toContain('取得するのは');
  });

  it('実行結果のサーバ検証・エージェント作業の主張を打ち消す', () => {
    const html = render(
      'exec',
      '🏁 完了・結果の確認<div>サーバ側の実行前検証</div><div>PCエージェントの作業</div>',
    );
    expect(html).toContain('🏁 完了・結果の確認：デモデータ（実端末の結果ではありません）');
    expect(html).toContain('サーバでは検証していません');
    expect(html).toContain('実端末は変更していません');
    expect(html).not.toContain('サーバ側の実行前検証');
  });

  it('提案と確認カードの端末情報をデモと明記する', () => {
    expect(render('proposal', '🛠️ 修復・作業の提案<dt>対象</dt>')).toBe(
      '🛠️ 修復・作業の提案【デモデータ】<dt>対象（デモ）</dt>',
    );
    const confirm = render(
      'confirm',
      '<dt>対象端末</dt><dt>端末の現状</dt>この内容で合っていますか？',
    );
    expect(confirm).toContain('<dt>対象端末（デモ）</dt>');
    expect(confirm).toContain('<dt>端末の現状（デモ）</dt>');
    expect(confirm).toContain('デモデータ（実端末の結果ではありません）');
  });

  it('端末エージェントへ実行を送った相談では「実端末は変更していません」と言い切らない', () => {
    const { sandbox } = createSandbox();
    const exec = { kind: 'exec', html: '⚙️ 実行<div>PCエージェントの作業</div>' };
    const before = { messages: [exec] };
    expect(call<string>(sandbox, 'renderMsg', exec, before)).toContain('実端末は変更していません');
    const real = { kind: 'ai', html: '<p>✅ 実端末で実行しました。</p>' };
    const html = call<string>(sandbox, 'renderMsg', exec, { messages: [exec, real] });
    expect(html).not.toContain('実端末は変更していません');
    expect(html).toContain('実端末での実行は下のメッセージを確認してください');
    // 実行カードより前の記録は関係しない
    expect(call<string>(sandbox, 'renderMsg', exec, { messages: [real, exec] })).toContain(
      '実端末は変更していません',
    );
  });

  it('タグを増減させない（文言だけの変更）', () => {
    const source =
      '🔍 診断<span class="r">端末 X</span><div class="small muted">取得するのは設定・サービス状態・件数のみ。ファイルの中身・閲覧履歴・画面は取得しません。</div>';
    const tags = (value: string) => value.match(/<[^>]+>/g);
    expect(tags(render('diag', source))).toEqual(tags(source));
  });

  it('実 AI の回答本文と利用者の発言は変更しない', () => {
    expect(render('ai', '<p>社員食堂の営業時間は…</p>')).toBe('<p>社員食堂の営業時間は…</p>');
    expect(render('user', '🔍 サーバ側の実行前検証')).toBe('🔍 サーバ側の実行前検証');
  });
});

describe('引継ぎへ渡す値', () => {
  const CHAT = { id: 'chat-1', userId: 'u1' };

  it('閲覧中のブラウザの端末（pcSnapshot）を依頼者の端末として渡さない', () => {
    // 事前取得を断った案件・別 PC・非所有者の閲覧はいずれも案件に記録が無い状態になる。
    for (const pc of [undefined, null, { state: 'running', snap: REAL_SNAPSHOT }]) {
      const { sandbox, state } = createSandbox({ snapshot: REAL_SNAPSHOT });
      state.cases.push({ chatId: 'chat-1', pc });
      const card = call<{ ctx: { device: string } }>(sandbox, 'consentCard', CHAT);
      expect(card.ctx.device).toBe('未取得（実端末の情報はありません）');
      const pane = call<string>(sandbox, 'paneHtml', { userId: 'u1', pc });
      expect(pane).not.toContain('WEB-ABCD1234');
      expect(pane).toContain('未取得（実端末の情報はありません）');
    }
  });

  it('固定データの記録もデモ端末として渡さない', () => {
    const { sandbox, state } = createSandbox();
    state.cases.push({ chatId: 'chat-1', pc: { state: 'done', snap: DEMO_SNAPSHOT } });
    const card = call<{ ctx: { device: string } }>(sandbox, 'consentCard', CHAT);
    expect(card.ctx.device).toBe('未取得（実端末の情報はありません）');
  });

  it('同意カードの案件に記録された実取得を使い、開いている別の相談を参照しない', () => {
    const { sandbox, state } = createSandbox();
    state.ui.chat = 'chat-other';
    state.cases.push(
      { chatId: 'chat-other', pc: { state: 'done', snap: { device: 'WEB-OTHER', items: [] } } },
      { chatId: 'chat-1', pc: { state: 'done', snap: REAL_SNAPSHOT } },
    );
    const card = call<{ ctx: { device: string } }>(sandbox, 'consentCard', CHAT);
    expect(card.ctx.device).toBe('WEB-ABCD1234／Windows 11 Pro');
  });

  it('STEP 4 の表示と同意カードの値が一致する', () => {
    const { sandbox, state } = createSandbox();
    const target = { chatId: 'chat-1', userId: 'u1', pc: { state: 'done', snap: REAL_SNAPSHOT } };
    state.cases.push(target);
    const card = call<{ ctx: { device: string } }>(sandbox, 'consentCard', CHAT);
    expect(call<string>(sandbox, 'paneHtml', target)).toContain(card.ctx.device);
  });

  it('修正前の同意カードは、描画の時点で表示と共有する値を揃える', () => {
    const { sandbox } = createSandbox({ snapshot: REAL_SNAPSHOT });
    const message = {
      kind: 'consent',
      state: 'pending',
      reason: '実行に失敗しました。操作: 取消／対象: 見積書_第3版.pdf',
      ctx: { device: 'MRK-NB-1024／Windows 11 Enterprise 24H2', diag: ['印刷キュー：2件'] },
    };
    call(sandbox, 'renderMsg', message, CHAT);
    expect(message.ctx.device).toBe('未取得（実端末の情報はありません）');
    expect(message.ctx.diag).toEqual(['【デモデータ】印刷キュー：2件']);
    expect(message.reason).not.toContain('見積書_第3版.pdf');
  });

  it('送信済みの同意カードは書き換えない', () => {
    const { sandbox } = createSandbox();
    const message = { kind: 'consent', state: 'sent', ctx: { device: 'MRK-NB-1024／X', diag: [] } };
    call(sandbox, 'renderMsg', message, CHAT);
    expect(message.ctx.device).toBe('MRK-NB-1024／X');
  });

  it('診断結果の各行をデモと明記し、理由から固定のジョブ名を除く', () => {
    const { sandbox } = createSandbox();
    const card = call<{ reason: string; ctx: { diag: string[] } }>(sandbox, 'consentCard', {
      id: 'chat-1',
      userId: 'u1',
    });
    expect(card.ctx.diag.every((line) => line.startsWith('【デモデータ】'))).toBe(true);
    expect(card.ctx.diag.join()).not.toContain('MRK-NB-1024');
    expect(card.reason).toContain('実端末の結果ではありません');
    expect(card.reason).toContain('本人がN');
    expect(card.reason).not.toContain('見積書_第3版.pdf');
  });

  it('チケットの端末は再計算せず、本人が見た値を渡す', () => {
    const { sandbox, state, ticketCalls } = createSandbox({ snapshot: { device: 'WEB-VIEWER' } });
    call(sandbox, 'createTicket', state, {
      userId: 'u1',
      shared: { 端末: 'WEB-ABCD1234／Windows 11 Pro' },
    });
    const shared = ticketCalls[0]?.shared as Record<string, unknown>;
    expect(shared.端末).toBe('WEB-ABCD1234／Windows 11 Pro');
  });

  it('描画を経ずに送られた古いカードの値も、チケットでデモを除く（重ねて印を付けない）', () => {
    const { sandbox, state, ticketCalls } = createSandbox({ snapshot: REAL_SNAPSHOT });
    call(sandbox, 'createTicket', state, {
      userId: 'u1',
      shared: {
        相談内容: '印刷できない',
        AIの診断結果: ['【デモデータ】印刷キュー：2件', 'VPN接続状態：接続中'],
        端末: 'MRK-NB-1024／Windows 11 Enterprise 24H2',
        '対応案（未実行・失敗）': '実行に失敗しました。操作: 取消／対象: 見積書_第3版.pdf',
      },
    });
    const shared = ticketCalls[0]?.shared as Record<string, unknown>;
    expect(shared.相談内容).toBe('印刷できない');
    expect(shared.AIの診断結果).toEqual([
      '【デモデータ】印刷キュー：2件',
      '【デモデータ】VPN接続状態：接続中',
    ]);
    expect(shared.端末).toBe('未取得（実端末の情報はありません）');
    expect(JSON.stringify(shared)).not.toContain('MRK-NB-1024');
    expect(JSON.stringify(shared)).not.toContain('WEB-ABCD1234');
    expect(JSON.stringify(shared)).not.toContain('見積書_第3版.pdf');
  });

  it('固定データのスナップショットは PC 基本情報として渡さない', () => {
    const { sandbox } = createSandbox();
    expect(call(sandbox, 'pcLines', { pc: { snap: DEMO_SNAPSHOT } })).toEqual([]);
    expect(call(sandbox, 'pcLines', { pc: { snap: REAL_SNAPSHOT } })).toEqual(['実データの行']);
    expect(call(sandbox, 'pcCardHtml', { pc: { snap: DEMO_SNAPSHOT } })).toContain(
      '実端末の結果ではありません',
    );
    expect(call(sandbox, 'pcCardHtml', { pc: { snap: REAL_SNAPSHOT } })).toBe(
      '35項目を読み取りました',
    );
  });

  it('名簿未登録で固定された利用者は、デモの氏名を依頼者として渡さない', () => {
    const locked = createSandbox({ locked: true });
    (locked.sandbox.HD as { intake: (input: unknown) => void }).intake({
      requester: '東京支店工事部 山田 太郎',
    });
    expect(locked.intakeCalls[0]?.requester).toBe('名簿未登録の利用者（氏名は未確認）');

    const normal = createSandbox({ locked: false });
    (normal.sandbox.HD as { intake: (input: unknown) => void }).intake({
      requester: 'DX推進部 社員',
    });
    expect(normal.intakeCalls[0]?.requester).toBe('DX推進部 社員');
  });
});

describe('ウィザードの文言（paneHtml / asideHtml）', () => {
  it('一次対応の説明と共有欄を事実に合わせる', () => {
    const { sandbox } = createSandbox({ snapshot: REAL_SNAPSHOT });
    const html = call<string>(sandbox, 'paneHtml', {
      userId: 'u1',
      pc: { state: 'done', snap: REAL_SNAPSHOT },
    });
    expect(html).not.toContain('端末の状態（読み取りのみ）から答えます');
    expect(html).toContain('それ以外の自由記述だけ DeepSeek');
    expect(html).toContain('<b>AIの診断結果（デモデータ：実端末の結果ではありません）</b>');
    expect(html).toContain('WEB-ABCD1234／Windows 11 Pro');
    expect(html).not.toContain('MRK-NB-1024');
    expect(call<string>(sandbox, 'asideHtml')).toBe(
      '<li>定型の相談はルールベース（デモデータ）で対応しています</li>',
    );
  });
});

describe('発言者・判定ヘルパー', () => {
  const honest = () =>
    createSandbox().sandbox.__AIHD_HONEST__ as {
      whoFor(message: Message): string;
      usedRealAi(chat: unknown): boolean;
      reportModel(chat: unknown): string;
    };

  it('担当者画面と報告書の発言者を実 AI とルールで分ける', () => {
    const api = honest();
    expect(api.whoFor({ provider: 'deepseek' })).toBe('AI（DeepSeek）');
    expect(api.whoFor({ model: 'DeepSeek-V4.1-Flash' })).toBe('ルールベース（デモデータ）');
    // 事故の初動案内などは実際の手順なのでデモと表示しない。
    expect(api.whoFor({ kind: 'block' })).toBe('定型の案内');
    expect(api.whoFor({ model: 'AIヘルプデスク連携' })).toBe('AIヘルプデスク連携');
  });

  it('報告書のモデル欄は実際に使ったものを書く', () => {
    const api = honest();
    const report = (...messages: Message[]) => api.reportModel({ messages });
    expect(report({ provider: 'deepseek' }, { provider: 'fallback' })).toBe('DeepSeek-V4.1-Flash');
    expect(report({ provider: 'fallback' })).toBe('承認済みナレッジ検索（DeepSeek 未使用）');
    expect(report({ provider: 'fallback' }, { model: 'x' })).toBe(
      '承認済みナレッジ検索（DeepSeek 未使用）',
    );
    expect(report({ model: 'x' })).toBe('ルールベース（デモデータ）');
    expect(api.reportModel(null)).toBe('ルールベース（デモデータ）');
  });

  it('実 AI の回答がある相談だけを実 AI 利用とする', () => {
    const api = honest();
    expect(api.usedRealAi({ messages: [{ provider: 'deepseek' }] })).toBe(true);
    expect(api.usedRealAi({ messages: [{ model: 'deepseek-flash' }] })).toBe(true);
    expect(api.usedRealAi({ messages: [{ provider: 'fallback' }, { model: 'x' }] })).toBe(false);
    expect(api.usedRealAi(null)).toBe(false);
  });
});

describe('原本 HTML との対応（文言や関数が変わると置換が黙って効かなくなる）', () => {
  it.each([
    'function msgMeta(m)',
    'function renderMsg(m,c)',
    'function paneHtml(c,L,r)',
    'function asideHtml(c,L)',
    'AIが社内資料と端末の状態から対応しています',
    'function consentCard(chat,',
    'function createTicket(st,o)',
    'function pcLines(c)',
    'function pcCardHtml(',
    'function pcAnnounce(c,chat)',
    'window.HD={intake:',
    'let PERSONA_LOCKED',
    '🏁 完了・結果の確認',
    '⚙️ 実行',
    'サーバ側の実行前検証',
    'PCエージェントの作業',
    '🛠️ 修復・作業の提案',
    '<dt>対象</dt>',
    '<dt>対象端末</dt>',
    '<dt>端末の現状</dt>',
    'この内容で合っていますか？',
    '取得するのは設定・サービス状態・件数のみ。ファイルの中身・閲覧履歴・画面は取得しません。',
    'AIが社内資料と端末の状態（読み取りのみ）から答えます。',
    '<b>AIの診断結果</b>',
    '<b>端末の番号・OS</b><br><span class="u-small u-muted">',
    '項目を読み取りました',
    "sh['AIの診断結果']",
    "sh['端末']",
    "sh['対応案（未実行・失敗）']",
    'v0.3（模擬）',
    '実端末へコマンドを送信',
    '実端末で実行しました',
    "kind:'block'",
    "title:'🚨 情報セキュリティ事故の可能性があります（初動案内）'",
    '実端末での実行に失敗',
  ])('%s が原本にある', (needle) => {
    expect(original).toContain(needle);
  });

  it('診断カードの端末欄の見出しが置換の前提どおり', () => {
    expect(original).toContain('<span class="r">端末 ${esc(m.device)}</span>');
  });
});

type HonestApi = {
  isUnregisteredUser: (id: string) => boolean;
  reportPerson: (id: string, person?: Record<string, string>) => Record<string, string>;
};

describe('最終報告書の人物とタイムライン', () => {
  const bridge = readFileSync(new URL('./assist-bridge.js', import.meta.url), 'utf8');

  /** assist-bridge.js から 1 関数だけ取り出して、honest の結果を通した動作を確かめる。 */
  function extract(name: string) {
    const start = bridge.indexOf(`  function ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = bridge.indexOf('\n  }\n', start) + 5;
    return bridge.slice(start, end);
  }

  function honestApi(locked: boolean, extra: Record<string, unknown> = {}) {
    const { sandbox } = createSandbox({ locked });
    Object.assign(sandbox, {
      USERS: { u1: { name: '山田 太郎' }, u2: { name: '佐藤 花子' }, 'emp:1': { real: true } },
      ...extra,
    });
    return (sandbox.window as unknown as { __AIHD_HONEST__: HonestApi }).__AIHD_HONEST__;
  }

  function timeline(
    locked: boolean,
    chat: { messages: Message[] },
    caseFields: Record<string, unknown> = {},
  ) {
    const api = honestApi(locked);
    const context: Record<string, unknown> = {
      S: { audit: [], ui: { user: 'u1' } },
      uname: () => '山田 太郎',
      ahFmt: (value: unknown) => value,
      ahHonest: () => api,
      chat,
      caseData: { id: 'c1', userId: 'u1', created: 't0', subject: 's', ...caseFields },
      out: null,
    };
    vm.runInNewContext(
      `${extract('ahName')}\n${extract('ahTimeline')}\nout = ahTimeline(caseData, {}, chat);`,
      context,
    );
    return context.out as Array<{ actor: string; action: string }>;
  }

  /** ahReportActor / ahRemoteApprover を実行する。 */
  function people(locked: boolean, remote: Record<string, unknown>) {
    const api = honestApi(locked);
    const context: Record<string, unknown> = {
      S: { ui: { user: 'u1' } },
      uname: () => '山田 太郎',
      ahHonest: () => api,
      ahUser: () => ({
        id: 'u1',
        name: '山田 太郎',
        role: 'employee',
        dept: 'sales',
        employeeNo: 'E1',
      }),
      caseData: { userId: 'u1', remote },
      out: null,
    };
    vm.runInNewContext(
      [
        extract('ahName'),
        extract('ahReportPerson'),
        extract('ahReportActor'),
        extract('ahRemoteApprover'),
        'out = JSON.stringify({ actor: ahReportActor(), approver: ahRemoteApprover(caseData) });',
      ].join('\n'),
      context,
    );
    return JSON.parse(context.out as string) as {
      actor: Record<string, string>;
      approver?: string;
    };
  }

  it('名簿に無い利用者にデモ人物の氏名・部署・社員番号を渡さない', () => {
    const person = { name: '山田 太郎', dept: 'sales', employeeNo: 'E1' };
    expect(JSON.stringify(honestApi(true).reportPerson('u1', person))).toBe(
      JSON.stringify({
        name: '名簿未登録の利用者（氏名は未確認）',
        role: '',
        dept: '',
        employeeNo: '',
      }),
    );
    // 別の利用者の案件・名簿の本人は変えない。
    expect(honestApi(true).reportPerson('u2', person).name).toBe('山田 太郎');
    expect(honestApi(false).reportPerson('u1', person).name).toBe('山田 太郎');
  });

  it('名簿の本人は固定中でも未登録と書かない（/api/me の一時障害）', () => {
    const api = honestApi(true, { S: { ui: { user: 'emp:1' } } });
    expect(api.isUnregisteredUser('emp:1')).toBe(false);
    expect(api.reportPerson('emp:1', { name: '本人', employeeNo: 'E9' }).employeeNo).toBe('E9');
  });

  it('本番では担当者が開いた案件でもデモ人物の氏名を書かない', () => {
    const api = honestApi(false, { SWITCH_MODE: 'self', S: { ui: { user: 'emp:1' } } });
    expect(api.isUnregisteredUser('u1')).toBe(true);
    expect(api.isUnregisteredUser('emp:1')).toBe(false);
    expect(api.isUnregisteredUser('unknown')).toBe(false);
  });

  it('本番以外の固定されていない切替ではデモ人物をそのまま出す', () => {
    const api = honestApi(false, { SWITCH_MODE: 'any', S: { ui: { user: 'u1' } } });
    expect(api.isUnregisteredUser('u1')).toBe(false);
  });

  it('報告書の出力者と遠隔支援の承認者にデモ人物を書かない', () => {
    const unregistered = '名簿未登録の利用者（氏名は未確認）';
    const locked = people(true, { approvedBy: '山田 太郎' });
    expect(locked.actor.name).toBe(unregistered);
    expect(locked.actor.role).toBe('');
    expect(locked.actor.employeeNo).toBe('');
    expect(locked.approver).toBe(unregistered);
    // 承認していない遠隔支援に承認者を作らない。
    expect(people(true, {}).approver).toBeUndefined();
    // 名簿の本人は変えない。
    const roster = people(false, { approvedBy: '山田 太郎' });
    expect(roster.actor.name).toBe('山田 太郎');
    expect(roster.actor.role).toBe('employee');
    expect(roster.approver).toBe('山田 太郎');
  });

  it('タイムラインの診断・提案・実行と、それを経た解決にデモと明記する', () => {
    const rows = timeline(
      false,
      {
        messages: [
          { kind: 'diag', at: 't1', title: 'x' },
          { kind: 'proposal', at: 't2', propId: 'p' },
          { kind: 'exec', at: 't3', state: 'done' },
        ],
      },
      { closed: 'ai' },
    );
    const actions = rows.map((row) => row.action);
    for (const expected of [
      '【デモデータ】端末を診断（読み取りのみ）',
      '【デモデータ】修復を提案',
      '【デモデータ】修復の実行結果',
      '【デモデータ】AIの一次対応で解決',
    ]) {
      expect(actions).toContain(expected);
    }
    expect(actions).toContain('相談を送信');
  });

  it('固定データを使っていない解決にデモと付けない', () => {
    const actions = timeline(
      false,
      { messages: [{ kind: 'text', at: 't1' }] },
      { closed: 'ai' },
    ).map((row) => row.action);
    expect(actions).toContain('AIの一次対応で解決');
  });

  it('名簿に無い利用者のタイムラインにデモ人物の氏名を出さない', () => {
    const rows = timeline(true, { messages: [] });
    for (const row of rows) expect(row.actor).toBe('名簿未登録の利用者（氏名は未確認）');
  });
});
