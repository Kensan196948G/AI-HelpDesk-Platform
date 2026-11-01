import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('./resolve-bridge.js', import.meta.url), 'utf8');
const honest = readFileSync(new URL('./honest-labels-bridge.js', import.meta.url), 'utf8');

const NO_AGENT = '端末エージェントが未接続のため実診断はできません。担当者へ引き継げます。';

type Message = Record<string, any>;

function createSandbox(options: { agentConnected?: boolean; statusFails?: boolean } = {}) {
  const chat = { id: 'chat-1', userId: 'u1', messages: [] as Message[] };
  const targetCase: Record<string, any> = {
    id: 'CASE-1',
    userId: 'u1',
    chatId: 'chat-1',
    step: 3,
    share: {},
  };
  const state = {
    ui: { user: 'u1', chat: 'chat-1' },
    chats: [chat],
    cases: [targetCase],
    proposals: {},
    tickets: [],
  };
  const panel: Record<string, any> = { innerHTML: '', querySelector: () => null };
  const calls: string[] = [];
  const originalPrint = () => calls.push('demo-print');
  const tickets: Array<Record<string, any>> = [];
  const sandbox: Record<string, any> = {
    S: state,
    USERS: { u1: { device: 'MRK-NB-1024' } },
    UI: { typing: false },
    H: { print: originalPrint, vpn: () => calls.push('vpn') },
    CONFIRM_INTENTS: { print: 1, vpn: 1 },
    ACT: {
      wHand: () => calls.push('wHand'),
      wSolved: () => calls.push('wSolved'),
      consentSend: (detail: { mid: string }) => {
        const message = chat.messages.find((item) => item.id === detail.mid) as Message;
        sandbox.createTicket(state, { userId: 'u1', shared: { 相談内容: message.ctx.summary } });
      },
    },
    curCase: () => targetCase,
    addMsg: (target: { messages: Message[] }, message: Message) => {
      message.id = message.id || `m-${target.messages.length + 1}`;
      target.messages.push(message);
      return message;
    },
    findMsg: (id: string) => {
      const message = chat.messages.find((item) => item.id === id);
      return message ? [chat, message] : [null, null];
    },
    escBtn: () => '<button data-act="escalate">担当者</button>',
    save: () => {},
    refresh: () => {},
    toast: () => {},
    paneHtml: (target: Record<string, any>) =>
      target.step === 4
        ? '<div class="w-share"><label>相談内容</label></div>'
        : '<h3>AIの一次対応</h3><p class="lead">定型の相談はルールベース（デモデータ）で案内します。</p>',
    asideHtml: () => '<li>定型の相談はルールベース（デモデータ）で対応しています</li>',
    consentCard: (target: { messages: Message[] }) => {
      const message: Message = {
        id: 'consent-1',
        kind: 'consent',
        sel: { diag: true },
        ctx: { summary: '印刷', diag: [] },
      };
      target.messages.push(message);
      return message;
    },
    renderConsent: () =>
      '<label style="display:block;margin:3px 0"><input type="checkbox" data-ck="device" data-mid="x"> 端末</label>',
    createTicket: (_state: unknown, ticket: Record<string, any>) => {
      tickets.push(ticket);
      return ticket;
    },
    document: {
      getElementById: (id: string) => (id === 'aihdResolvePanel' ? panel : null),
      querySelector: () => ({}),
      addEventListener: () => {},
      createElement: () => ({}),
    },
    fetch: async (url: string) => {
      calls.push(`fetch ${url}`);
      if (options.statusFails) return { ok: false, status: 500, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, agentConnected: options.agentConnected === true }),
      };
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    addEventListener: () => {},
    console,
    __AIHD_DEVICE_ID__: 'device-uuid-1',
    encodeURIComponent,
    Date,
    JSON,
    Number,
    String,
    Promise,
    Object,
    Array,
    Error,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, chat, targetCase, panel, calls, tickets, originalPrint };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function guideFor(options: { agentConnected?: boolean; statusFails?: boolean }) {
  const context = createSandbox(options);
  context.sandbox.H.print(context.chat);
  await settle();
  await settle();
  return context;
}

describe('印刷の相談の導線', () => {
  it('固定データの確認カードと診断へ進めない', () => {
    const { sandbox, calls } = createSandbox();
    expect('print' in sandbox.CONFIRM_INTENTS).toBe(false);
    // 他の相談の確認カードは変えない。
    expect(sandbox.CONFIRM_INTENTS.vpn).toBe(1);
    sandbox.H.vpn();
    expect(calls).toContain('vpn');
  });

  it('接続ありなら解決ループへ誘導し、デモの診断を出さない', async () => {
    const { chat, calls, targetCase } = await guideFor({ agentConnected: true });
    expect(calls).not.toContain('demo-print');
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0].kind).toBe('ai');
    expect(chat.messages[0].html).toContain('data-aihd-resolve="start"');
    expect(chat.messages[0].html).not.toContain(NO_AGENT);
    expect(targetCase.realPath).toBe('agent');
  });

  it('未接続なら実診断できないと明示し、開始ボタンを出さない', async () => {
    const { chat, calls, targetCase } = await guideFor({ agentConnected: false });
    expect(calls).not.toContain('demo-print');
    expect(chat.messages[0].html).toContain(NO_AGENT);
    expect(chat.messages[0].html).not.toContain('data-aihd-resolve="start"');
    expect(chat.messages[0].text).toBe(NO_AGENT);
    expect(targetCase.realPath).toBe('no-agent');
  });

  it('接続を確認できないときは未接続と同じ扱いにする', async () => {
    const { chat } = await guideFor({ statusFails: true });
    expect(chat.messages[0].html).toContain(NO_AGENT);
  });

  it('端末 ID が無ければ状態確認の API を呼ばない（デモ端末へ落とさない）', async () => {
    const context = createSandbox({ agentConnected: true });
    context.sandbox.__AIHD_DEVICE_ID__ = '';
    context.sandbox.H.print(context.chat);
    await settle();
    await settle();
    expect(context.calls.some((call) => call.startsWith('fetch'))).toBe(false);
    expect(context.chat.messages[0].html).toContain(NO_AGENT);
  });

  it('状態確認は実端末の ID で呼ぶ', async () => {
    const { calls } = await guideFor({ agentConnected: true });
    expect(calls.some((call) => call.includes('deviceId=device-uuid-1'))).toBe(true);
    expect(calls.some((call) => call.includes('MRK-'))).toBe(false);
  });

  it('説明と信号の理由をデモの案内のままにしない', async () => {
    const { sandbox, targetCase } = await guideFor({ agentConnected: true });
    const pane = sandbox.paneHtml(targetCase);
    expect(pane).not.toContain('デモデータ');
    expect(pane).toContain('端末エージェント');
    expect(sandbox.asideHtml(targetCase)).not.toContain('デモデータ');
  });
});

