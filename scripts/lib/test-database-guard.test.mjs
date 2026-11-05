import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertCurrentTestDatabase,
  assertTestDatabase,
  DEFAULT_TEST_DATABASE_NAME,
} from './test-database-guard.mjs';

const mocks = vi.hoisted(() => ({
  loadEnv: vi.fn(),
  existsSync: vi.fn(),
  postgres: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock('dotenv', () => ({ config: mocks.loadEnv }));
vi.mock('vitest/config', () => ({ defineConfig: (config) => config }));
vi.mock('postgres', () => ({ default: mocks.postgres }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('node:fs/promises', () => ({ readdir: mocks.readdir, readFile: mocks.readFile }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));
vi.mock('../../apps/api/src/auth/password.js', () => ({ hashPassword: () => 'fake-test-hash' }));

const DATABASE_URL = 'postgresql://fixture:fake-password@127.0.0.1:15432/ai_helpdesk_test';
const SENTINEL = 'synthetic-do-not-print';
let fakeProcess;
let queries;
let sql;

function useEnvironment(overrides = {}) {
  // ホストの env を列挙・継承しない。既存の env ファイルも fs mock により読まない。
  fakeProcess = Object.create(process);
  Object.assign(fakeProcess, {
    env: {
      NODE_ENV: 'test',
      DATABASE_URL,
      SESSION_SECRET: 'synthetic-session-secret-32-characters',
      SEED_PASSWORD: 'synthetic-seed-password',
      ...overrides,
    },
    exitCode: 0,
    exit: vi.fn(() => {
      throw new Error('unexpected-process-exit');
    }),
  });
  vi.stubGlobal('process', fakeProcess);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(true);
  mocks.readdir.mockResolvedValue([]);
  mocks.readFile.mockResolvedValue('');
  queries = [];
  sql = vi.fn(async (strings) => {
    const query = strings.join('');
    queries.push(query);
    return query.includes('current_database()') ? [{ database_name: 'ai_helpdesk_test' }] : [];
  });
  sql.begin = vi.fn(async () => {});
  sql.end = vi.fn(async () => {});
  sql.json = (value) => value;
  mocks.postgres.mockReturnValue(sql);
  for (const method of ['error', 'warn', 'info', 'log'])
    vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('接続前の test DB 純関数ガード', () => {
  it.each([
    ['postgresql', '127.0.0.1:15432'],
    ['postgres', 'localhost:5432'],
    ['postgresql', '[::1]:15432'],
    ['postgres', '127.0.0.1'],
  ])('明示 %s://%s の固定 CI fixture を許可する', (scheme, host) => {
    expect(
      assertTestDatabase({
        NODE_ENV: 'test',
        DATABASE_URL: `${scheme}://fixture:fake@${host}/${DEFAULT_TEST_DATABASE_NAME}`,
      }),
    ).toEqual({ databaseName: 'ai_helpdesk_test' });
  });

  it('動的 test DB は別に明示した期待名との完全一致時だけ許可する', () => {
    expect(
      assertTestDatabase({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://fixture:fake@127.0.0.1:15432/aihd_test_run_123',
        AIHD_TEST_DATABASE_NAME: 'aihd_test_run_123',
      }),
    ).toEqual({ databaseName: 'aihd_test_run_123' });
  });

  it.each([
    undefined,
    '',
    ' ',
    'not-a-url',
    'mysql://fixture:fake@127.0.0.1/ai_helpdesk_test',
    'postgresql:///ai_helpdesk_test',
    'postgresql://remote.example.test/ai_helpdesk_test',
    'postgresql://127.1/ai_helpdesk_test',
    'postgresql://2130706433/ai_helpdesk_test',
    'postgresql://0x7f000001/ai_helpdesk_test',
    'postgresql://localhost.evil.test/ai_helpdesk_test',
    'postgresql://localhost./ai_helpdesk_test',
    'postgresql://LOCALHOST/ai_helpdesk_test',
    'postgresql://127.0.0.2/ai_helpdesk_test',
    'postgresql://%31%32%37.0.0.1/ai_helpdesk_test',
    'postgresql://%2Fvar%2Frun%2Fpostgresql/ai_helpdesk_test',
    'postgresql://127.0.0.1,remote.example.test/ai_helpdesk_test',
    'postgresql://127.0.0.1:5432,127.0.0.1:5433/ai_helpdesk_test',
    'postgresql://fixture@remote.example.test@127.0.0.1/ai_helpdesk_test',
    'postgresql://127.0.0.1:0/ai_helpdesk_test',
    'postgresql://127.0.0.1:65536/ai_helpdesk_test',
    'postgresql://127.0.0.1:/ai_helpdesk_test',
    'postgresql://127.0.0.1/ai_helpdesk_mvp',
    'postgresql://127.0.0.1/ai_helpdesk_preview',
    'postgresql://127.0.0.1/none',
    'postgresql://127.0.0.1/',
    'postgresql://127.0.0.1/ai_helpdesk_test/other',
    'postgresql://127.0.0.1/%61i_helpdesk_test',
    'postgresql://127.0.0.1/ai_helpdesk_test?',
    'postgresql://127.0.0.1/ai_helpdesk_test?host=remote.example.test',
    'postgresql://127.0.0.1/ai_helpdesk_test?options=-csearch_path=public',
    'postgresql://127.0.0.1/ai_helpdesk_test?sslmode=disable',
    'postgresql://127.0.0.1/ai_helpdesk_test#',
    'postgresql://127.0.0.1/ai_helpdesk_test#other',
    ' postgresql://127.0.0.1/ai_helpdesk_test',
    'postgresql://127.0.0.1/ai_helpdesk_test\n',
  ])('危険・曖昧な URL を拒否する（fixture %s）', (databaseUrl) => {
    expect(() => assertTestDatabase({ NODE_ENV: 'test', DATABASE_URL: databaseUrl })).toThrow(
      '[test-database]',
    );
  });

  it.each([
    ['aihd_test_run_123', undefined],
    ['ai_helpdesk_test', 'aihd_test_other'],
    ['aihd_test_run_123', 'aihd_test_RUN_123'],
    ['ai_helpdesk_test', ''],
    ['ai_helpdesk_test', 'ai_helpdesk_mvp'],
    [`aihd_test_${'x'.repeat(64)}`, `aihd_test_${'x'.repeat(64)}`],
  ])('DB名 %s と期待名 %s が不一致・不正なら拒否する', (name, expected) => {
    expect(() =>
      assertTestDatabase({
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://127.0.0.1/${name}`,
        AIHD_TEST_DATABASE_NAME: expected,
      }),
    ).toThrow('[test-database]');
  });

  it.each(['production', 'development', undefined])(
    'NODE_ENV=%s の動作には介入しない（負対照）',
    (nodeEnv) => {
      expect(
        assertTestDatabase({ NODE_ENV: nodeEnv, DATABASE_URL: 'not-a-test-url' }),
      ).toBeUndefined();
    },
  );

  it('例外に DSN・資格情報・期待名を出さない', () => {
    for (const env of [
      { DATABASE_URL: `postgresql://name:${SENTINEL}@remote.example.test/${SENTINEL}` },
      { DATABASE_URL, AIHD_TEST_DATABASE_NAME: SENTINEL },
      { DATABASE_URL: `postgresql://name:${SENTINEL}@[broken/${SENTINEL}` },
    ]) {
      try {
        assertTestDatabase({ NODE_ENV: 'test', ...env });
        expect.fail('拒否が必要');
      } catch (error) {
        expect(String(error)).not.toContain(SENTINEL);
        expect(String(error)).not.toContain('postgresql://');
        expect(error.cause).toBeUndefined();
      }
    }
  });

  it('current_database() は期待値と一致する場合のみ許可し、失敗理由も値を含めない', () => {
    const target = { databaseName: 'ai_helpdesk_test' };
    expect(() => assertCurrentTestDatabase(target.databaseName, target)).not.toThrow();
    for (const actual of [undefined, null, SENTINEL, 'ai_helpdesk_mvp']) {
      expect(() => assertCurrentTestDatabase(actual, target)).toThrow('current_database()');
      expect(() => assertCurrentTestDatabase(actual, target)).not.toThrow(SENTINEL);
    }
  });
});

describe('test 設定・スクリプトの接続前配線（全 I/O は mock）', () => {
  it('config は test でどの env ファイルも読まず明示 URL を保持する', async () => {
    useEnvironment();
    const { config } = await import('../../apps/api/src/config.ts');
    expect(config.DATABASE_URL).toBe(DATABASE_URL);
    expect(config.DEEPSEEK_API_KEY).toBeUndefined();
    expect(config.RSP_SERVICE_KEY).toBeUndefined();
    expect(config.SMTP_PASS).toBeUndefined();
    expect(mocks.existsSync).not.toHaveBeenCalled();
    expect(mocks.loadEnv).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'postgresql://fixture:fake@127.0.0.1/ai_helpdesk_preview'])(
    'config の接続先不備はファイル補完より先に拒否する (%s)',
    async (databaseUrl) => {
      useEnvironment({ DATABASE_URL: databaseUrl });
      await expect(import('../../apps/api/src/config.ts')).rejects.toThrow('[test-database]');
      expect(mocks.loadEnv).not.toHaveBeenCalled();
      expect(mocks.postgres).not.toHaveBeenCalled();
    },
  );

  it.each(['development', 'production'])(
    '非testの %s は従来のdotenv方針を保持する（負対照）',
    async (nodeEnv) => {
      useEnvironment({
        NODE_ENV: nodeEnv,
        DATABASE_URL: 'postgresql://fixture:fake@127.0.0.1/none',
        AUTH_MODE: 'cloudflare-access',
      });
      await import('../../apps/api/src/config.ts');
      expect(mocks.loadEnv).toHaveBeenCalledExactlyOnceWith(
        nodeEnv === 'production'
          ? { path: expect.stringMatching(/\/\.env$/) }
          : { path: expect.stringMatching(/\/\.env\.local$/), override: true },
      );
    },
  );

  it.each(['../../scripts/migrate.ts', '../../scripts/seed.ts'])(
    '%s はtest URL不正をdriver生成前に拒否する（seed先行importも含む）',
    async (script) => {
      useEnvironment({
        DATABASE_URL: `postgresql://fixture:${SENTINEL}@127.0.0.1/ai_helpdesk_preview`,
      });
      await expect(import(script)).rejects.toThrow('[test-database]');
      expect(mocks.postgres).not.toHaveBeenCalled();
      expect(mocks.loadEnv).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    },
  );

  it.each(['../../scripts/migrate.ts', '../../scripts/seed.ts'])(
    '%s は最初のSELECTでcurrent_databaseを照合する',
    async (script) => {
      useEnvironment();
      await import(script);
      expect(queries[0]).toBe('SELECT current_database() AS database_name');
      expect(mocks.postgres).toHaveBeenCalledOnce();
      expect(mocks.loadEnv).not.toHaveBeenCalled();
      expect(sql.end).toHaveBeenCalledOnce();
      expect(fakeProcess.exitCode).toBe(0);
      if (script.endsWith('/seed.ts')) expect(sql.begin).toHaveBeenCalledOnce();
      else expect(queries[1]).toContain('CREATE TABLE');
    },
  );

  it.each(['../../scripts/migrate.ts', '../../scripts/seed.ts'])(
    '%s はcurrent_database不一致後に書き込まず値も出さない',
    async (script) => {
      useEnvironment();
      sql.mockImplementation(async (strings) => {
        queries.push(strings.join(''));
        return [{ database_name: SENTINEL }];
      });
      await import(script);
      expect(queries).toEqual(['SELECT current_database() AS database_name']);
      expect(sql.begin).not.toHaveBeenCalled();
      expect(mocks.readdir).not.toHaveBeenCalled();
      expect(sql.end).toHaveBeenCalledOnce();
      expect(fakeProcess.exitCode).toBe(1);
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(SENTINEL);
    },
  );

  it('globalSetupは不正URLで子プロセスを1回も生成しない', async () => {
    useEnvironment({ DATABASE_URL: 'postgresql://127.0.0.1/ai_helpdesk_mvp' });
    const { default: setup } = await import('../../tests/global-setup.ts');
    expect(() => setup()).toThrow('[test-database]');
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it.each(['development', 'production', undefined, ''])(
    'globalSetupは親NODE_ENV=%sをtestへ補正せず全I/O前に拒否する',
    async (nodeEnv) => {
      useEnvironment({ NODE_ENV: nodeEnv });
      const { default: setup } = await import('../../tests/global-setup.ts');
      expect(() => setup()).toThrow(
        '[test-database] globalSetup には親 NODE_ENV=test の明示指定が必要です。',
      );
      expect(fakeProcess.env.NODE_ENV).toBe(nodeEnv);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
      expect(mocks.loadEnv).not.toHaveBeenCalled();
      expect(mocks.existsSync).not.toHaveBeenCalled();
      expect(mocks.postgres).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    },
  );

  it.each(['development', 'production', undefined, '', 'test'])(
    'Vitest設定は親NODE_ENV=%sに関わらずworkerをtestに固定する',
    async (nodeEnv) => {
      useEnvironment({ NODE_ENV: nodeEnv });
      const { default: testConfig } = await import('../../vitest.config.ts');
      expect(testConfig.test.env.NODE_ENV).toBe('test');
      expect(fakeProcess.env.NODE_ENV).toBe(nodeEnv);
      expect(mocks.execFileSync).not.toHaveBeenCalled();
      expect(mocks.loadEnv).not.toHaveBeenCalled();
      expect(mocks.postgres).not.toHaveBeenCalled();
    },
  );

  it('globalSetupは明示testの検証済み設定を変更せずmigrate/seedへ渡す', async () => {
    useEnvironment();
    const { default: setup } = await import('../../tests/global-setup.ts');
    setup();
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
    for (const [, , options] of mocks.execFileSync.mock.calls) {
      expect(options.env.DATABASE_URL).toBe(DATABASE_URL);
      expect(options.env.NODE_ENV).toBe('test');
    }
    expect(mocks.loadEnv).not.toHaveBeenCalled();
  });

  it('アプリDBはconfig読込後に接続先が変更されてもdriver生成前に再検証する', async () => {
    useEnvironment();
    const { config } = await import('../../apps/api/src/config.ts');
    config.DATABASE_URL = 'postgresql://127.0.0.1/ai_helpdesk_mvp';
    await expect(import('../../apps/api/src/db.ts')).rejects.toThrow('[test-database]');
    expect(mocks.postgres).not.toHaveBeenCalled();
  });

  it.each([undefined, `postgresql://fixture:${SENTINEL}@127.0.0.1/mirai_info`])(
    'testの名簿参照はURL有無に関わらずdriverを生成しない',
    async (directoryUrl) => {
      useEnvironment({ MIRAI_INFO_DATABASE_URL: directoryUrl });
      const directory = await import('../../apps/api/src/lib/mirai-info.ts');
      expect(await directory.listEmployees('staff')).toEqual({
        employees: [],
        total: 0,
        cachedAt: null,
        error: 'mirai-info-disabled-in-test',
      });
      expect(await directory.findEmployeeByEmail('synthetic@example.test')).toBeNull();
      expect(await directory.findEmployeeEmailByNo('SYNTHETIC')).toBeNull();
      expect(mocks.postgres).not.toHaveBeenCalled();
    },
  );
});
