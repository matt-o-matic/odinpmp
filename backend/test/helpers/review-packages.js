import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

import JSZip from 'jszip';
import request from 'supertest';

import { createApp } from '../../src/app.js';
import { createTokenService } from '../../src/lib/auth/token-service.js';
import { createLiveEventBus } from '../../src/lib/events/live-event-bus.js';
import { createInMemoryAssistantRepository } from '../../src/modules/assistant/assistant.repository.js';
import { createInMemoryAuthRepository } from '../../src/modules/auth/auth.repository.js';
import { createInMemoryProjectsRepository } from '../../src/modules/projects/projects.repository.js';
import { createInMemoryObjectStorage } from '../../src/modules/requirements/packages/package-storage.js';
import { crc32 } from '../../src/modules/requirements/packages/package-zip.js';
import { createInMemoryPackagesRepository } from '../../src/modules/requirements/packages/packages.repository.js';
import { createInMemoryRequirementsRepository } from '../../src/modules/requirements/requirements.repository.js';
import { createRequirementsPublicRateLimiter } from '../../src/modules/requirements/requirements-rate-limit.js';
import { createInMemorySessionsRepository } from '../../src/modules/sessions/sessions.repository.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '../../..');
export const TENANT_ID = 'tenant-acme';
export const PROJECT_ID = 'project-pkg';
export const OTHER_PROJECT_ID = 'project-other';
export const REVIEW_PUBLIC_URL = 'http://127.0.0.1:3902';
export const GRANT_SECRET = 'test-review-grant-secret-0123456789abcdef';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable RGB PNG filled with one color. */
export function makePng(width, height, [red, green, blue] = [31, 77, 58]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + (width * 3));
  for (let x = 0; x < width; x += 1) {
    row[1 + (x * 3)] = red;
    row[2 + (x * 3)] = green;
    row[3 + (x * 3)] = blue;
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Builds a zip. `files` maps path -> string | Buffer | { content, unixPermissions, dir }.
 * Directory entries are created only when asked (dir: true), like most zip tools omit them.
 */
export async function buildZip(files, { compression = 'DEFLATE' } = {}) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(files)) {
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
      if (value.dir) {
        zip.folder(name);
        continue;
      }
      zip.file(name, value.content ?? '', {
        createFolders: false,
        date: new Date('2026-10-07T00:00:00Z'),
        unixPermissions: value.unixPermissions,
      });
      continue;
    }
    zip.file(name, value, { createFolders: false, date: new Date('2026-10-07T00:00:00Z') });
  }
  return zip.generateAsync({ compression, platform: 'UNIX', type: 'nodebuffer' });
}

export function imageScreen(id, overrides = {}) {
  return {
    alt: `Screen ${id}`,
    height: 200,
    id,
    kind: 'image',
    src: `screens/${id}.png`,
    title: `Screen ${id}`,
    width: 320,
    ...overrides,
  };
}

export function prototypeScreen(id, overrides = {}) {
  return {
    alt: `Prototype ${id}`,
    id,
    kind: 'prototype',
    src: `prototypes/${id}/index.html`,
    states: [{ key: 'start', label: 'Start' }, { key: 'done', label: 'Done' }],
    title: `Prototype ${id}`,
    viewport: { height: 800, width: 1280 },
    ...overrides,
  };
}

export function manifestWith({ sections, ...overrides } = {}) {
  return {
    schema: 'odin.review-package/v1',
    sections: sections ?? [
      { id: 'screens', items: [imageScreen('home')], type: 'screens' },
    ],
    summary: 'Round 2 tries a price range on the home screen.',
    title: 'Client booking',
    track: 'experience',
    ...overrides,
  };
}

export const PROTOTYPE_HTML = '<!doctype html>\n<html><head><meta charset="utf-8"><title>Proto</title><link rel="stylesheet" href="styles.css"></head>\n<body><h1 data-odin-id="title">Book a visit</h1><script src="app.js"></script></body></html>\n';

/** Files for a package with one image screen ("home") and one prototype ("booking"). */
export function standardFiles({ css = 'body { color: #1d2a24; }', manifest, png = makePng(320, 200) } = {}) {
  return {
    'manifest.json': JSON.stringify(manifest ?? manifestWith({
      sections: [
        { id: 'screens', items: [imageScreen('home'), prototypeScreen('booking')], type: 'screens' },
      ],
    })),
    'prototypes/booking/app.js': 'window.OdinReview && window.OdinReview.setState("start");',
    'prototypes/booking/index.html': PROTOTYPE_HTML,
    'prototypes/booking/styles.css': css,
    'screens/home.png': png,
  };
}

/** Builds an example package from tools/review-package with the repo's own build script. */
export async function buildExampleZip(name) {
  const { buildExample } = await import(pathToFileURL(path.join(REPO_ROOT, 'tools/review-package/build-examples.mjs')).href);
  const result = await buildExample(name, path.join(tmpdir(), `odin-review-package-examples-${process.pid}`));
  return readFile(result.target);
}

// ---------------------------------------------------------------------------
// API harness
// ---------------------------------------------------------------------------

export const ROLE_USERS = Object.freeze({
  member: { id: 'user-member', name: 'Mona Member', projectRole: 'member', tenantRole: 'user' },
  outsider: { id: 'user-outsider', name: 'Otto Outsider', projectRole: null, tenantRole: 'user' },
  projectManager: { id: 'user-pmanager', name: 'Pia Manager', projectRole: 'manager', tenantRole: 'user' },
  viewer: { id: 'user-viewer', name: 'Vic Viewer', projectRole: 'viewer', tenantRole: 'user' },
});

