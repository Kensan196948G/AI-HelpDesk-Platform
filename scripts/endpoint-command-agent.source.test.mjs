/**
 * 端末エージェントが結果の出所を申告することの契約テスト（docs/25 §20）。
 * fixture（--mock / Windows 以外）を実端末の結果に見せない。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const AGENT_PATH = path.join(REPO_ROOT, 'scripts', 'endpoint-command-agent.mjs');
const manifest = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/skills/approved.json'), 'utf8'),
);
const approved = manifest.skills.find((skill) => skill.id === 'spooler.status');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'aihd-agent-source-'));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function runAgentOnce(args) {
  const reports = [];
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          ok: true,
          command: {
            id: 'cmd-1',
            op_id: approved.id,
            params: {},
            skill_id: approved.id,
            skill_version: approved.version,
            skill_content_hash: approved.contentHash,
          },
        }),
      );
      return;
    }
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      reports.push(JSON.parse(raw));
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const configPath = path.join(tmpDir, `agent-${port}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      url: `http://127.0.0.1:${port}/api/device/agent`,
      deviceToken: 'test-token-0123456789-abcdef',
      browserDeviceId: 'device-1',
    }),
  );
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT_PATH, '--config', configPath, '--once', ...args], {
      stdio: 'ignore',
    });
    child.on('exit', resolve);
    child.on('error', reject);
  });
  await new Promise((resolve) => server.close(resolve));
  return reports;
}

describe('結果の出所', () => {
  it('--mock の結果は executionSource=mock を申告する', async () => {
    const reports = await runAgentOnce(['--mock']);
    expect(reports).toHaveLength(1);
    expect(reports[0].ok).toBe(true);
    expect(reports[0].result.executionSource).toBe('mock');
    expect(reports[0].result.normalized.name).toBe('Spooler');
  });

  it.skipIf(process.platform === 'win32')(
    'Windows 以外は --mock が無くても fixture なので mock を申告する',
    async () => {
      const reports = await runAgentOnce([]);
      expect(reports[0].result.executionSource).toBe('mock');
    },
  );

  it('endpoint_agent を申告するのは fixture を使わないときだけ', () => {
    const source = readFileSync(AGENT_PATH, 'utf8');
    expect(source).toContain("executionSource: mockMode ? 'mock' : 'endpoint_agent'");
    expect(source).toContain("const mockMode = Boolean(args.mock) || process.platform !== 'win32'");
  });
});
