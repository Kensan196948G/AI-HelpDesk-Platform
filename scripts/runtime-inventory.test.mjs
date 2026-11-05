import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  active: false,
  opens: [],
  reads: [],
  writes: [],
  beforeRead: null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const wrapped = { ...actual };
  wrapped.open = async (...args) => {
    if (io.active) {
      io.opens.push(String(args[0]));
      const flags = args[1];
      const writeFlags =
        constants.O_WRONLY |
        constants.O_RDWR |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_APPEND;
      if (typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & writeFlags) !== 0) {
        io.writes.push('open-write');
      }
    }
    const handle = await actual.open(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      if (io.active) {
        io.reads.push(String(args[0]));
        if (io.beforeRead) await io.beforeRead(String(args[0]));
      }
      return originalRead(...readArgs);
    };
    return handle;
  };
  wrapped.readFile = async (...args) => {
    if (io.active) io.reads.push(String(args[0]));
    return actual.readFile(...args);
  };
  for (const method of [
    'writeFile',
    'appendFile',
    'copyFile',
    'rename',
    'rm',
    'unlink',
    'mkdir',
    'chmod',
    'truncate',
    'symlink',
    'link',
  ]) {
    wrapped[method] = async (...args) => {
      if (io.active) io.writes.push(method);
      return actual[method](...args);
    };
  }
  return wrapped;
});

// fixture 操作は監視対象から分離し、既存ファイル・env の値は一切利用しない。
const fs = await vi.importActual('node:fs/promises');
const { createRuntimeInventory, verifyRuntimeInventory, runCli } = await import(
  './runtime-inventory.mjs'
);
const PROTOTYPE = 'Mirai_AIHelpdesk_Cowork_StepWizard_V3.1_PCinfo_Offline.html';
const ROOT_FILES = ['package.json', 'package-lock.json', 'apps/api/package.json', PROTOTYPE];
const BRIDGES = [
  'staff-access-bridge',
  'bridge',
  'device-bridge',
  'honest-labels-bridge',
  'employee-bridge',
  'assist-bridge',
  'resolve-bridge',
  'remote-support-bridge',
  'handover-workspace-bridge',
  'folder-access-bridge',
  'support-session-bridge',
].map((name) => `apps/api/src/prototype/${name}.js`);
const SKILLS = [
  'os-info',
  'disk-space',
  'spooler-status',
  'service-status',
  'network-adapters',
  'spooler-restart',
  'spooler-queue-purge',
  'service-start',
  'service-restart',
  'network-adapter-restart',
  'defender-update',
  'recyclebin-clear',
  'temp-cleanup',
  'dns-flush',
  'bitlocker-status',
  'defender-quickscan',
  'folder-summary',
  'user-marker-set',
  'user-marker-clear',
  'user-marker-status',
].map((name) => `scripts/skills/windows/${name}.ps1`);
const DIST_REQUIRED = ['index', 'config', 'db', 'server'].map((name) => `apps/api/dist/${name}.js`);
const DIST = [...DIST_REQUIRED, 'apps/api/dist/lib/helper.js'];
const FIXED_FILES = [...ROOT_FILES, ...BRIDGES, ...SKILLS, ...DIST];
const LIMITATIONS = [
  'APPROVAL_MANIFEST:EXTERNAL_NOT_INCLUDED',
  'ALLOWLIST:EXTERNAL_NOT_INCLUDED',
  'DEPENDENCIES:NOT_VERIFIED',
  'SOURCE_BUILD_PROVENANCE:NOT_VERIFIED',
  'RELEASE_SIGNATURE:NOT_VERIFIED',
  'RUNTIME_BEHAVIOR:NOT_VERIFIED',
  'SNAPSHOT_ATOMICITY:NOT_GUARANTEED',
  'MIGRATION_STATE:NOT_VERIFIED',
  'PLATFORM_COMPATIBILITY:NOT_VERIFIED',
];
const CODES = [
  'INVENTORY_ARGUMENT_INVALID',
  'INVENTORY_ROOT_INVALID',
  'INVENTORY_PATH_INVALID',
  'INVENTORY_FILE_UNSAFE',
  'INVENTORY_LIMIT_EXCEEDED',
  'INVENTORY_CHANGED',
  'INVENTORY_INCOMPLETE',
  'INVENTORY_MANIFEST_INVALID',
  'INVENTORY_MISMATCH',
  'INVENTORY_READ_FAILED',
];
const SENTINEL = 'SYNTHETIC_PRIVATE_CONTENT_MUST_NOT_APPEAR';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(JSON.stringify(value));
let parent;
let root;
let owned;

