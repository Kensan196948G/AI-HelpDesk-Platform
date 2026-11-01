import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const alertScript = fileURLToPath(new URL('./backup-alert.mjs', import.meta.url));
const smtpScript = fileURLToPath(new URL('./set-smtp-password.sh', import.meta.url));
const backupUnit = fileURLToPath(
  new URL('../ops/systemd/ai-helpdesk-backup.service', import.meta.url),
);
const proxyUnit = fileURLToPath(
  new URL('../ops/systemd/ai-helpdesk-proxy.service', import.meta.url),
);

const SMTP_PASS = 'synthetic-smtp-secret-1';
const DB_PASS = 'synthetic-db-secret-1';
const OLD_APP_PASS = 'oldoldoldoldoldo';
const NEW_APP_PASS = 'abcdefghijklmnop';
const RECIPIENT = 'ops-alert@example.com';

let dir;
let backupDir;
let sink;
let port;

/** 外部へ送らない SMTP スタブ。AUTH を受け付け、受信内容を記録するだけ。 */
function startSink({ rejectRcpt = false } = {}) {
  const received = { auths: [], messages: [], rcpts: [] };
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 sink.test ESMTP\r\n');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\r\n');
        if (inData) {
          if (line === '.') {
            inData = false;
            received.messages.push(data);
            data = '';
            socket.write('250 queued\r\n');
          } else {
            data += `${line}\n`;
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          socket.write('250-sink.test\r\n250 AUTH PLAIN\r\n');
        } else if (upper.startsWith('AUTH')) {
          received.auths.push(line);
          socket.write('235 ok\r\n');
        } else if (upper.startsWith('RCPT')) {
          received.rcpts.push(line);
          socket.write(rejectRcpt ? `550 no such user ${RECIPIENT}\r\n` : '250 ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else {
          socket.write('250 ok\r\n');
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received }));
  });
}

/** スタブが同じプロセスで応答するので spawnSync は使えない。 */
function exec(file, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function conf(extra = '') {
  return [
    'SHARED_IDENTITY_GROUPS=a@example.com|b@example.com',
    `DATABASE_URL=postgresql://synth:${DB_PASS}@127.0.0.1:5435/synth_db`,
    'SMTP_HOST=127.0.0.1',
    `SMTP_PORT=${port}`,
    'SMTP_SECURE=false',
    'SMTP_USER=smtp-user@example.com',
    `SMTP_PASS=${SMTP_PASS}`,
    'MAIL_FROM=sender@example.com',
    `HANDOVER_NOTIFY_EMAIL=${RECIPIENT}`,
    extra,
    '',
  ].join('\n');
}

function runAlert({ confText = conf(), env = {}, args = [] } = {}) {
  const envFile = path.join(dir, 'api.conf');
  writeFileSync(envFile, confText);
  return exec(process.execPath, [alertScript, ...args], {
    HOME: dir,
    AIHD_ENV_FILE: envFile,
    AIHD_BACKUP_DIR: backupDir,
    // 既定は「しきい値超えなし」。ディスクの試験だけ 0 にして超えた状態を作る。
    AIHD_DISK_WARN_PCT: '100',
    ...env,
  });
}

const FAILED = { SERVICE_RESULT: 'exit-code', EXIT_CODE: 'exited', EXIT_STATUS: '127' };

/** quoted-printable の =XX をバイトへ戻す（その他の文字は ASCII のまま）。 */
function decodeQp(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=') {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** Subject は RFC 2047、本文は base64 か quoted-printable なので、復号して比べる。 */
function decodeMessage(raw) {
  const separator = raw.indexOf('\n\n');
  const headers = raw.slice(0, separator).replace(/\n\s+/g, ' ');
  const encoded = raw.slice(separator + 2);
  const subject = (headers.match(/^Subject: (.*)$/m)?.[1] ?? '')
    .replace(/\s*=\?UTF-8\?B\?([^?]*)\?=\s*/gi, (_all, b64) =>
      Buffer.from(b64, 'base64').toString('utf8'),
    )
    .replace(/\s*=\?UTF-8\?Q\?([^?]*)\?=\s*/gi, (_all, qp) => decodeQp(qp.replace(/_/g, ' ')));
  let body = encoded;
  if (/Content-Transfer-Encoding: base64/i.test(headers)) {
    body = Buffer.from(encoded.replace(/\s/g, ''), 'base64').toString('utf8');
  } else if (/Content-Transfer-Encoding: quoted-printable/i.test(headers)) {
    body = decodeQp(encoded.replace(/=\n/g, ''));
  }
  return { headers, subject, body };
}

function expectNoSecrets(text) {
  expect(text).not.toContain(SMTP_PASS);
  expect(text).not.toContain(DB_PASS);
  expect(text).not.toContain('postgresql://');
  expect(text).not.toContain('example.com');
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'aihd-alert-test-'));
  backupDir = path.join(dir, 'backups');
  mkdirSync(backupDir);
  sink = await startSink();
  port = sink.server.address().port;
});

