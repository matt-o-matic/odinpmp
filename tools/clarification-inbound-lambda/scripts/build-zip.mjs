import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import archiver from 'archiver';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const distRoot = path.join(packageRoot, 'dist');
const stagingRoot = path.join(distRoot, 'package');
const zipPath = path.join(distRoot, 'clarification-inbound-lambda.zip');

function npmCommand() {
  return 'npm';
}

async function copyIntoStaging() {
  await fs.cp(path.join(packageRoot, 'src'), path.join(stagingRoot, 'src'), { recursive: true });
  await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(stagingRoot, 'package.json'));
}

function run(command, args, cwd) {
  const result = spawnSync([command, ...args].join(' '), {
    cwd,
    shell: true,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status ?? 1}.`);
  }
}

async function createZipArchive() {
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(stagingRoot, false);
    archive.finalize();
  });
}

async function main() {
  await fs.rm(distRoot, { force: true, recursive: true });
  await fs.mkdir(stagingRoot, { recursive: true });
  await copyIntoStaging();
  run(npmCommand(), ['install', '--omit=dev', '--package-lock=false'], stagingRoot);
  await createZipArchive();
  console.log(`Built ${zipPath}`);
}

main().catch((error) => {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
});
