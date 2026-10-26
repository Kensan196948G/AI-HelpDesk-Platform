#!/usr/bin/env node
/**
 * RSP 都度セッションの状態機械 PoC（実RSPには接続しない）
 *
 * 検証する契約:
 * - 常時ログインしない（初期状態は none / agent 疎通で ready）
 * - claim と本人同意（画面共有・操作支援）が揃うまで active にしない
 * - 担当者以外は開けない
 * - TTL / 解決 / 停止で closed になる
 * - すべての遷移を監査に残す
 */
import assert from 'node:assert/strict';

const TTL_MS = 30 * 60 * 1000;

class RspSession {
  constructor(handoverId, deviceId) {
    this.handoverId = handoverId;
    this.deviceId = deviceId;
    this.state = 'none';
    this.claimedBy = null;
    this.consent = { screen: false, control: false };
    this.openedAt = null;
    this.expiresAt = null;
    this.audit = [];
  }

  log(action, actor, detail = {}) {
    this.audit.push({ at: new Date().toISOString(), action, actor, detail });
  }

  agentOnline() {
    assert.equal(this.state, 'none');
    this.state = 'ready';
    this.log('agent.online', 'device');
  }

  claim(operator) {
    assert.equal(this.state, 'ready');
    this.claimedBy = operator;
    this.log('case.claimed', operator);
  }

  giveConsent(operator, scope) {
    assert.equal(this.claimedBy, operator);
    if (scope.screen) this.consent.screen = true;
    if (scope.control) this.consent.control = true;
    this.log('consent.recorded', operator, scope);
  }

  open(operator, now = Date.now()) {
    assert.equal(this.state, 'ready');
    assert.equal(this.claimedBy, operator, 'claim した担当者のみ開ける');
    assert.ok(this.consent.screen || this.consent.control, '同意が必要');
    this.state = 'active';
    this.openedAt = now;
    this.expiresAt = now + TTL_MS;
    this.log('session.opened', operator, { scope: this.consent });
  }

  close(actor, reason) {
    assert.equal(this.state, 'active');
    this.state = 'closed';
    this.log('session.closed', actor, { reason });
  }

  tick(now) {
    if (this.state === 'active' && this.expiresAt <= now) {
      this.state = 'closed';
      this.log('session.closed', 'system', { reason: 'ttl_expired' });
    }
  }
}

const results = [];
function check(name, fn) {
  fn();
  results.push({ name, ok: true });
}

check('初期状態は none（常時ログインしない）', () => {
  const s = new RspSession('H-1', 'PC-1');
  assert.equal(s.state, 'none');
  assert.equal(s.audit.length, 0);
});

check('agent 疎通で ready。claim 前は開けない', () => {
  const s = new RspSession('H-1', 'PC-1');
  s.agentOnline();
  assert.equal(s.state, 'ready');
  assert.throws(() => s.open('operator-a'), /claim/);
});

check('claim + 同意で active。担当者以外は不可', () => {
  const s = new RspSession('H-1', 'PC-1');
  s.agentOnline();
  s.claim('operator-a');
  s.giveConsent('operator-a', { screen: true, control: true });
  assert.throws(() => s.open('operator-b'), /claim/);
  s.open('operator-a');
  assert.equal(s.state, 'active');
  assert.deepEqual(s.consent, { screen: true, control: true });
});

check('同意なしでは active にしない', () => {
  const s = new RspSession('H-1', 'PC-1');
  s.agentOnline();
  s.claim('operator-a');
  assert.throws(() => s.open('operator-a'), /同意/);
});

check('TTL 経過で自動 closed', () => {
  const s = new RspSession('H-1', 'PC-1');
  const t0 = Date.UTC(2026, 9, 26, 4, 0, 0);
  s.agentOnline();
  s.claim('operator-a');
  s.giveConsent('operator-a', { control: true });
  s.open('operator-a', t0);
  s.tick(t0 + TTL_MS - 1);
  assert.equal(s.state, 'active');
  s.tick(t0 + TTL_MS);
  assert.equal(s.state, 'closed');
  assert.equal(s.audit.at(-1).detail.reason, 'ttl_expired');
});

check('解決で closed。監査に claim/同意/開始/終了が残る', () => {
  const s = new RspSession('H-1', 'PC-1');
  s.agentOnline();
  s.claim('operator-a');
  s.giveConsent('operator-a', { screen: true });
  s.open('operator-a');
  s.close('operator-a', 'resolved');
  assert.equal(s.state, 'closed');
  const actions = s.audit.map((e) => e.action);
  assert.ok(actions.includes('case.claimed'));
  assert.ok(actions.includes('consent.recorded'));
  assert.ok(actions.includes('session.opened'));
  assert.ok(actions.includes('session.closed'));
});

console.log(JSON.stringify({ ok: true, checks: results.length, results }, null, 2));
