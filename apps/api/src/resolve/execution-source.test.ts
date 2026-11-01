import { describe, expect, it } from 'vitest';
import { executionSourceOf, mockResultAllowed, resultShapeOk } from './execution-source.js';

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

describe('mockResultAllowed', () => {
  it('本番だけ拒否する', () => {
    expect(mockResultAllowed('production')).toBe(false);
    expect(mockResultAllowed('development')).toBe(true);
    expect(mockResultAllowed('test')).toBe(true);
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
