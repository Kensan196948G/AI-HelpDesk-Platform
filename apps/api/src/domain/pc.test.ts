import { describe, expect, it } from 'vitest';
import { buildDemoPcSnapshot } from './pc.js';

describe('buildDemoPcSnapshot', () => {
  it('8分類31項目を生成する', () => {
    const snapshot = buildDemoPcSnapshot({
      category: 'file_share',
      subject: '共有フォルダが開けません',
      body: '保存に失敗します。',
    });
    expect(snapshot.items).toHaveLength(31);
    expect(new Set(snapshot.items.map((item) => item.category)).size).toBe(8);
    expect(snapshot.source).toBe('demo');
  });

  it('共有フォルダの相談では関連する異常を上位に並べる', () => {
    const snapshot = buildDemoPcSnapshot({
      category: 'file_share',
      subject: '共有フォルダが開けません',
      body: 'アクセスが拒否されます。',
    });
    const shared = snapshot.items.find((item) => item.key === 'shared_folder');
    expect(shared?.status).toBe('abnormal');
    const disk = snapshot.items.find((item) => item.key === 'disk_free');
    expect(disk?.status).toBe('abnormal');
    expect(snapshot.concerns[0]?.star).toBe(true);
    expect(snapshot.concerns.map((concern) => concern.key)).toContain('shared_folder');
  });

  it('VPNの相談では VPN と到達性を異常にする', () => {
    const snapshot = buildDemoPcSnapshot({
      category: 'pc_network',
      subject: 'VPNにつながらない',
      body: '現場から接続できません。',
    });
    expect(snapshot.items.find((item) => item.key === 'vpn')?.status).toBe('attention');
    expect(snapshot.items.find((item) => item.key === 'intranet_reachable')?.status).toBe(
      'abnormal',
    );
  });

  it('音声の相談では出力先を注意にする', () => {
    const snapshot = buildDemoPcSnapshot({
      category: 'pc_network',
      subject: 'Teamsの音が出ない',
      body: 'ヘッドセットを使っています。',
    });
    expect(snapshot.items.find((item) => item.key === 'audio_output')?.status).toBe('attention');
  });

  it('VPNに接続済みと書かれている場合は未接続にしない', () => {
    const snapshot = buildDemoPcSnapshot({
      category: 'file_share',
      subject: '共有フォルダが開けません',
      body: 'VPNには接続しています。保存に失敗します。',
    });
    expect(snapshot.items.find((item) => item.key === 'vpn')?.value).toBe('接続中');
  });
});