export async function createPackagesTestApp({
  clockOffsetMs = 0,
  fileScanner = undefined,
  mermaidValidator = undefined,
  reviewPackageMaxBytes = undefined,
  reviewPublicUrl = REVIEW_PUBLIC_URL,
} = {}) {
  const users = Object.values(ROLE_USERS);
  const authRepository = await createInMemoryAuthRepository({
    disableDemoUser: true,
    tenants: [{ domains: ['acme.com'], id: TENANT_ID, name: 'Acme' }],
    users: users.map((entry) => ({
      authMethod: 'basic',
      email: `${entry.id}@acme.com`,
      id: entry.id,
      memberships: [{ role: entry.tenantRole, tenantId: TENANT_ID }],
      name: entry.name,
      password: 'Secret123!',
      preferences: { twoFactorEnabled: false },
    })),
  });
  const projectRepository = createInMemoryProjectsRepository({
    authRepository,
    seed: {
      projectMemberships: {
        [OTHER_PROJECT_ID]: [{ id: ROLE_USERS.member.id, role: 'member' }],
        [PROJECT_ID]: users.filter((entry) => entry.projectRole).map((entry) => ({ id: entry.id, role: entry.projectRole })),
      },
      projects: [
        { epics: [], id: PROJECT_ID, name: 'Client booking', role: 'admin', status: 'In Progress', tenantId: TENANT_ID },
        { epics: [], id: OTHER_PROJECT_ID, name: 'Other project', role: 'admin', status: 'In Progress', tenantId: TENANT_ID },
      ],
    },
  });
  const assistantRepository = createInMemoryAssistantRepository();
  const requirementsRepository = createInMemoryRequirementsRepository({ assistantRepository });
  const packagesRepository = createInMemoryPackagesRepository({ requirementsRepository });
  const storage = createInMemoryObjectStorage();
  const liveEventBus = createLiveEventBus();
  const tokenService = createTokenService({ issuer: 'odinpmp-test', secret: 'test-secret' });
  const sessionsRepository = createInMemorySessionsRepository();
  const clock = { offsetMs: clockOffsetMs };

  const app = createApp({
    accessReviewCampaignSweepIntervalMs: 0,
    agentMonitorSweepIntervalMs: 0,
    assistantRepository,
    assistantStaleRunSweepIntervalMs: 0,
    authRepository,
    backendPublicUrl: 'http://localhost:3001',
    domainEventSweepIntervalMs: 0,
    fileScanner,
    frontendAppUrl: 'http://localhost:5173/app',
    liveEventBus,
    mermaidValidator,
    packagesRepository,
    projectRepository,
    reportSubscriptionSweepIntervalMs: 0,
    reportingWarehouseSweepIntervalMs: 0,
    requirementsClock: () => new Date(Date.now() + clock.offsetMs),
    requirementsRateLimiter: createRequirementsPublicRateLimiter({
      ip: { capacity: 10_000, refillPerSecond: 1_000 },
      link: { capacity: 10_000, refillPerSecond: 1_000 },
    }),
    requirementsRepository,
    requirementsUploadRateLimiter: createRequirementsPublicRateLimiter({
      ip: { capacity: 10_000, refillPerSecond: 1_000 },
      link: { capacity: 10_000, refillPerSecond: 1_000 },
    }),
    reviewGrantSecret: GRANT_SECRET,
    reviewPackageMaxBytes,
    reviewPackageStorage: storage,
    reviewPublicUrl,
    sessionsRepository,
    tokenService,
    webhookSweepIntervalMs: 0,
    workflowAutomationSweepIntervalMs: 0,
  });

  const tokens = {};
  for (const [key, entry] of Object.entries(ROLE_USERS)) {
    const token = tokenService.signSessionToken({
      email: `${entry.id}@acme.com`,
      id: entry.id,
      name: entry.name,
      preferences: { twoFactorEnabled: false },
      role: entry.tenantRole,
      tenantId: TENANT_ID,
    });
    const decoded = tokenService.verifySessionToken(token);
    await sessionsRepository.createSession({
      expiryDate: new Date(decoded.exp * 1000),
      ipAddr: '127.0.0.1',
      locationName: 'Localhost',
      token,
      userAgent: 'test-agent',
      userId: entry.id,
    });
    tokens[key] = token;
  }

  const base = `/api/projects/${PROJECT_ID}/requirements/packages`;
  const as = (role) => {
    const auth = (pending) => pending.set('Authorization', `Bearer ${tokens[role]}`);
    return {
      del: (route) => auth(request(app).delete(`${base}${route}`)),
      get: (route) => auth(request(app).get(`${base}${route}`)),
      post: (route, body = {}) => auth(request(app).post(`${base}${route}`)).send(body),
      upload: (bytes, track = 'experience', contentType = 'application/zip') => auth(request(app)
        .post(`${base}/upload?track=${track}`))
        .set('Content-Type', contentType)
        .send(bytes),
    };
  };

  // The fieldwork example names topics topic-exp-01 and topic-exp-03 and is based on round
  // round-exp-1. Seed them so the example validates cleanly in this project.
  async function seedExampleContext() {
    await requirementsRepository.createTopics({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      topics: [
        { id: 'topic-exp-01', prompt: 'Where should the price first appear?', topicOrigin: 'manual', track: 'experience' },
        { id: 'topic-exp-03', prompt: 'How much notice do clients need to reschedule?', topicOrigin: 'manual', track: 'experience' },
      ],
    });
    await requirementsRepository.insertRound({
      projectId: PROJECT_ID,
      round: { id: 'round-exp-1', number: 1, packageId: 'package-round-1', status: 'closed', track: 'experience' },
      tenantId: TENANT_ID,
    });
  }

  return {
    app,
    as,
    authRepository,
    clock,
    seedExampleContext,
    liveEventBus,
    packagesRepository,
    projectRepository,
    requirementsRepository,
    storage,
    tokens,
  };
}