function resetObservation() {
  io.opens.length = 0;
  io.reads.length = 0;
  io.writes.length = 0;
  io.beforeRead = null;
  io.active = true;
}

async function ownedPath(target) {
  const absolute = path.resolve(target);
  const relative = path.relative(owned, absolute);
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    (await fs.realpath(owned)) !== owned
  ) {
    throw new Error('合成 fixture の所有範囲を確認できません。');
  }
  return absolute;
}

async function removeOwned(target) {
  await fs.rm(await ownedPath(target), { recursive: true, force: true });
}

async function put(relative, content = `synthetic fixture: ${relative}\n`) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.writeFile(target, content, { mode: 0o600 });
}

async function rejected(promise, expectedCode) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(CODES).toContain(error.code);
  expect(error.message).toBe(error.code);
  if (expectedCode) expect(error.code).toBe(expectedCode);
  expect(error.message).not.toContain(root);
  expect(error.message).not.toContain(SENTINEL);
}

beforeEach(async () => {
  io.active = false;
  parent = await fs.realpath(tmpdir());
  owned = await fs.mkdtemp(path.join(parent, 'aihd-inventory-test-'));
  await fs.chmod(owned, 0o700);
  root = path.join(owned, 'root');
  await fs.mkdir(root, { mode: 0o700 });
  for (const file of FIXED_FILES) await put(file);
  resetObservation();
});

afterEach(async () => {
  io.active = false;
  // 自分で作成した絶対パス・所有者・名前・直下親を削除直前に照合する。
  const stat = await fs.lstat(owned);
  if (
    path.dirname(owned) !== parent ||
    !path.basename(owned).startsWith('aihd-inventory-test-') ||
    (await fs.realpath(owned)) !== owned ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== (await fs.lstat(root)).uid
  ) {
    throw new Error('合成 fixture の削除先を確認できません。');
  }
  await fs.rm(owned, { recursive: true, force: true });
});

