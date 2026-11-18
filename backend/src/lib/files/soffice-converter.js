import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_PREVIEW_TIMEOUT_MS } from './file-preview.js';

// Converts one Office file to PDF with LibreOffice (soffice --headless --convert-to pdf), in its
// own process, for the preview worker.
//
// - Each conversion gets a new profile directory (-env:UserInstallation), so conversions share no
//   state and none waits on another's lock. Macros are off and linked images from untrusted
//   places are blocked in that profile.
// - No network: on Linux the process runs in a network namespace of its own (unshare --net) when
//   the host allows unprivileged user namespaces. Everywhere, its proxy settings point at a closed
//   port and it gets no environment beyond what it needs to run, so none of the server's secrets.
// - A conversion that runs past timeoutMs is killed with its child processes.
//
// Errors carry a code: soffice_missing (no such program), conversion_timeout, conversion_failed.

const OUTPUT_LIMIT = 4096;
const CLOSED_PROXY = 'http://127.0.0.1:9';

// Written into each new profile before LibreOffice starts.
const PROFILE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`;

function conversionError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** The program a command runs, found as the shell would find it, or null. */
export async function findExecutable(command, { env = process.env, platform = process.platform } = {}) {
  const name = String(command ?? '').trim();
  if (!name) return null;
  const mode = platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK;
  const extensions = platform === 'win32' ? ['', ...String(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  const candidates = name.includes('/') || name.includes('\\')
    ? extensions.map((extension) => `${name}${extension}`)
    : String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean).flatMap((directory) => extensions.map((extension) => path.join(directory, `${name}${extension}`)));
  for (const candidate of candidates) {
    try {
      await access(candidate, mode);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

// Runs a program and resolves with its exit, or rejects on timeout. Output is kept to its tail.
function run(spawnImpl, command, args, { env, timeoutMs, platform }) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawnImpl(command, args, { detached: platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const keep = (chunk) => { output = `${output}${chunk}`.slice(-OUTPUT_LIMIT); };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const kill = () => {
      try {
        // The whole group: soffice starts soffice.bin, which would outlive its parent.
        if (platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill?.('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      kill();
      reject(conversionError('conversion_timeout', `The conversion took longer than ${timeoutMs} ms and was stopped.`, { output }));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error?.code === 'ENOENT' ? conversionError('soffice_missing', `${command} is not installed.`) : error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, signal });
    });
  });
}

/**
 * A converter that runs sofficePath. available() says, once, whether the program is there;
 * convert() turns inputPath into a PDF in workDir/out and returns its path.
 */
export function createSofficeConverter({
  env = process.env,
  platform = process.platform,
  sofficePath = 'soffice',
  spawnImpl = spawn,
  timeoutMs = DEFAULT_PREVIEW_TIMEOUT_MS,
} = {}) {
  let resolved;
  let isolation;

  async function program() {
    resolved ??= findExecutable(sofficePath, { env, platform });
    return resolved;
  }

  // Whether `unshare --net --map-root-user` works here: checked once, by running it.
  async function networkIsolation() {
    if (platform !== 'linux') return null;
    isolation ??= (async () => {
      const unshare = await findExecutable('unshare', { env, platform });
      if (!unshare) return null;
      try {
        const probe = await run(spawnImpl, unshare, ['--net', '--map-root-user', '--', 'true'], { env: { PATH: env.PATH ?? '' }, platform, timeoutMs: 5000 });
        return probe.code === 0 ? unshare : null;
      } catch {
        return null;
      }
    })();
    return isolation;
  }

  function childEnv(workDir) {
    const base = {
      HOME: workDir,
      LANG: 'C.UTF-8',
      PATH: env.PATH ?? env.Path ?? '',
      TEMP: workDir,
      TMP: workDir,
      TMPDIR: workDir,
      // Anything that does try the network meets a closed port.
      ftp_proxy: CLOSED_PROXY,
      http_proxy: CLOSED_PROXY,
      https_proxy: CLOSED_PROXY,
      FTP_PROXY: CLOSED_PROXY,
      HTTP_PROXY: CLOSED_PROXY,
      HTTPS_PROXY: CLOSED_PROXY,
      no_proxy: '',
      NO_PROXY: '',
    };
    if (platform === 'win32') {
      for (const key of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles']) {
        if (env[key]) base[key] = env[key];
      }
      base.USERPROFILE = workDir;
      base.APPDATA = workDir;
      base.LOCALAPPDATA = workDir;
    }
    return base;
  }

  return {
    /** True when the program is installed. Checked once; installing it needs a restart. */
    async available() {
      return Boolean(await program());
    },
    /** Whether conversions run without a network (true), or rely on the profile and proxies (false). */
    async isolated() {
      return Boolean(await networkIsolation());
    },
    async convert({ inputPath, workDir }) {
      const command = await program();
      if (!command) throw conversionError('soffice_missing', `${sofficePath} is not installed.`);
      const profileDir = path.join(workDir, 'profile');
      const outDir = path.join(workDir, 'out');
      await mkdir(path.join(profileDir, 'user'), { recursive: true });
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(profileDir, 'user', 'registrymodifications.xcu'), PROFILE_SETTINGS);
      const args = [
        `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
        '--headless',
        '--invisible',
        '--nocrashreport',
        '--nodefault',
        '--nofirststartwizard',
        '--nolockcheck',
        '--nologo',
        '--norestore',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        inputPath,
      ];
      const unshare = await networkIsolation();
      const [file, fileArgs] = unshare ? [unshare, ['--net', '--map-root-user', '--', command, ...args]] : [command, args];
      let result;
      try {
        result = await run(spawnImpl, file, fileArgs, { env: childEnv(workDir), platform, timeoutMs });
      } catch (error) {
        // Removed since it was found: say so from now on.
        if (error?.code === 'soffice_missing') resolved = Promise.resolve(null);
        throw error;
      }
      const pdfPath = path.join(outDir, `${path.parse(inputPath).name}.pdf`);
      // LibreOffice can exit 0 having written nothing ("source file could not be loaded").
      const written = await stat(pdfPath).catch(() => null);
      if (result.code !== 0 || !written?.size) {
        throw conversionError('conversion_failed', `LibreOffice could not convert the file (exit ${result.code ?? result.signal}).`, { output: result.output });
      }
      return { pdfPath, size: written.size };
    },
  };
}
