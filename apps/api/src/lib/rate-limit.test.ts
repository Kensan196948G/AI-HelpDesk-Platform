import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRateLimit, clientAddress, resetRateLimits } from './rate-limit.js';

function request(remoteAddress: string, headers: Record<string, string>, ip: string) {
  return { socket: { remoteAddress }, headers, ip } as unknown as FastifyRequest;
}

afterEach(() => resetRateLimits());

describe('rate limit', () => {
  it('上限を超えると false', () => {
    expect(checkRateLimit('k', 2, 60_000)).toBe(true);
    expect(checkRateLimit('k', 2, 60_000)).toBe(true);
    expect(checkRateLimit('k', 2, 60_000)).toBe(false);
  });

  it('Tunnel（ループバック）経由は CF-Connecting-IP をキーにする', () => {
    expect(
      clientAddress(request('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7' }, '1.1.1.1')),
    ).toBe('203.0.113.7');
  });

  it('ループバック以外から来た CF-Connecting-IP は信用しない', () => {
    expect(
      clientAddress(request('198.51.100.9', { 'cf-connecting-ip': '203.0.113.7' }, '198.51.100.9')),
    ).toBe('198.51.100.9');
  });
});
