import { describe, expect, it } from 'vitest';
import {
  hasSecurityConcern,
  initialSignal,
  signalAfterAssessment,
  signalAfterHandoff,
  signalAfterResolution,
} from './signal.js';

describe('signal rules', () => {
  it('セキュリティ・急ぎ・危険キーワードは赤', () => {
    expect(
      initialSignal({ category: 'security', urgency: 'normal', subject: '相談', body: '' }),
    ).toBe('red');
    expect(initialSignal({ category: 'other', urgency: 'urgent', subject: '相談', body: '' })).toBe(
      'red',
    );
    expect(
      initialSignal({
        category: 'pc_network',
        urgency: 'normal',
        subject: '不審なメール',
        body: '',
      }),
    ).toBe('red');
  });

  it('通常は青、根拠なしは黄、引継ぎは黄', () => {
    const blue = initialSignal({
      category: 'file_share',
      urgency: 'normal',
      subject: '共有フォルダ',
      body: '開けません',
    });
    expect(blue).toBe('blue');
    expect(signalAfterAssessment(blue, { recommendHandoff: false })).toBe('blue');
    expect(signalAfterAssessment(blue, { recommendHandoff: true })).toBe('amber');
    expect(signalAfterHandoff(blue)).toBe('amber');
    expect(signalAfterResolution(blue)).toBe('blue');
  });

  it('赤は完了後も赤のまま', () => {
    expect(signalAfterAssessment('red', { recommendHandoff: false })).toBe('red');
    expect(signalAfterHandoff('red')).toBe('red');
    expect(signalAfterResolution('red')).toBe('red');
  });

  it('危険キーワードを検出する', () => {
    expect(hasSecurityConcern('ウイルスに感染したかもしれない')).toBe(true);
    expect(hasSecurityConcern('印刷できない')).toBe(false);
  });
});