describe('runtime inventory の独立固定契約', () => {
  it('独立固定リストの ROOT4・bridge11・catalog20・必須dist4を欠落なく対象化する', async () => {
    const inventory = await createRuntimeInventory(root);
    expect(inventory.rootRelativeEntries.map((entry) => entry.path)).toEqual(
      [...FIXED_FILES].sort(),
    );
    expect(Object.keys(inventory).sort()).toEqual([
      'deploymentReady',
      'kind',
      'limitations',
      'rootRelativeEntries',
      'schemaVersion',
      'snapshotSha256',
    ]);
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.kind).toBe('aihd-runtime-inventory');
    expect(inventory.deploymentReady).toBe(false);
    expect(inventory.limitations).toEqual(LIMITATIONS);
    expect(inventory.snapshotSha256).toBe(hash(JSON.stringify(inventory.rootRelativeEntries)));
    for (const entry of inventory.rootRelativeEntries) {
      expect(Object.keys(entry)).toEqual(['path', 'bytes', 'sha256']);
      const bytes = Buffer.from(`synthetic fixture: ${entry.path}\n`);
      expect(entry.bytes).toBe(bytes.length);
      expect(entry.sha256).toBe(hash(bytes));
    }
    expect(JSON.stringify(inventory)).not.toContain(root);
    expect(io.writes).toEqual([]);
    expect(await verifyRuntimeInventory(root, inventory)).toEqual(inventory);
    expect(await createRuntimeInventory(root)).toEqual(inventory);
  });

  it('env・個人情報manifest・名簿・依存・map・catalog外skillは内容を読まず/hashしない', async () => {
    const excluded = [
      '.env',
      '.env.test.local',
      'docs/MailAddress.txt',
      'scripts/skills/approved.json',
      'node_modules/synthetic-private/unread-dependency.js',
      'apps/api/dist/server.js.map',
      'scripts/skills/windows/diag-sleep.ps1',
    ];
    for (const file of excluded) await put(file, SENTINEL);
    resetObservation();
    const inventory = await createRuntimeInventory(root);
    const contentsOpened = [...io.opens, ...io.reads];
    for (const file of excluded) {
      expect(inventory.rootRelativeEntries.some((entry) => entry.path === file)).toBe(false);
      // 本体は /proc/self/fd/<親fd>/<basename> で開くため、相対パス全体ではなく末尾も照合する。
      expect(contentsOpened.some((opened) => opened.endsWith(`/${path.basename(file)}`))).toBe(
        false,
      );
    }
    expect(JSON.stringify(inventory)).not.toContain(SENTINEL);
    expect(io.writes).toEqual([]);
  });

  it.each([...ROOT_FILES, ...BRIDGES, ...SKILLS, ...DIST_REQUIRED])(
    '必須 %s の欠落は成功manifestにしない',
    async (file) => {
      await removeOwned(path.join(root, file));
      await rejected(createRuntimeInventory(root), 'INVENTORY_INCOMPLETE');
    },
  );

  it.each(['apps/api/dist/index.js', 'apps/api/dist/lib/helper.js'])(
    '空のdist JS %sを拒否する',
    async (file) => {
      await put(file, '');
      await rejected(createRuntimeInventory(root), 'INVENTORY_INCOMPLETE');
    },
  );

  it('dist が無い場合は失敗する', async () => {
    await removeOwned(path.join(root, 'apps/api/dist'));
    await rejected(createRuntimeInventory(root));
  });

  it.each(['', '.', 'relative/root', undefined, null])('不正root %sを拒否する', async (invalid) => {
    await rejected(createRuntimeInventory(invalid));
  });

  it('存在しない・非canonical・file・symlink rootを拒否する', async () => {
    const alias = path.join(owned, 'alias');
    await fs.symlink(root, alias);
    for (const invalid of [
      path.join(owned, 'missing'),
      `${root}/.`,
      `${root}/`,
      path.join(root, 'package.json'),
      alias,
    ]) {
      await rejected(createRuntimeInventory(invalid));
    }
  });

  it.each(['package.json', 'apps/api/src/prototype/bridge.js'])(
    '末尾symlink %sを拒否する',
    async (file) => {
      const external = path.join(owned, 'outside-sentinel');
      await fs.writeFile(external, SENTINEL, { mode: 0o600 });
      await removeOwned(path.join(root, file));
      await fs.symlink(external, path.join(root, file));
      resetObservation();
      await rejected(createRuntimeInventory(root), 'INVENTORY_FILE_UNSAFE');
      expect(io.opens.some((opened) => opened.endsWith('/outside-sentinel'))).toBe(false);
    },
  );

  it('親symlinkを拒否する', async () => {
    const target = path.join(owned, 'outside-prototype');
    await fs.mkdir(target, { mode: 0o700 });
    await removeOwned(path.join(root, 'apps/api/src/prototype'));
    await fs.symlink(target, path.join(root, 'apps/api/src/prototype'));
    await rejected(createRuntimeInventory(root), 'INVENTORY_FILE_UNSAFE');
  });

  it('hardlinkと非regular対象を拒否する', async () => {
    const target = path.join(root, 'package.json');
    await fs.link(target, path.join(owned, 'hardlink'));
    await rejected(createRuntimeInventory(root), 'INVENTORY_FILE_UNSAFE');
    await removeOwned(path.join(owned, 'hardlink'));
    await removeOwned(target);
    await fs.mkdir(target);
    await rejected(createRuntimeInventory(root), 'INVENTORY_FILE_UNSAFE');
  });

  it.each(['file', 'total', 'count'])('%s上限を超える入力は失敗する', async (limit) => {
    if (limit === 'file')
      await put('apps/api/dist/index.js', Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    if (limit === 'total') {
      for (let index = 0; index < 9; index++)
        await put(`apps/api/dist/large-${index}.js`, Buffer.alloc(4 * 1024 * 1024, 0x61));
    }
    if (limit === 'count') {
      for (let index = 0; index < 513; index++) await put(`apps/api/dist/count-${index}.js`);
    }
    await rejected(createRuntimeInventory(root), 'INVENTORY_LIMIT_EXCEEDED');
  });
});