afterEach(async () => {
  await new Promise((resolve) => sink.server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe('backup-alert.mjs（SMTP スタブ。外部へ送らない）', () => {
  it('バックアップの失敗を通知し、| を含む設定でも読める', async () => {
    writeFileSync(
      path.join(backupDir, 'backup.log'),
      [
        '2026-10-28T02:30:01+09:00 OK db=synth_db file=f.dump bytes=4 sha256=abc keep=14d',
        '2026-10-29T02:30:01+09:00 FAIL stage=config exit=2',
        '',
      ].join('\n'),
    );
    const result = await runAlert({ env: FAILED });
    expect(result.status, result.stderr).toBe(0);
    expect(sink.received.rcpts.join()).toContain(RECIPIENT);
    expect(sink.received.messages).toHaveLength(1);
    const { subject, body } = decodeMessage(sink.received.messages[0]);
    expect(subject).toContain('バックアップ失敗');
    expect(subject).not.toContain('ディスク');
    expect(body).toContain('result=exit-code code=exited status=127');
    expect(body).toContain('2026-10-29T02:30:01+09:00 stage=config exit=2');
    expect(body).toContain('最後の成功: 2026-10-28T02:30:01+09:00');
    expect(body).not.toContain('synth_db');
    expectNoSecrets(body);
    expectNoSecrets(result.stdout + result.stderr);
    const log = readFileSync(path.join(backupDir, 'backup.log'), 'utf8');
    expect(log).toMatch(/NOTIFY .* sent recipients=1\n$/);
    expectNoSecrets(log);
  });

  it('成功してディスクも問題なければ送らない', async () => {
    const result = await runAlert({ env: { SERVICE_RESULT: 'success' } });
    expect(result.status, result.stderr).toBe(0);
    expect(sink.received.messages).toEqual([]);
    expect(existsSync(path.join(backupDir, 'backup.log'))).toBe(false);
  });

  it('成功でもディスクのしきい値を超えていれば警告する', async () => {
    const result = await runAlert({
      env: { SERVICE_RESULT: 'success', AIHD_DISK_WARN_PCT: '0' },
    });
    expect(result.status, result.stderr).toBe(0);
    const { subject, body } = decodeMessage(sink.received.messages[0]);
    expect(subject).toContain('ディスク残量警告');
    expect(subject).not.toContain('バックアップ失敗');
    expect(body).toMatch(/\/ の使用率 \d+%（警告は 0% 超）/);
    expect(body).toContain('失敗の報告なし');
  });

  it('失敗とディスク警告は 1 通にまとめる', async () => {
    const result = await runAlert({ env: { ...FAILED, AIHD_DISK_WARN_PCT: '0' } });
    expect(result.status, result.stderr).toBe(0);
    expect(sink.received.messages).toHaveLength(1);
    const { subject } = decodeMessage(sink.received.messages[0]);
    expect(subject).toContain('バックアップ失敗');
    expect(subject).toContain('ディスク残量警告');
  });

  it('使用率は既定のしきい値 90% を超えたときだけ警告する', async () => {
    const result = await runAlert({
      args: ['--dry-run'],
      env: { ...FAILED, AIHD_DISK_WARN_PCT: '' },
    });
    expect(result.stdout).toContain('警告は 90% 超');
  });

  it('ログが無くても通知する', async () => {
    const result = await runAlert({ env: FAILED });
    expect(result.status, result.stderr).toBe(0);
    expect(decodeMessage(sink.received.messages[0]).body).toContain('最後の成功: 記録なし');
  });

  it('OPS_ALERT_EMAIL を優先し、カンマ区切りを受け付ける', async () => {
    const result = await runAlert({
      env: FAILED,
      confText: conf('OPS_ALERT_EMAIL="one@example.org, two@example.org"'),
    });
    expect(result.status, result.stderr).toBe(0);
    const rcpts = sink.received.rcpts.join();
    expect(rcpts).toContain('one@example.org');
    expect(rcpts).toContain('two@example.org');
    expect(rcpts).not.toContain(RECIPIENT);
    expect(result.stdout).toContain('recipients=2');
  });

  it.each([
    ['transport-disabled', 'MAIL_TRANSPORT=disabled'],
    ['transport-unsupported', 'MAIL_TRANSPORT=sendmail'],
    ['smtp-host-missing', 'SMTP_HOST='],
    ['recipient-missing', 'HANDOVER_NOTIFY_EMAIL=not-an-address'],
  ])('送れない設定は %s を記録して失敗を返す', async (reason, line) => {
    const result = await runAlert({ env: FAILED, confText: conf(line) });
    expect(result.status).toBe(1);
    expect(sink.received.messages).toEqual([]);
    expect(result.stderr).toContain(`reason=${reason}`);
    expect(readFileSync(path.join(backupDir, 'backup.log'), 'utf8')).toContain(
      `not-sent reason=${reason}`,
    );
  });

  it('SMTP の拒否応答に含まれる宛先をログへ出さない', async () => {
    await new Promise((resolve) => sink.server.close(resolve));
    sink = await startSink({ rejectRcpt: true });
    port = sink.server.address().port;
    const result = await runAlert({ env: FAILED });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reason=[A-Za-z0-9_-]+/);
    expectNoSecrets(result.stdout + result.stderr);
    expectNoSecrets(readFileSync(path.join(backupDir, 'backup.log'), 'utf8'));
  });

  it('SMTP に接続できなくてもログへ接続先を出さず失敗を返す', async () => {
    await new Promise((resolve) => sink.server.close(resolve));
    const result = await runAlert({ env: FAILED });
    sink = await startSink();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reason=ESOCKET');
    expect(result.stderr).not.toContain('127.0.0.1');
  });

  it('想定外の systemd の値を本文へ載せない', async () => {
    const result = await runAlert({
      args: ['--dry-run'],
      env: { SERVICE_RESULT: 'x y\nInjected: 1', EXIT_STATUS: 'a@example.com' },
    });
    expect(result.stdout).toContain('result=不明');
    expect(result.stdout).not.toContain('Injected');
    expectNoSecrets(result.stdout);
  });

  it('--dry-run は送らず、--test は失敗がなくても試験と分かる件名で送る', async () => {
    const dry = await runAlert({ args: ['--dry-run', '--test'] });
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain('配送確認の試験');
    expect(sink.received.messages).toEqual([]);

    const sent = await runAlert({ args: ['--test'] });
    expect(sent.status, sent.stderr).toBe(0);
    const { subject, body } = decodeMessage(sink.received.messages[0]);
    expect(subject).toContain('配送確認の試験');
    expect(subject).not.toContain('バックアップ失敗');
    expect(body).toContain('対応は不要');
  });

  it('unit は ExecStopPost から絶対パスの node で実行し、送信の失敗を無視する', () => {
    const unit = readFileSync(backupUnit, 'utf8');
    const line = unit.match(/^ExecStopPost=(.*)$/m)?.[1] ?? '';
    const node = line.match(/^-(\/\S+\/bin\/node) scripts\/backup-alert\.mjs$/)?.[1];
    expect(node, line).toBeTruthy();
    expect(readFileSync(proxyUnit, 'utf8')).toContain(`ExecStart=${node} `);
    // 秘密を backup-db.sh の環境へ渡さない。
    expect(unit).not.toMatch(/^EnvironmentFile=/m);
  });
});

describe('set-smtp-password.sh（SMTP スタブ。外部へ送らない）', () => {
  function runSmtp(confText, args, { password = NEW_APP_PASS, extraPath = '' } = {}) {
    const envFile = path.join(dir, 'api.conf');
    writeFileSync(envFile, confText);
    chmodSync(envFile, 0o600);
    return {
      envFile,
      done: exec('/bin/bash', [smtpScript, '--conf', envFile, '--no-restart', ...args], {
        HOME: dir,
        PATH: `${extraPath}${path.dirname(process.execPath)}:/usr/bin:/bin`,
        SMTP_PASS: password,
      }),
    };
  }

  const confWithOld = () => conf().replace(`SMTP_PASS=${SMTP_PASS}`, `SMTP_PASS=${OLD_APP_PASS}`);

  it('値に | を含む設定でも差し替えて、新しいパスワードで認証する（終了コード 127 の回帰）', async () => {
    const { envFile, done } = runSmtp(confWithOld(), []);
    const result = await done;
    expect(result.status, result.stderr).toBe(0);
    const updated = readFileSync(envFile, 'utf8');
    expect(updated).toContain(`SMTP_PASS=${NEW_APP_PASS}\n`);
    expect(updated).not.toContain(OLD_APP_PASS);
    expect(updated).toContain('SHARED_IDENTITY_GROUPS=a@example.com|b@example.com');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    // AUTH PLAIN の中身が設定ファイルの新しい値であること。
    const encoded = sink.received.auths[0]?.split(' ').at(-1) ?? '';
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(
      `\0smtp-user@example.com\0${NEW_APP_PASS}`,
    );
    expect(result.stdout + result.stderr).not.toContain(NEW_APP_PASS);
    expect(result.stdout + result.stderr).not.toContain(OLD_APP_PASS);
    expect(result.stdout + result.stderr).not.toContain(DB_PASS);
  });

  it('設定ファイルをシェルとして実行しない', async () => {
    const marker = path.join(dir, 'pwned');
    const { done } = runSmtp(`${confWithOld()}X=$(touch ${marker})\n\`touch ${marker}\`\n`, [
      '--skip-verify',
    ]);
    const result = await done;
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it('--test-to は設定ファイルの SMTP 設定でテスト送信する', async () => {
    const { done } = runSmtp(confWithOld(), ['--test-to', 'to@example.org']);
    const result = await done;
    expect(result.status, result.stderr).toBe(0);
    expect(sink.received.rcpts.join()).toContain('to@example.org');
    expect(decodeMessage(sink.received.messages[0]).headers).toContain('From: sender@example.com');
  });

  it('新しいパスワードをプロセス引数へ出さない', async () => {
    // awk を差し替えて、渡された引数を記録する。
    const binDir = path.join(dir, 'bin');
    const argv = path.join(dir, 'argv.log');
    mkdirSync(binDir);
    writeFileSync(
      path.join(binDir, 'awk'),
      `#!/bin/bash\necho "$*" >> "${argv}"\nexec /usr/bin/awk "$@"\n`,
    );
    chmodSync(path.join(binDir, 'awk'), 0o755);
    const { envFile, done } = runSmtp(confWithOld(), ['--skip-verify'], {
      extraPath: `${binDir}:`,
    });
    const result = await done;
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toContain(`SMTP_PASS=${NEW_APP_PASS}\n`);
    expect(readFileSync(argv, 'utf8')).not.toContain(NEW_APP_PASS);
  });

  it('相対パスの --conf でも検証できる', async () => {
    const envFile = path.join(dir, 'relative.conf');
    writeFileSync(envFile, confWithOld());
    const result = await exec(
      '/bin/bash',
      [smtpScript, '--conf', 'relative.conf', '--no-restart'],
      {
        HOME: dir,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        SMTP_PASS: NEW_APP_PASS,
      },
      dir,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(sink.received.auths).toHaveLength(1);
  });
});