describe('結果の出所の扱い', () => {
  function withResult(source: string, facts: string[][] = [['status', 'Running']]) {
    const context = createSandbox({ agentConnected: true });
    const labels = context.sandbox.__AIHD_RESOLVE__.SOURCE_LABEL;
    context.chat.messages.push({
      id: 'r1',
      kind: 'ai',
      model: labels[source],
      resolveResult: {
        source,
        title: '印刷スプーラの状態を確認する',
        commandId: 'cmd-1',
        facts,
      },
    });
    return context;
  }

  it('実端末と言えるのは endpoint_agent だけ', () => {
    const { sandbox } = createSandbox();
    const { sourceOfStep, SOURCE_LABEL } = sandbox.__AIHD_RESOLVE__;
    expect(sourceOfStep({ executionSource: 'endpoint_agent' })).toBe('endpoint_agent');
    expect(sourceOfStep({ executionSource: 'mock' })).toBe('mock');
    expect(sourceOfStep({ executionSource: 'other' })).toBe('unknown');
    expect(sourceOfStep({})).toBe('unknown');
    expect(SOURCE_LABEL.mock).toContain('実端末の結果ではありません');
    expect(SOURCE_LABEL.unknown).toContain('確認できていません');
  });

  it('模擬の結果は引継ぎの行でも模擬と書き、実行 ID を残す', () => {
    const { sandbox, chat } = withResult('mock');
    const lines = sandbox.__AIHD_RESOLVE__.realResultLines(chat);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('模擬');
    expect(lines[0]).not.toContain('端末エージェント（実端末）');
    expect(lines[0]).toContain('cmd-1');
  });

  it('未知の出所は実端末と書かない', () => {
    const { sandbox, chat } = withResult('something-else');
    const line = sandbox.__AIHD_RESOLVE__.realResultLines(chat)[0];
    expect(line).not.toContain('端末エージェント（実端末）');
  });

  it('同意カードと STEP 4 に選択肢を出し、選んだときだけ別の項目で渡す', () => {
    const { sandbox, chat, targetCase, tickets } = withResult('mock');
    const consent = sandbox.consentCard(chat);
    expect(consent.ctx.realDiag).toHaveLength(1);
    expect(consent.ctx.diag).toEqual([]);
    expect(sandbox.renderConsent(consent)).toContain('data-ck="realDiag"');

    const pane = sandbox.paneHtml({ ...targetCase, step: 4 });
    expect(pane).toContain('data-k="realDiag"');

    sandbox.ACT.consentSend({ mid: consent.id });
    expect(tickets[0].shared['実診断の結果']).toHaveLength(1);
    expect(tickets[0].shared.AIの診断結果).toBeUndefined();

    consent.sel.realDiag = false;
    sandbox.ACT.consentSend({ mid: consent.id });
    expect(tickets[1].shared['実診断の結果']).toBeUndefined();
  });

  it('結果が無ければ選択肢も項目も増やさない', () => {
    const { sandbox, chat, targetCase, tickets } = createSandbox();
    const consent = sandbox.consentCard(chat);
    expect(consent.ctx.realDiag).toBeUndefined();
    expect(sandbox.paneHtml({ ...targetCase, step: 4 })).not.toContain('realDiag');
    sandbox.ACT.consentSend({ mid: consent.id });
    expect(tickets[0].shared['実診断の結果']).toBeUndefined();
  });
});

describe('honest-labels との連携', () => {
  it('解決ループの結果はルールベース表示にせず、保存した出所をそのまま出す', () => {
    const sandbox: Record<string, any> = {
      S: { ui: {}, chats: [], cases: [] },
      USERS: {},
      msgMeta: (message: Message) => String(message.model),
    };
    sandbox.window = sandbox;
    vm.runInNewContext(honest, sandbox);
    expect(
      sandbox.msgMeta({ model: '模擬（実端末の結果ではありません）', resolveResult: {} }),
    ).toBe('模擬（実端末の結果ではありません）');
    const api = sandbox.__AIHD_HONEST__;
    expect(api.whoFor({ model: '模擬（実端末の結果ではありません）', resolveResult: {} })).toBe(
      '模擬（実端末の結果ではありません）',
    );
    const report = api.reportModel({ messages: [{ model: 'x', resolveResult: {} }] });
    expect(report).toContain('解決ループ');
    expect(report).not.toContain('デモ');
  });
});
