import express, { Router } from 'express';
import { z } from 'zod';

import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../../lib/auth/project-capabilities.js';
import { HttpError } from '../../../lib/errors/http-error.js';
import { getRequestIp } from '../../../lib/http/request-meta.js';
import { createRequirementsPublicRateLimiter } from '../requirements-rate-limit.js';
import { REVIEW_TRACK } from '../requirements.repository.js';
import { trackSchema } from '../requirements.schema.js';
import {
  checkReplaceableForUser,
  createUploadUrlForUser,
  DEFAULT_REVIEW_PACKAGE_MAX_BYTES,
  findPendingUpload,
  getPackageForUser,
  getPackageGrantForUser,
  getUploadStatusForUser,
  hashUploadToken,
  listPackagesForUser,
  replacePackageForUser,
  uploadPackageForUser,
  uploadPackageWithToken,
  withdrawPackageForUser,
} from './packages.service.js';
import { getPackageKit, PACKAGE_KIT_FILENAME } from './package-kit.js';

const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];

export function packageServiceDeps(deps) {
  return {
    authRepository: deps.authRepository,
    backendPublicUrl: deps.backendPublicUrl,
    clock: deps.requirementsClock,
    fileScanner: deps.fileScanner,
    liveEventBus: deps.liveEventBus,
    mermaidValidator: deps.mermaidValidator,
    packageStorage: deps.packageStorage,
    packagesRepository: deps.packagesRepository,
    projectRepository: deps.projectRepository,
    requirementsRepository: deps.requirementsRepository,
    reviewGrantSecret: deps.reviewGrantSecret,
    reviewPackageMaxBytes: deps.reviewPackageMaxBytes,
    reviewPublicUrl: deps.reviewPublicUrl,
  };
}

function handle(run, status = 200) {
  return async (request, response, next) => {
    try {
      response.status(status).json(await run(request, response));
    } catch (error) {
      next(error);
    }
  };
}

function rejection(errors, warnings = [], extra = {}) {
  return { ok: false, ...extra, errors, status: 'rejected', warnings };
}

/**
 * Raw zip body with its own limit, so the 1 MB JSON limit does not apply. An oversized
 * body is a validation result (zip_limit) in the spec's shape, not a bare 413.
 */
function rawZipBody(limit) {
  const parse = express.raw({ limit, type: ZIP_TYPES });
  return (request, response, next) => {
    parse(request, response, (error) => {
      if (error?.type === 'entity.too.large' || error?.statusCode === 413) {
        response.status(422).json(rejection([{
          code: 'zip_limit',
          file: '',
          message: `The zip is larger than the ${limit}-byte limit.`,
          path: '',
        }]));
        return;
      }
      if (error) {
        next(error);
        return;
      }
      if (!Buffer.isBuffer(request.body)) {
        next(new HttpError(415, 'Send the package as a raw application/zip body.'));
        return;
      }
      next();
    });
  };
}

/**
 * Review is project-wide, so every package goes to REVIEW_TRACK. A track in the request is
 * still accepted, for older clients and agent kits, and ignored once it is valid.
 */
function reviewTrack(request) {
  const value = request.query?.track ?? request.body?.track;
  if (value !== undefined && value !== '' && !trackSchema.safeParse(value).success) {
    throw new HttpError(400, 'Unknown track. Review packages are project-wide; leave the track out.');
  }
  return REVIEW_TRACK;
}

const uploadUrlSchema = z.object({
  replacesPackageId: z.string().trim().min(1).max(36).optional(),
  track: trackSchema.optional(),
});

/**
 * Team routes, mounted from requirements.routes.js at
 * /api/projects/:projectId/requirements/packages after the auth middleware.
 */
