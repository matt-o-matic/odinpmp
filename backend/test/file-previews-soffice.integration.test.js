import assert from 'node:assert/strict';
import test from 'node:test';

import { NO_PREVIEW, previewStorageKeyFor } from '../src/lib/files/file-preview.js';
import { createSofficeConverter, findExecutable } from '../src/lib/files/soffice-converter.js';
import { createInMemoryAuthRepository } from '../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import { createFilePreviewProcessor } from '../src/modules/vault/file-preview-worker.js';
import { createMemoryLargeFileStorage } from './helpers/large-file-fixtures.js';
import { corruptOfficeFile, sampleDocx, samplePptx, sampleXlsx } from './helpers/office-samples.js';

// File previews with real LibreOffice: a .docx, .xlsx and .pptx built in the test each convert to a PDF,
// and a corrupt .docx gets no preview. Skipped unless soffice (or PREVIEW_SOFFICE_PATH) is
// installed. Without it on the machine, run it in a container that has it:
//
//   docker build -t odin-preview-soffice:local - <<'EOF'
//   FROM node:24-bookworm-slim
//   RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-dejavu-core
//   EOF
//   docker run --rm --network none -v "$PWD:/repo" -w /repo/backend odin-preview-soffice:local node --test test/file-previews-soffice.integration.test.js

const sofficePath = process.env.PREVIEW_SOFFICE_PATH || 'soffice';
const installed = Boolean(await findExecutable(sofficePath));
const TENANT_ID = 'tenant-acme';
const PROJECT = 'project-1';

const SAMPLES = [
  { build: () => sampleDocx('Quarterly report'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'report.docx' },
  { build: () => sampleXlsx('Budget'), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: 'budget.xlsx' },
  { build: () => samplePptx('Kickoff'), contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileName: 'kickoff.pptx' },
  { build: async () => corruptOfficeFile(), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', corrupt: true, fileName: 'corrupt.docx' },
];

test('LibreOffice converts a .docx, .xlsx and .pptx to PDF previews, and a corrupt .docx gets none', { skip: !installed && `${sofficePath} is not installed`, timeout: 300_000 }, async () => {
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.example'], id: TENANT_ID, name: 'Acme' }],
    users: [{ authMethod: 'basic', email: 'ada@acme.example', id: 'user-ada', memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: 'Ada', password: 'Fixture-password-123!' }],
  });
  const storage = createMemoryLargeFileStorage();
  const projectRepository = createInMemoryProjectsRepository({ authRepository, fileStorage: storage, seed: { projects: [{ epics: [], id: PROJECT, name: 'One', status: 'In Progress', tenantId: TENANT_ID }] } });
  const user = { id: 'user-ada', memberships: [{ role: 'admin', tenantId: TENANT_ID }], name: 'Ada' };
  const saved = [];
  for (const sample of SAMPLES) {
    const bytes = await sample.build();
    const file = await projectRepository.saveFile({ fileContentsBase64: bytes.toString('base64'), fileName: sample.fileName, fileType: sample.contentType, projectId: PROJECT, targetId: PROJECT, targetType: 'project', tenantId: TENANT_ID, user });
    const row = projectRepository.state.files.find((entry) => entry.id === file.id);
    saved.push({ ...sample, storageKey: row.storageKey ?? row.id });
  }
  const converter = createSofficeConverter({ sofficePath, timeoutMs: 120_000 });
  const logged = [];
  const processor = createFilePreviewProcessor({ converter, log: (message) => logged.push(message), projectRepository, storage });
  const results = Object.fromEntries((await processor.processBatch({ limit: 10 })).map((entry) => [entry.storageKey, entry]));
  console.log(`isolated in a network namespace: ${await converter.isolated()}`);
  for (const sample of saved) {
    const result = results[sample.storageKey];
    const row = projectRepository.state.files.find((entry) => (entry.storageKey ?? entry.id) === sample.storageKey);
    if (sample.corrupt) {
      assert.equal(result?.status, 'failed', `${sample.fileName}: ${JSON.stringify(result)}`);
      assert.equal(row.previewStorageKey, NO_PREVIEW);
      continue;
    }
    assert.equal(result?.status, 'ready', `${sample.fileName}: ${JSON.stringify(result)}`);
    const pdf = storage.objects.get(previewStorageKeyFor(sample.storageKey));
    assert.ok(pdf, `${sample.fileName} has a PDF`);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', `${sample.fileName} is a PDF`);
    assert.ok(pdf.length > 500, `${sample.fileName}: ${pdf.length} bytes`);
    assert.equal(row.previewStorageKey, previewStorageKeyFor(sample.storageKey));
    console.log(`${sample.fileName}: ${pdf.length}-byte PDF`);
  }
});

test('a conversion that runs out of time is stopped with every LibreOffice process it started', { skip: (!installed && `${sofficePath} is not installed`) || (process.platform !== 'linux' && 'reads /proc'), timeout: 60_000 }, async () => {
  const { mkdtemp, readdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const running = async () => {
    const found = [];
    for (const pid of (await readdir('/proc')).filter((name) => /^\d+$/.test(name))) {
      const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      // LibreOffice's own processes, not this test (whose name has soffice in it).
      if (/libreoffice|soffice\.bin|oosplash/.test(command)) found.push(`${pid} ${command.replaceAll('\0', ' ')}`);
    }
    return found;
  };
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'odin-soffice-timeout-'));
  try {
    const inputPath = path.join(workDir, 'source.docx');
    await writeFile(inputPath, await sampleDocx('Too slow'));
    const converter = createSofficeConverter({ sofficePath, timeoutMs: 300 });
    await assert.rejects(converter.convert({ inputPath, workDir }), { code: 'conversion_timeout' });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(await running(), [], 'no soffice process is left');
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
});