describe('manifest は整合性のみ検証し出自・配備可否を証明しない', () => {
  it.each([
    ['null', () => null],
    ['array', () => []],
    ['empty', () => ({})],
    ['extra', (m) => ({ ...m, provenanceVerified: true })],
    ['version', (m) => ({ ...m, schemaVersion: '1' })],
    ['kind', (m) => ({ ...m, kind: 'other' })],
    ['ready', (m) => ({ ...m, deploymentReady: true })],
    ['empty inventory', (m) => ({ ...m, rootRelativeEntries: [] })],
    ['hash type', (m) => ({ ...m, snapshotSha256: 123 })],
    ['limitations', (m) => ({ ...m, limitations: [] })],
    ['unsorted', (m) => ({ ...m, rootRelativeEntries: [...m.rootRelativeEntries].reverse() })],
    [
      'duplicate',
      (m) => ({ ...m, rootRelativeEntries: [m.rootRelativeEntries[0], ...m.rootRelativeEntries] }),
    ],
    [
      'entry extra',
      (m) => {
        m.rootRelativeEntries[0].origin = 'claimed';
        return m;
      },
    ],
    [
      'bytes type',
      (m) => {
        m.rootRelativeEntries[0].bytes = '10';
        return m;
      },
    ],
    [
      'bytes negative',
      (m) => {
        m.rootRelativeEntries[0].bytes = -1;
        return m;
      },
    ],
    [
      'bytes fraction',
      (m) => {
        m.rootRelativeEntries[0].bytes = 1.5;
        return m;
      },
    ],
    [
      'entry hash type',
      (m) => {
        m.rootRelativeEntries[0].sha256 = null;
        return m;
      },
    ],
    [
      'entry raw hash',
      (m) => {
        m.rootRelativeEntries[0].sha256 = SENTINEL;
        return m;
      },
    ],
  ])('%sの不正schemaは現在FSを読む前に拒否する', async (_label, mutate) => {
    const manifest = mutate(clone(await createRuntimeInventory(root)));
    resetObservation();
    await rejected(verifyRuntimeInventory(root, manifest), 'INVENTORY_MANIFEST_INVALID');
    expect(io.opens).toEqual([]);
    expect(io.reads).toEqual([]);
  });

  it.each([
    '../package.json',
    '/etc/passwd',
    'apps\\api\\dist\\index.js',
    'apps/api/dist/../server.js',
    'apps/api/dist/index.js?query',
    'node_modules/private.js',
    '.env',
    'docs/MailAddress.txt',
    'scripts/skills/approved.json',
    'apps/api/src/prototype/unknown.js',
    'scripts/skills/windows/diag-sleep.ps1',
    'unknown.js',
    'apps/api/dist/a\u0000.js',
  ])('manifestの禁止・未知path %sは内容read前に拒否する', async (invalidPath) => {
    const manifest = await createRuntimeInventory(root);
    manifest.rootRelativeEntries[0].path = invalidPath;
    manifest.rootRelativeEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    manifest.snapshotSha256 = hash(JSON.stringify(manifest.rootRelativeEntries));
    resetObservation();
    await rejected(verifyRuntimeInventory(root, manifest));
    expect(io.opens).toEqual([]);
    expect(io.reads).toEqual([]);
  });

  it.each(['snapshot', 'entry hash', 'remove asset', 'unknown dist'])(
    '%sの整合性不一致を拒否する',
    async (change) => {
      const manifest = clone(await createRuntimeInventory(root));
      if (change === 'snapshot') manifest.snapshotSha256 = 'f'.repeat(64);
      if (change === 'entry hash') manifest.rootRelativeEntries[0].sha256 = 'f'.repeat(64);
      if (change === 'remove asset') manifest.rootRelativeEntries.pop();
      if (change === 'unknown dist')
        manifest.rootRelativeEntries.push({
          path: 'apps/api/dist/unknown.js',
          bytes: 1,
          sha256: hash('x'),
        });
      if (change !== 'snapshot') {
        manifest.rootRelativeEntries.sort((a, b) =>
          a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
        );
        manifest.snapshotSha256 = hash(JSON.stringify(manifest.rootRelativeEntries));
      }
      await rejected(verifyRuntimeInventory(root, manifest));
    },
  );

  it.each(DIST_REQUIRED)('manifestから必須dist %sを除き再hashしても拒否する', async (relative) => {
    const manifest = await createRuntimeInventory(root);
    manifest.rootRelativeEntries = manifest.rootRelativeEntries.filter(
      (entry) => entry.path !== relative,
    );
    manifest.snapshotSha256 = hash(JSON.stringify(manifest.rootRelativeEntries));
    resetObservation();
    await rejected(verifyRuntimeInventory(root, manifest), 'INVENTORY_MANIFEST_INVALID');
    expect(io.opens).toEqual([]);
    expect(io.reads).toEqual([]);
  });

  it('manifestのdist JS bytes=0を再hashしてもFS前に拒否する', async () => {
    const manifest = await createRuntimeInventory(root);
    manifest.rootRelativeEntries.find((entry) => entry.path === 'apps/api/dist/index.js').bytes = 0;
    manifest.snapshotSha256 = hash(JSON.stringify(manifest.rootRelativeEntries));
    resetObservation();
    await rejected(verifyRuntimeInventory(root, manifest), 'INVENTORY_MANIFEST_INVALID');
    expect(io.opens).toEqual([]);
    expect(io.reads).toEqual([]);
  });

  it('先に読み終えた対象を後続読込中に同size差替えすると最終照合で拒否する', async () => {
    const relative = PROTOTYPE;
    const original = await fs.readFile(path.join(root, relative));
    let mutated = false;
    io.beforeRead = async (opened) => {
      if (!mutated && opened.endsWith('/config.js')) {
        mutated = true;
        await put(relative, Buffer.alloc(original.length, 0x78));
      }
    };
    await rejected(createRuntimeInventory(root), 'INVENTORY_CHANGED');
    expect(mutated).toBe(true);
  });

  it.each(['size changed', 'same size replaced'])(
    'snapshot後に%sなら照合を失敗させる',
    async (change) => {
      const manifest = await createRuntimeInventory(root);
      const relative = 'apps/api/dist/server.js';
      const original = await fs.readFile(path.join(root, relative));
      await put(
        relative,
        change === 'size changed'
          ? `${SENTINEL}\n${SENTINEL}`
          : Buffer.alloc(original.length, 0x78),
      );
      await rejected(verifyRuntimeInventory(root, manifest), 'INVENTORY_MISMATCH');
    },
  );

  it('CLI inspect/verifyもsynthetic rootだけで安全JSONを返し書込まない', async () => {
    const inspected = await runCli(['inspect', '--root', root]);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.output).toEqual(await createRuntimeInventory(root));
    const manifestPath = path.join(owned, 'runtime-inventory.json');
    await fs.writeFile(manifestPath, JSON.stringify(inspected.output), { mode: 0o600 });
    resetObservation();
    const verified = await runCli(['verify', '--root', root, '--manifest', manifestPath]);
    expect(verified.exitCode).toBe(0);
    expect(verified.output).toEqual(inspected.output);
    expect(verified.output.deploymentReady).toBe(false);
    expect(io.writes).toEqual([]);
  });

  it.each([
    'approved.json',
    '.env',
    'MailAddress.txt',
    '.env.private/runtime-inventory.json',
    'node_modules/runtime-inventory.json',
    'approved.json/runtime-inventory.json',
    'MailAddress.txt/runtime-inventory.json',
  ])('CLIは禁止manifest %sをopen/readする前に拒否する', async (relative) => {
    const manifestPath = path.join(owned, relative);
    resetObservation();
    const result = await runCli(['verify', '--root', root, '--manifest', manifestPath]);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toEqual({
      ok: false,
      deploymentReady: false,
      code: expect.stringMatching(/^INVENTORY_/),
    });
    expect(io.opens).toEqual([]);
    expect(io.reads).toEqual([]);
    expect(JSON.stringify(result.output)).not.toContain(owned);
  });

  it.each(['symlink', 'hardlink', 'directory', 'oversize', 'invalid JSON'])(
    'CLIは%sのmanifestを拒否する',
    async (kind) => {
      const file = path.join(owned, 'runtime-inventory.json');
      if (kind === 'symlink') {
        const outside = path.join(owned, 'synthetic-private.json');
        await fs.writeFile(outside, SENTINEL);
        await fs.symlink(outside, file);
      } else if (kind === 'directory') await fs.mkdir(file);
      else {
        await fs.writeFile(
          file,
          kind === 'oversize' ? Buffer.alloc(1024 * 1024 + 1, 0x61) : SENTINEL,
        );
        if (kind === 'hardlink') await fs.link(file, path.join(owned, 'manifest-link'));
      }
      resetObservation();
      const result = await runCli(['verify', '--root', root, '--manifest', file]);
      expect(result.exitCode).toBe(1);
      expect(result.output.deploymentReady).toBe(false);
      expect(CODES).toContain(result.output.code);
      expect(JSON.stringify(result.output)).not.toContain(SENTINEL);
      expect(JSON.stringify(result.output)).not.toContain(owned);
      expect(io.writes).toEqual([]);
    },
  );
});