export function createPackagesRouter(deps) {
  const router = Router({ mergeParams: true });
  const svc = packageServiceDeps(deps);
  const limit = Number(deps.reviewPackageMaxBytes ?? DEFAULT_REVIEW_PACKAGE_MAX_BYTES);
  const user = (request) => request.auth.user;
  const projectId = (request) => request.params.projectId;

  const requireCapability = (capability) => async (request, _response, next) => {
    try {
      await requireProjectCapability({
        capability,
        projectId: projectId(request),
        repository: deps.projectRepository,
        tenantId: request.auth.user?.memberships?.[0]?.tenantId ?? null,
        user: request.auth.user,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
  const canRead = requireCapability(PROJECT_CAPABILITIES.READ);
  const canCollaborate = requireCapability(PROJECT_CAPABILITIES.COLLABORATE);
  const checkTrack = (request, _response, next) => {
    try {
      request.packageTrack = reviewTrack(request);
      next();
    } catch (error) {
      next(error);
    }
  };

  router.post('/upload', canCollaborate, checkTrack, rawZipBody(limit), async (request, response, next) => {
    try {
      const outcome = await uploadPackageForUser(svc, {
        bytes: request.body,
        projectId: projectId(request),
        track: request.packageTrack,
        user: user(request),
      });
      if (outcome.status !== 'accepted') {
        response.status(422).json(rejection(outcome.errors, outcome.warnings));
        return;
      }
      response.status(201).json({ ok: true, package: outcome.package });
    } catch (error) {
      next(error);
    }
  });

  router.post('/upload-urls', canCollaborate, handle((request, response) => {
    // The response carries the only copy of the upload token.
    response.setHeader('Cache-Control', 'no-store');
    const input = uploadUrlSchema.parse(request.body ?? {});
    return createUploadUrlForUser(svc, {
      projectId: projectId(request),
      replacesPackageId: input.replacesPackageId ?? null,
      track: reviewTrack(request),
      user: user(request),
    });
  }, 201));

  router.get('/uploads/:uploadId', canRead, handle((request) => getUploadStatusForUser(svc, {
    projectId: projectId(request),
    uploadId: request.params.uploadId,
    user: user(request),
  })));

  router.get('/', canRead, handle((request) => listPackagesForUser(svc, {
    projectId: projectId(request),
    track: reviewTrack(request),
    user: user(request),
  })));

  // The package kit: guide, spec, schema, examples, and a validator for the agent's repo.
  router.get('/kit', canRead, async (_request, response, next) => {
    try {
      const kit = await getPackageKit();
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Disposition', `attachment; filename="${PACKAGE_KIT_FILENAME}"`);
      response.setHeader('Content-Length', String(kit.length));
      response.status(200).send(kit);
    } catch (error) {
      next(error);
    }
  });
  router.get('/:packageId', canRead, handle((request) => getPackageForUser(svc, {
    packageId: request.params.packageId,
    projectId: projectId(request),
    user: user(request),
  })));

  router.get('/:packageId/grant', canRead, handle((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    return getPackageGrantForUser(svc, {
      packageId: request.params.packageId,
      projectId: projectId(request),
      user: user(request),
    });
  }));

  // The draft must still be replaceable before the zip is read; the service checks again,
  // atomically, when it stores the replacement.
  const checkReplaceable = async (request, _response, next) => {
    try {
      await checkReplaceableForUser(svc, { packageId: request.params.packageId, projectId: projectId(request), user: user(request) });
      next();
    } catch (error) {
      next(error);
    }
  };
  router.post('/:packageId/replace', canCollaborate, checkReplaceable, rawZipBody(limit), async (request, response, next) => {
    try {
      const outcome = await replacePackageForUser(svc, {
        bytes: request.body,
        packageId: request.params.packageId,
        projectId: projectId(request),
        user: user(request),
      });
      if (outcome.status !== 'accepted') {
        response.status(422).json(rejection(outcome.errors, outcome.warnings));
        return;
      }
      response.status(201).json({ ok: true, package: outcome.package, replaced: outcome.replaced });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:packageId', canCollaborate, handle((request) => withdrawPackageForUser(svc, {
    packageId: request.params.packageId,
    projectId: projectId(request),
    user: user(request),
  })));

  return router;
}

/**
 * Public single-use upload URLs, mounted at /api/public/requirements-uploads. The token in
 * the path is the only credential; it is stored hashed and checked before the body is read.
 */
export function createPublicPackageUploadRouter(deps) {
  const router = Router();
  const svc = packageServiceDeps(deps);
  const limit = Number(deps.reviewPackageMaxBytes ?? DEFAULT_REVIEW_PACKAGE_MAX_BYTES);
  const limiter = deps.requirementsUploadRateLimiter ?? createRequirementsPublicRateLimiter();

  router.put('/:uploadToken', async (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const result = limiter.check({ ipAddress: getRequestIp(request), linkKey: hashUploadToken(request.params.uploadToken), write: true });
      if (!result.allowed) {
        response.setHeader('Retry-After', String(result.retryAfterSeconds));
        response.status(429).json({ details: { code: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds, scope: result.scope }, error: 'rate_limited', ok: false });
        return;
      }
      if (!await findPendingUpload(svc, { token: request.params.uploadToken })) {
        throw new HttpError(404, 'Upload URL not found.');
      }
      next();
    } catch (error) {
      next(error);
    }
  }, rawZipBody(limit), async (request, response, next) => {
    try {
      const outcome = await uploadPackageWithToken(svc, { bytes: request.body, token: request.params.uploadToken });
      if (outcome.state !== 'accepted') {
        response.status(422).json(rejection(outcome.errors, outcome.warnings, { state: 'rejected', uploadId: outcome.uploadId }));
        return;
      }
      response.status(201).json({ ok: true, package: outcome.package, state: 'accepted', uploadId: outcome.uploadId });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
