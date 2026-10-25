#!/usr/bin/env node
/**
 * AI HelpDesk 端末エージェント（読み取り専用）。
 *
 * 収集するもの: OS / CPU / メモリ / ディスク / GPU / ネットワーク / バッテリー /
 *               プリンター / 音声 / USB / 導入ソフト / セキュリティ状態。
 * 収集しないもの: ファイル内容 / 閲覧履歴 / 画面 / キー入力 / メール本文。
 *
 * 使い方:
 *   node scripts/endpoint-agent.mjs --config ~/.config/ai-helpdesk/device-agent.json --once
 *   node scripts/endpoint-agent.mjs --dry-run --print-json
 *   node scripts/endpoint-agent.mjs --debug --dry-run   # 取得コマンドの失敗を表示
 *
 * 設定ファイル（0600）:
 *   {
 *     "url": "https://ai-helpdesk.mirai-dx-platform.com/api/device/agent",
 *     "deviceToken": "aihd_...",
 *     "browserDeviceId": "WEB-XXXXXXXX",  // PCチェック画面の端末名（同一端末へリンク）
 *     "cfAccessClientId": "...",       // Cloudflare Access サービスドメインを使う場合
 *     "cfAccessClientSecret": "...",
 *     "proxySecret": "",               // REQUIRE_PROXY_SECRET=true の場合のみ
 *     "intervalMinutes": 60,
 *     "deviceId": "任意の端末ID（省略時はホスト名）"
 *   }
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = parseArgs(process.argv.slice(2));
const configPath =
  args.config ??
  process.env.AIHD_AGENT_CONFIG ??
  path.join(os.homedir(), '.config', 'ai-helpdesk', 'device-agent.json');
const config = readConfig(configPath);
const url =
  args.url ??
  process.env.AIHD_DEVICE_URL ??
  config.url ??
  'https://ai-helpdesk.mirai-dx-platform.com/api/device/agent';
const deviceToken = process.env.AIHD_DEVICE_TOKEN ?? config.deviceToken;
const intervalMinutes = Number(args.interval ?? config.intervalMinutes ?? 60);
const dryRun = Boolean(args['dry-run']);
const debug = Boolean(args.debug) || process.env.AIHD_AGENT_DEBUG === '1';
const printJson = Boolean(args['print-json']);
const watch = Boolean(args.watch);
const deviceId = process.env.AIHD_DEVICE_ID ?? config.deviceId ?? os.hostname();
const browserDeviceId =
  args['browser-device-id'] ?? process.env.AIHD_BROWSER_DEVICE_ID ?? config.browserDeviceId;

if (!deviceToken && !dryRun) {
  console.error(
    '[agent] デバイストークンがありません。管理者に発行を依頼し、設定ファイルへ保存してください。',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current?.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function readConfig(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error(`[agent] 設定ファイルを読めません: ${file}: ${error.message}`);
    return {};
  }
}

function safe(command, commandArgs, timeout = 20000) {
  try {
    return execFileSync(command, commandArgs, {
      encoding: 'utf8',
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch (error) {
    if (debug) {
      console.error(
        `[agent] command failed: ${command} ${commandArgs.join(' ')}: ${error.message}`,
      );
    }
    return null;
  }
}

function platformKind() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function powershell(script, timeout = 30000) {
  const command = safe(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    timeout,
  );
  if (command) return command;
  return safe('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], timeout);
}

function parseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function psJson(script, timeout = 30000) {
  return parseJson(powershell(`${script} | ConvertTo-Json -Compress -Depth 6`, timeout));
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function truncate(value, max = 300) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function gb(bytes) {
  return typeof bytes === 'number' ? Math.round((bytes / 1024 ** 3) * 10) / 10 : undefined;
}

function linuxOsName() {
  const osRelease = readText('/etc/os-release');
  if (!osRelease) return `Linux ${os.release()}`;
  const pretty = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
  const version = osRelease.match(/^VERSION_ID="?([^"\n]+)"?/m)?.[1];
  return pretty ? `${pretty}${version ? ` (${version})` : ''}` : `Linux ${os.release()}`;
}

function windowsCollect() {
  const osInfo =
    psJson(
      'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory',
    ) ?? {};
  const computer =
    psJson(
      'Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory,Domain,PartOfDomain',
    ) ?? {};
  const cpu =
    psJson(
      'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,LoadPercentage',
    ) ?? {};
  const disks = asArray(
    psJson(
      'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace',
    ),
  );
  const gpus = asArray(
    psJson(
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,DriverVersion',
    ),
  );
  const adapters = asArray(
    psJson('Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed'),
  );
  const ipv4 = asArray(
    psJson(
      "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object IPAddress,InterfaceAlias",
    ),
  );
  const battery = asArray(
    psJson('Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus'),
  )[0];
  const printers = asArray(psJson('Get-Printer | Select-Object Name,PrinterStatus')).slice(0, 50);
  const printJobs = asArray(psJson('Get-PrintJob | Select-Object Id,PrinterName')).length;
  const sound = asArray(psJson('Get-CimInstance Win32_SoundDevice | Select-Object Name'));
  const usb = asArray(psJson('Get-CimInstance Win32_USBHub | Select-Object DeviceID')).length;
  const bios = psJson('Get-CimInstance Win32_BIOS | Select-Object SerialNumber') ?? {};
  const enclosure =
    psJson('Get-CimInstance Win32_SystemEnclosure | Select-Object SMBIOSAssetTag') ?? {};
  const softwareRaw = asArray(
    psJson(
      [
        "$paths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');",
        'Get-ItemProperty $paths -ErrorAction SilentlyContinue |',
        'Where-Object { $_.DisplayName } |',
        'Select-Object DisplayName,DisplayVersion,Publisher |',
        'Sort-Object DisplayName -Unique',
      ].join(' '),
      45000,
    ),
  );
  const antivirus =
    psJson(
      'Get-MpComputerStatus | Select-Object AntivirusEnabled,AMServiceEnabled,AntivirusSignatureVersion',
      20000,
    ) ?? null;
  const bitlocker = asArray(
    psJson('Get-BitLockerVolume | Select-Object MountPoint,ProtectionStatus,VolumeStatus', 20000),
  );
  const hotfix = asArray(
    psJson(
      'Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 5 HotFixID,InstalledOn',
    ),
  );
  const recentErrorsRaw = safe(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-WinEvent -FilterHashtable @{LogName='System';Level=1,2;StartTime=(Get-Date).AddDays(-1)} -ErrorAction SilentlyContinue | Measure-Object).Count",
    ],
    30000,
  );
  const boot = osInfo.LastBootUpTime ? new Date(osInfo.LastBootUpTime) : null;
  const uptimeSeconds = boot
    ? Math.max(0, Math.floor((Date.now() - boot.getTime()) / 1000))
    : os.uptime();
  const totalMemory = numberOrUndefined(computer.TotalPhysicalMemory) ?? os.totalmem();
  const freeMemory = numberOrUndefined(osInfo.FreePhysicalMemory);
  const antivirusEnabled = antivirus?.AntivirusEnabled;
  const bitlockerEnabled =
    bitlocker.length > 0
      ? bitlocker.some(
          (volume) =>
            String(volume.ProtectionStatus ?? '').toLowerCase() === 'on' ||
            String(volume.ProtectionStatus ?? '') === '1',
        )
      : undefined;

  return {
    os: `${osInfo.Caption ?? 'Windows'} ${osInfo.Version ?? ''}`.trim(),
    platform: 'Windows',
    arch: os.arch(),
    hardware: {
      assetNo:
        truncate(enclosure.SMBIOSAssetTag) || truncate(process.env.AIHD_ASSET_NO) || undefined,
      serial: truncate(bios.SerialNumber, 200),
      model: truncate(computer.Model, 200),
      manufacturer: truncate(computer.Manufacturer, 200),
      domainJoined: computer.PartOfDomain
        ? `ドメイン参加済み（${truncate(computer.Domain, 200) ?? '不明'}）`
        : '未参加（ワークグループ）',
      cpu: {
        model: truncate(cpu.Name),
        cores: numberOrUndefined(cpu.NumberOfCores),
        logicalCores: numberOrUndefined(cpu.NumberOfLogicalProcessors),
        speedMHz: numberOrUndefined(cpu.MaxClockSpeed),
        usagePercent: numberOrUndefined(cpu.LoadPercentage),
      },
      memory: {
        totalBytes: totalMemory,
        freeBytes: freeMemory !== undefined ? freeMemory * 1024 : undefined,
        usagePercent:
          freeMemory !== undefined && totalMemory
            ? Math.round((1 - (freeMemory * 1024) / totalMemory) * 100)
            : undefined,
      },
      disks: disks.slice(0, 50).map((disk) => ({
        name: truncate(disk.VolumeName) ?? truncate(disk.DeviceID),
        mount: truncate(disk.DeviceID),
        totalBytes: numberOrUndefined(disk.Size),
        freeBytes: numberOrUndefined(disk.FreeSpace),
      })),
      gpu: gpus.slice(0, 20).map((gpu) => ({
        name: truncate(gpu.Name),
        vendor: truncate(gpu.AdapterCompatibility),
        driver: truncate(gpu.DriverVersion),
      })),
      network: {
        adapters: adapters.slice(0, 80).map((adapter) => ({
          name: truncate(adapter.Name) ?? 'adapter',
          type: truncate(adapter.InterfaceDescription),
          status: truncate(adapter.Status),
          vpn: /vpn|wireguard|forti|anyconnect|globalprotect|openvpn|tap|tun/i.test(
            `${adapter.Name ?? ''} ${adapter.InterfaceDescription ?? ''}`,
          ),
        })),
        ipv4: ipv4.map((entry) => truncate(entry.IPAddress, 60)).filter((value) => Boolean(value)),
        online: true,
      },
      battery: battery
        ? {
            levelPercent: numberOrUndefined(battery.EstimatedChargeRemaining),
            charging: Number(battery.BatteryStatus) === 2,
          }
        : undefined,
      mediaDevices: {
        audioOutput: sound.length,
      },
      printers: printers.map((printer) => ({
        name: truncate(printer.Name) ?? 'printer',
        status: truncate(String(printer.PrinterStatus ?? '')),
        jobs: Math.round(printJobs / Math.max(1, printers.length)),
      })),
      printSpooler:
        safe('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Service Spooler -ErrorAction SilentlyContinue).Status',
        ]) ?? undefined,
      audioOutput: truncate(sound[0]?.Name),
      usbDevices: Math.min(1000, usb),
      uptimeSeconds,
    },
    software: softwareRaw
      .map((app) => ({
        name: truncate(app.DisplayName),
        version: truncate(app.DisplayVersion, 100),
        publisher: truncate(app.Publisher, 200),
      }))
      .filter((app) => Boolean(app.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 300),
    security: {
      antivirus: antivirus
        ? {
            enabled: antivirusEnabled === true || antivirusEnabled === 'True',
            name: 'Microsoft Defender',
            signature: truncate(antivirus.AntivirusSignatureVersion, 100),
          }
        : undefined,
      diskEncryption:
        bitlockerEnabled === undefined
          ? undefined
          : { enabled: bitlockerEnabled, detail: 'BitLocker' },
      windowsUpdate: {
        detail: hotfix[0]?.HotFixID
          ? `最新の更新: ${truncate(hotfix[0].HotFixID, 100)}`
          : undefined,
      },
      recentErrors: recentErrorsRaw !== null ? numberOrUndefined(recentErrorsRaw) : undefined,
    },
  };
}

function linuxCollect() {
  const df = safe('df', ['-B1', '-P', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'squashfs'], 15000);
  const disks = [];
  for (const line of (df ?? '').split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const totalBytes = numberOrUndefined(parts[1]);
    const freeBytes = numberOrUndefined(parts[3]);
    if (totalBytes === undefined) continue;
    disks.push({
      name: parts[0],
      mount: parts.slice(5).join(' '),
      totalBytes,
      freeBytes,
    });
    if (disks.length >= 20) break;
  }

  const lspci = safe('lspci', [], 10000) ?? '';
  const gpus = (lspci.match(/^.*(VGA|3D|Display).*$/gim) ?? [])
    .map((line) => line.replace(/^[0-9a-f:.]+\s+/i, '').trim())
    .slice(0, 5)
    .map((name) => ({ name }));

  const ipJson = parseJson(safe('ip', ['-j', 'addr'], 10000));
  const adapters = [];
  const ipv4 = [];
  for (const link of asArray(ipJson)) {
    const name = truncate(link.ifname) ?? 'interface';
    const isVpn = /^(tun|tap|wg|ppp|vpn)/i.test(name);
    adapters.push({
      name,
      type: link.link_type,
      status: link.operstate,
      vpn: isVpn,
    });
    for (const address of asArray(link.addr_info)) {
      if (address.family === 'inet' && address.local && !address.local.startsWith('127.')) {
        ipv4.push(address.local);
      }
    }
  }

  const software = [];
  // biome-ignore lint/suspicious/noTemplateCurlyInString: dpkg-query の出力フォーマット（${...} は dpkg のプレースホルダ）
  const dpkg = safe('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Maintainer}\n'], 30000);
  if (dpkg) {
    for (const line of dpkg.split('\n')) {
      const [name, version, publisher] = line.split('\t');
      if (!name) continue;
      software.push({
        name: truncate(name),
        version: truncate(version, 100),
        publisher: truncate(publisher, 200),
      });
      if (software.length >= 300) break;
    }
  } else {
    const rpm = safe('rpm', ['-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n'], 30000);
    for (const line of (rpm ?? '').split('\n')) {
      const [name, version, publisher] = line.split('\t');
      if (!name) continue;
      software.push({
        name: truncate(name),
        version: truncate(version, 100),
        publisher: truncate(publisher, 200),
      });
      if (software.length >= 300) break;
    }
  }

  const productName = readText('/sys/class/dmi/id/product_name');
  const manufacturer = readText('/sys/class/dmi/id/sys_vendor');
  const serial = readText('/sys/class/dmi/id/product_serial');
  const assetNo = readText('/sys/class/dmi/id/board_asset_tag') ?? process.env.AIHD_ASSET_NO;
  const batteryCapacity = readText('/sys/class/power_supply/BAT0/capacity');
  const batteryStatus = readText('/sys/class/power_supply/BAT0/status');
  const spooler = safe('systemctl', ['is-active', 'cups'], 5000) ?? 'unknown';
  const printersRaw = safe('lpstat', ['-p'], 10000) ?? '';
  const printers = printersRaw
    .split('\n')
    .map((line) => line.match(/^printer\s+(\S+)/i)?.[1])
    .filter((value) => Boolean(value))
    .slice(0, 50)
    .map((name) => ({ name, status: 'unknown', jobs: 0 }));
  const printQueue = (safe('lpstat', ['-o'], 10000) ?? '').split('\n').filter(Boolean).length;
  if (printers[0]) printers[0].jobs = printQueue;
  const audioLine = safe('aplay', ['-l'], 10000);
  const audioCards = audioLine ? (audioLine.match(/^card\s+\d+/gm) ?? []).length : 0;
  const defaultSink = safe('pactl', ['get-default-sink'], 5000);
  const usbCount = (safe('lsusb', [], 10000) ?? '').split('\n').filter(Boolean).length;
  const luks = safe('lsblk', ['-o', 'NAME,FSTYPE', '-n'], 10000) ?? '';
  const encrypted = /crypto_LUKS/i.test(luks);
  const clam = safe('systemctl', ['is-active', 'clamav-daemon'], 5000);
  const aptUpgradable = safe(
    'bash',
    ['-lc', 'apt list --upgradable 2>/dev/null | tail -n +2 | wc -l'],
    20000,
  );
  const recentErrors = safe(
    'bash',
    ['-lc', 'journalctl -p 3 -S -24h --no-pager 2>/dev/null | wc -l'],
    20000,
  );
  const sharedMounts = safe('findmnt', ['-t', 'cifs,nfs,nfs4', '-n', '-o', 'TARGET'], 10000);

  return {
    os: linuxOsName(),
    platform: 'Linux',
    arch: os.arch(),
    hardware: {
      assetNo: truncate(assetNo, 100),
      serial: truncate(serial, 200),
      model: truncate(productName, 200),
      manufacturer: truncate(manufacturer, 200),
      cpu: {
        model: truncate(os.cpus()[0]?.model, 300),
        cores: os.cpus().length,
        logicalCores: os.cpus().length,
        speedMHz: os.cpus()[0]?.speed,
        usagePercent:
          os.loadavg()[0] !== undefined && os.cpus().length > 0
            ? Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100))
            : undefined,
      },
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        usagePercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      },
      disks,
      gpu: gpus,
      network: { adapters: adapters.slice(0, 80), ipv4: ipv4.slice(0, 30), online: true },
      battery:
        batteryCapacity !== null
          ? {
              levelPercent: numberOrUndefined(batteryCapacity),
              charging: /charging/i.test(batteryStatus ?? ''),
            }
          : undefined,
      mediaDevices: { audioOutput: audioCards },
      printers,
      printSpooler: spooler === 'active' ? '実行中' : spooler === 'inactive' ? '停止' : undefined,
      audioOutput: truncate(defaultSink, 200),
      usbDevices: Math.min(1000, usbCount),
      uptimeSeconds: os.uptime(),
      sharedFolder: sharedMounts
        ? { path: truncate(sharedMounts.split('\n')[0], 500), accessible: true }
        : undefined,
    },
    software,
    security: {
      antivirus:
        clam === 'active'
          ? { enabled: true, name: 'ClamAV' }
          : clam
            ? { enabled: false, name: 'ClamAV 未起動' }
            : undefined,
      diskEncryption: { enabled: encrypted, detail: encrypted ? 'LUKS' : 'LUKS 未検出' },
      windowsUpdate:
        aptUpgradable !== null ? { pending: numberOrUndefined(aptUpgradable) } : undefined,
      recentErrors: recentErrors !== null ? numberOrUndefined(recentErrors) : undefined,
    },
  };
}

function macosCollect() {
  const hardware = parseJson(safe('system_profiler', ['SPHardwareDataType', '-json'], 30000))
    ?.SPHardwareDataType?.[0];
  const softwareNames = (safe('ls', ['/Applications'], 10000) ?? '')
    .split('\n')
    .filter((name) => name.endsWith('.app'))
    .map((name) => ({ name: name.replace(/\.app$/, '') }));
  const df = safe('df', ['-k'], 10000) ?? '';
  const disks = [];
  for (const line of df.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const totalBytes = numberOrUndefined(parts[1]) * 1024;
    const freeBytes = numberOrUndefined(parts[3]) * 1024;
    if (totalBytes === undefined) continue;
    disks.push({ name: parts[0], mount: parts.slice(8).join(' '), totalBytes, freeBytes });
    if (disks.length >= 10) break;
  }
  const battery = safe('pmset', ['-g', 'batt'], 5000);
  const batteryPercent = battery?.match(/(\d+)%/)?.[1];
  const filevault = safe('fdesetup', ['status'], 10000);
  const audio = safe('system_profiler', ['SPAudioDataType', '-json'], 20000);
  const audioCount = audio ? (audio.match(/"name"\s*:/g) ?? []).length : 0;
  const spooler = safe('launchctl', ['list', 'org.cups.cupsd'], 5000);
  const printersRaw = safe('lpstat', ['-p'], 10000) ?? '';
  const printers = printersRaw
    .split('\n')
    .map((line) => line.match(/^printer\s+(\S+)/i)?.[1])
    .filter((value) => Boolean(value))
    .slice(0, 50)
    .map((name) => ({ name, status: 'unknown', jobs: 0 }));

  return {
    os: `${safe('sw_vers', ['-productName'], 5000) ?? 'macOS'} ${safe('sw_vers', ['-productVersion'], 5000) ?? ''}`.trim(),
    platform: 'macOS',
    arch: os.arch(),
    hardware: {
      serial: truncate(hardware?.['Serial Number (system)'], 200),
      model: truncate(hardware?.['Model Name'], 200),
      manufacturer: 'Apple',
      cpu: {
        model: truncate(hardware?.Chip ?? hardware?.['Processor Name'], 300),
        logicalCores: numberOrUndefined(hardware?.['Total Number of Cores']),
        usagePercent:
          os.loadavg()[0] !== undefined && os.cpus().length > 0
            ? Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100))
            : undefined,
      },
      memory: {
        totalBytes: os.totalmem(),
        freeBytes: os.freemem(),
        usagePercent: Math.round((1 - os.freemem() / os.totalmem()) * 100),
      },
      disks,
      network: { online: true },
      battery: batteryPercent
        ? { levelPercent: numberOrUndefined(batteryPercent), charging: /AC/i.test(battery ?? '') }
        : undefined,
      mediaDevices: { audioOutput: audioCount },
      printers,
      printSpooler: spooler ? '実行中' : undefined,
      uptimeSeconds: os.uptime(),
    },
    software: softwareNames,
    security: {
      diskEncryption: filevault
        ? { enabled: /On/i.test(filevault), detail: 'FileVault' }
        : undefined,
    },
  };
}

async function collect() {
  const kind = platformKind();
  const base =
    kind === 'windows' ? windowsCollect() : kind === 'macos' ? macosCollect() : linuxCollect();
  return {
    deviceId: String(deviceId),
    hostname: os.hostname(),
    os: base.os,
    platform: base.platform ?? process.platform,
    arch: base.arch ?? os.arch(),
    hardware: base.hardware ?? {},
    software: asArray(base.software).slice(0, 300),
    security: base.security ?? {},
    ...(browserDeviceId ? { browserDeviceId: String(browserDeviceId) } : {}),
    collectedAt: new Date().toISOString(),
  };
}

async function post(payload) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Token': deviceToken,
    'X-AIHD-Agent-Version': '1.0.0',
  };
  if (config.cfAccessClientId && config.cfAccessClientSecret) {
    headers['CF-Access-Client-Id'] = config.cfAccessClientId;
    headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
  }
  if (config.proxySecret) headers['X-Proxy-Secret'] = config.proxySecret;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    const hint =
      response.status === 301 || response.status === 302
        ? 'Cloudflare Access に拒否されました（サービスドメイン設定を確認してください）。'
        : 'API が受け付けませんでした。';
    throw new Error(`HTTP ${response.status} ${hint} ${text.slice(0, 200)}`);
  }
  return parseJson(text);
}

function summary(payload) {
  return [
    `host=${payload.hostname}`,
    `os=${payload.os}`,
    `cpu_cores=${payload.hardware.cpu?.logicalCores ?? '?'}`,
    `memory_gb=${gb(payload.hardware.memory?.totalBytes) ?? '?'}`,
    `disks=${payload.hardware.disks?.length ?? 0}`,
    `software=${payload.software.length}`,
    `printers=${payload.hardware.printers?.length ?? 0}`,
    `antivirus=${payload.security.antivirus?.enabled ?? 'unknown'}`,
  ].join(' ');
}

async function runOnce() {
  const payload = await collect();
  if (dryRun) {
    console.log(`[agent] dry-run ${summary(payload)}`);
    if (printJson) console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const result = await post(payload);
  console.log(
    `[agent] posted ${summary(payload)} linked=${result?.linked ?? '?'} snapshot_items=${result?.snapshot?.items?.length ?? '?'}`,
  );
}

try {
  await runOnce();
  if (watch) {
    const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
    console.log(`[agent] watch every ${Math.max(5, intervalMinutes)} min`);
    setInterval(() => {
      runOnce().catch((error) => console.error(`[agent] ${error.message}`));
    }, intervalMs);
  }
} catch (error) {
  console.error(`[agent] ${error.message}`);
  process.exitCode = 1;
}
