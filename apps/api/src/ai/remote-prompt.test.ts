import { describe, expect, it } from 'vitest';
import { draftRemotePrompt, sanitizeRemotePromptOutput, suggestActions } from './remote-prompt.js';

describe('suggestActions', () => {
  it('印刷の相談では、許可リストのスプーラ再起動を「本人承認つき」で提案する', () => {
    const actions = suggestActions('印刷が止まって出てきません。スプーラを確認したい');
    const spooler = actions.find((action) => action.opId === 'SPOOLER_RESTART');
    expect(spooler).toBeDefined();
    expect(spooler?.requiresUserApproval).toBe(true);
    expect(spooler?.level).toBe(4);
    // 読み取りだけの確認も併記する
    expect(actions.some((action) => action.opId === null)).toBe(true);
  });

  it('セキュリティ事象は実行候補を出さず、担当者対応にする', () => {
    const actions = suggestActions('不審なメールの添付を開いてしまいました');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.opId).toBeNull();
    expect(actions[0]?.label).toContain('セキュリティ');
  });

  it('アカウント系は遠隔で実行しない', () => {
    const actions = suggestActions('パスワードを忘れてログインできません');
    expect(actions[0]?.opId).toBeNull();
    expect(actions[0]?.note).toContain('本人確認');
  });

  it('VPN・共有フォルダ・音声・容量でも読み取り候補を返す', () => {
    expect(suggestActions('VPNにつながらない').length).toBeGreaterThan(0);
    expect(suggestActions('共有フォルダが開けない').length).toBeGreaterThan(0);
    expect(suggestActions('Teamsの音が出ない').length).toBeGreaterThan(0);
    expect(suggestActions('ディスクの空きが少ない').length).toBeGreaterThan(0);
  });
});

describe('draftRemotePrompt', () => {
  it('案内文を返し、シェルコマンドや危険な操作を含めない', async () => {
    const draft = await draftRemotePrompt(
      '印刷キューの状態を確認して、止まっているジョブを消してもらう',
      {
        caseId: 'CASE-0001',
        subject: '印刷ができません',
        body: '今朝から印刷待ちのままです。',
        pcSummary: '印刷スプーラ：停止',
      },
    );
    expect(draft.message.length).toBeGreaterThan(20);
    expect(draft.message).not.toMatch(/powershell|cmd\.exe|reg\s+add|format\s+[a-z]:|remove-item/i);
    expect(['fallback', 'deepseek']).toContain(draft.provider);
    expect(draft.actions.some((action) => action.opId === 'SPOOLER_RESTART')).toBe(true);
  });

  it('PII を送信前に伏せ字化しても、案内文は壊れない', async () => {
    const draft = await draftRemotePrompt(
      '連絡先 taro@example.com の人に、電話 090-1234-5678 で確認してほしい',
      { subject: '連絡先の確認', body: 'IP 10.1.2.3 の端末です。' },
    );
    expect(draft.message.length).toBeGreaterThan(10);
    expect(draft.message).not.toContain('taro@example.com');
    expect(draft.message).not.toContain('090-1234-5678');
    expect(draft.message).not.toContain('10.1.2.3');
  });
});

describe('sanitizeRemotePromptOutput', () => {
  it('PowerShell のセキュリティ無効化・任意コマンドを拒否する', () => {
    expect(
      sanitizeRemotePromptOutput('Set-MpPreference -DisableRealtimeMonitoring $true'),
    ).toBeNull();
    expect(sanitizeRemotePromptOutput('Get-Service Spooler')).toBeNull();
    expect(sanitizeRemotePromptOutput('Invoke-Expression $payload')).toBeNull();
    expect(sanitizeRemotePromptOutput('netsh advfirewall set allprofiles state off')).toBeNull();
  });

  it('資格情報の要求を拒否する', () => {
    expect(sanitizeRemotePromptOutput('パスワードを教えてください')).toBeNull();
    expect(sanitizeRemotePromptOutput('認証コードを送ってください')).toBeNull();
  });

  it('通常の日本語の案内は採用し、PII を伏せ字化する', () => {
    const output = sanitizeRemotePromptOutput(
      'お疲れさまです。連絡先 taro@example.com まで、実施した結果を教えてください。',
    );
    expect(output).not.toBeNull();
    expect(output).toContain('[メールアドレス]');
    expect(output).not.toContain('taro@example.com');
  });

  it('空・長すぎる出力は拒否する', () => {
    expect(sanitizeRemotePromptOutput('   ')).toBeNull();
    expect(sanitizeRemotePromptOutput('あ'.repeat(1300))).toBeNull();
  });
});
