import { describe, expect, it } from 'vitest';
import { executionSourceOf, resultShapeOk, resultSourceAccepted } from './execution-source.js';

describe('executionSourceOf', () => {
  it('申告が endpoint_agent / mock のときだけその値を返す', () => {
    expect(executionSourceOf({ executionSource: 'endpoint_agent' })).toBe('endpoint_agent');
    expect(executionSourceOf({ executionSource: 'mock' })).toBe('mock');
  });

  it('申告なし・不正な値は unknown（実端末と見なさない）', () => {
    expect(executionSourceOf({})).toBe('unknown');
    expect(executionSourceOf({ executionSource: 'real' })).toBe('unknown');
    expect(executionSourceOf(null)).toBe('unknown');
    expect(executionSourceOf('endpoint_agent')).toBe('unknown');
    expect(executionSourceOf(['mock'])).toBe('unknown');
  });
});

describe('resultSourceAccepted', () => {
  const dev = { nodeEnv: 'development', authMode: 'local' };
  const prod = { nodeEnv: 'production', authMode: 'cloudflare-access' };

  it('検証環境はどの出所も受け付ける（表示で区別する）', () => {
    expect(resultSourceAccepted('mock', dev)).toBe(true);
    expect(resultSourceAccepted('unknown', dev)).toBe(true);
  });

  it('本番は endpoint_agent だけ受け付ける', () => {
    expect(resultSourceAccepted('endpoint_agent', prod)).toBe(true);
    expect(resultSourceAccepted('mock', prod)).toBe(false);
    expect(resultSourceAccepted('unknown', prod)).toBe(false);
  });

  it('NODE_ENV の設定漏れでも Access 認証なら本番相当として拒否する', () => {
    const env = { nodeEnv: 'development', authMode: 'cloudflare-access' };
    expect(resultSourceAccepted('mock', env)).toBe(false);
    expect(resultSourceAccepted('endpoint_agent', env)).toBe(true);
  });
});

describe('resultShapeOk', () => {
  const schema = { name: 'string', status: 'string' };

  it('宣言したキーと型が揃えば true', () => {
    expect(resultShapeOk(schema, { name: 'Spooler', status: 'Running', extra: 1 })).toBe(true);
  });

  it('キーの欠落・型の違い・object 以外は false', () => {
    expect(resultShapeOk(schema, { name: 'Spooler' })).toBe(false);
    expect(resultShapeOk(schema, { name: 'Spooler', status: 1 })).toBe(false);
    expect(resultShapeOk(schema, null)).toBe(false);
  });

  it('宣言が無ければ評価しない（null）', () => {
    expect(resultShapeOk(null, { a: 1 })).toBeNull();
    expect(resultShapeOk({}, { a: 1 })).toBeNull();
  });
});
