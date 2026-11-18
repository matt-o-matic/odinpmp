import { pipeline } from 'node:stream/promises';

import { Router } from 'express';

import { createAuthMiddleware } from '../../lib/http/auth-middleware.js';
import {
  deleteFileForUser,
  downloadFileForUser,
  fileContentDisposition,
  getFileContentForUser,
  linkFileForUser,
  listFileVersionsForUser,
  listFilesForUser,
  readFileTextForUser,
  restoreFileVersionForUser,
  setFileAudienceForUser,
  unlinkFileForUser,
  uploadFileForUser,
  uploadFileVersionForUser,
} from './vault.service.js';
import {
  cancelUploadForUser,
  completeUploadForUser,
  deleteFileVersionForUser,
  getDownloadUrlForUser,
  getFileStorageForUser,
  getUploadForUser,
  signUploadPartsForUser,
  startUploadForUser,
} from './large-files.service.js';
import { getPreviewUrlForUser } from './file-preview.service.js';
import { viewFileForUser } from './file-view.service.js';
import {
  agentViewQuerySchema,
  fileAudienceSchema,
  fileContentQuerySchema,
  fileDownloadQuerySchema,
  fileDownloadUrlQuerySchema,
  filePreviewUrlQuerySchema,
  fileUploadCompleteSchema,
  fileUploadPartsSchema,
  fileUploadStartSchema,
  fileLinkSchema,
  fileQuerySchema,
  fileTextQuerySchema,
  fileUploadSchema,
  fileVersionParamSchema,
  fileVersionRestoreSchema,
  fileVersionUploadSchema,
} from './vault.schema.js';

// Agents' reads leave out files on tickets they may not see: those the tools ask for with
// agentView=1, and every request on an MCP credential.
const agentViewOf = (request) => agentViewQuerySchema.parse(request.query).agentView === '1' || request.auth.credentialSource === 'mcp';

// Streams the contents when they come as a stream, so a large file is never held in memory.
async function sendFileContent(response, asset, { download = false } = {}) {
  response.setHeader('Content-Type', asset.contentType);
  response.setHeader('Content-Length', String(asset.size));
  response.setHeader('Content-Disposition', fileContentDisposition(asset.file?.fileName, { contentType: asset.contentType, download }));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'private, max-age=60');
  if (!asset.stream) {
    response.status(200).send(asset.bytes);
    return;
  }
  response.status(200);
  await pipeline(asset.stream, response);
}

export function largeFileDeps(deps) {
  return {
    backendPublicUrl: deps.fileTransferPublicUrl ?? '',
    clock: deps.fileClock,
    complianceRepository: deps.complianceRepository,
    filePreviews: deps.filePreviews ?? null,
    fileStorage: deps.fileStorage,
    fileUploadMaxBytes: deps.fileUploadMaxBytes,
    previewMaxBytes: deps.previewMaxBytes,
    projectRepository: deps.projectRepository,
    signingRepository: deps.signingRepository,
    transferSigner: deps.fileTransferSigner,
  };
}

export function createVaultRouter(deps) {
  const {
    authRepository,
    complianceRepository,
    frontendAppUrl = 'http://localhost:5173/app',
    projectRepository,
    signingRepository = null,
    tokenService,
  } = deps;
  const large = largeFileDeps(deps);
  const router = Router();
  // MCP credentials reach only the file routes backend/src/mcp/access/files.js admits.
  const requireAuth = createAuthMiddleware({ allowMcp: true, authRepository, tokenService });

  router.get('/api/projects/:projectId/files', requireAuth, async (request, response, next) => {
    try {
      const payload = fileQuerySchema.parse(request.query);
      const result = await listFilesForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
        { agentView: agentViewOf(request) },
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/projects/:projectId/files', requireAuth, async (request, response, next) => {
    try {
      const payload = fileUploadSchema.parse(request.body);
      const result = await uploadFileForUser(
        request.auth.user,
        request.params.projectId,
        payload,
        projectRepository,
        complianceRepository,
        { agentView: agentViewOf(request) },
      );
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  // The project-scoped read and delete serve MCP grants limited to some projects, which can
  // only be held to them when the request names its project.
  router.get('/api/projects/:projectId/files/:fileId/text', requireAuth, async (request, response, next) => {
    try {
      const result = await readFileTextForUser(
        request.auth.user,
        request.params.projectId,
        request.params.fileId,
        fileTextQuerySchema.parse(request.query),
        projectRepository,
        { agentView: agentViewOf(request) },
      );
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/projects/:projectId/files/:fileId/download', requireAuth, async (request, response, next) => {
    try {
      const result = await downloadFileForUser(
        request.auth.user,
        request.params.projectId,
        request.params.fileId,
        fileDownloadQuerySchema.parse(request.query),
        projectRepository,
        { agentView: agentViewOf(request), frontendAppUrl },
      );
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // An image or PDF for the model to look at (odin_view_project_file): agents only.
  router.get('/api/projects/:projectId/files/:fileId/view', requireAuth, async (request, response, next) => {
    try {
      const result = await viewFileForUser(request.auth.user, request.params.projectId, request.params.fileId, fileDownloadQuerySchema.pick({ version: true }).parse(request.query), projectRepository, { agentView: agentViewOf(request) });
      response.setHeader('Cache-Control', 'no-store');
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/projects/:projectId/files/:fileId/versions', requireAuth, async (request, response, next) => {
    try {
      const result = await listFileVersionsForUser(request.auth.user, request.params.projectId, request.params.fileId, projectRepository, { agentView: agentViewOf(request) });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/projects/:projectId/files/:fileId/versions', requireAuth, async (request, response, next) => {
    try {
      const result = await uploadFileVersionForUser(
        request.auth.user,
        request.params.projectId,
        request.params.fileId,
        fileVersionUploadSchema.parse(request.body),
        projectRepository,
        complianceRepository,
        { agentView: agentViewOf(request) },
      );
      response.status(result.unchanged ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/projects/:projectId/files/:fileId/versions/:version/restore', requireAuth, async (request, response, next) => {
    try {
      const { version } = fileVersionParamSchema.parse(request.params);
      const result = await restoreFileVersionForUser(
        request.auth.user,
        request.params.projectId,
        request.params.fileId,
        version,
        fileVersionRestoreSchema.parse(request.body),
        projectRepository,
        complianceRepository,
        { agentView: agentViewOf(request) },
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.patch('/api/projects/:projectId/files/:fileId/audience', requireAuth, async (request, response, next) => {
    try {
      const result = await setFileAudienceForUser(request.auth.user, request.params.projectId, request.params.fileId, fileAudienceSchema.parse(request.body), projectRepository, { agentView: agentViewOf(request), signingRepository });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/projects/:projectId/files/:fileId/links', requireAuth, async (request, response, next) => {
    try {
      const result = await linkFileForUser(request.auth.user, request.params.projectId, request.params.fileId, fileLinkSchema.parse(request.body), projectRepository, { agentView: agentViewOf(request) });
      response.status(result.linked ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/api/projects/:projectId/files/:fileId/links/:linkId', requireAuth, async (request, response, next) => {
    try {
      const result = await unlinkFileForUser(request.auth.user, request.params.projectId, request.params.fileId, request.params.linkId, projectRepository, { agentView: agentViewOf(request) });
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/api/projects/:projectId/files/:fileId', requireAuth, async (request, response, next) => {
    try {
      const result = await deleteFileForUser(
        request.auth.user,
        request.params.fileId,
        projectRepository,
        complianceRepository,
        { agentView: agentViewOf(request), projectId: request.params.projectId, signingRepository },
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/api/files/:fileId', requireAuth, async (request, response, next) => {
    try {
      const result = await deleteFileForUser(
        request.auth.user,
        request.params.fileId,
        projectRepository,
        complianceRepository,
        { signingRepository },
      );
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/files/:fileId/content', requireAuth, async (request, response, next) => {
    try {
      const { download, version } = fileContentQuerySchema.parse(request.query);
      const asset = await getFileContentForUser(
        request.auth.user,
        request.params.fileId,
        projectRepository,
        { version: version ?? null },
      );
      await sendFileContent(response, asset, { download: download === '1' });
    } catch (error) {
      if (response.headersSent) response.destroy(error);
      else next(error);
    }
  });

  // Large files: uploads in parts, signed downloads, old versions and
  // storage used. Members only: MCP credentials reach none of these yet.
  const send = (status, run) => async (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      response.status(status).json(await run(request));
    } catch (error) {
      next(error);
    }
  };
  router.post('/api/projects/:projectId/uploads', requireAuth, send(201, (request) => startUploadForUser(large, request.auth.user, request.params.projectId, fileUploadStartSchema.parse(request.body ?? {}))));
  router.get('/api/projects/:projectId/uploads/:uploadId', requireAuth, send(200, (request) => getUploadForUser(large, request.auth.user, request.params.projectId, request.params.uploadId)));
  router.post('/api/projects/:projectId/uploads/:uploadId/parts', requireAuth, send(200, (request) => signUploadPartsForUser(large, request.auth.user, request.params.projectId, request.params.uploadId, fileUploadPartsSchema.parse(request.body ?? {}))));
  router.post('/api/projects/:projectId/uploads/:uploadId/complete', requireAuth, send(201, (request) => completeUploadForUser(large, request.auth.user, request.params.projectId, request.params.uploadId, fileUploadCompleteSchema.parse(request.body ?? {}))));
  router.delete('/api/projects/:projectId/uploads/:uploadId', requireAuth, send(200, (request) => cancelUploadForUser(large, request.auth.user, request.params.projectId, request.params.uploadId)));
  router.get('/api/projects/:projectId/files/:fileId/download-url', requireAuth, send(200, (request) => {
    const query = fileDownloadUrlQuerySchema.parse(request.query);
    return getDownloadUrlForUser(large, request.auth.user, request.params.projectId, request.params.fileId, { inline: query.disposition === 'inline', version: query.version ?? null }, { agentView: agentViewOf(request) });
  }));
  // What the files panel's viewer shows (file-preview.service.js), with the rights of a download.
  router.get('/api/projects/:projectId/files/:fileId/preview-url', requireAuth, send(200, (request) => {
    const query = filePreviewUrlQuerySchema.parse(request.query);
    return getPreviewUrlForUser(large, request.auth.user, request.params.projectId, request.params.fileId, { version: query.version ?? null }, { agentView: agentViewOf(request) });
  }));
  router.delete('/api/projects/:projectId/files/:fileId/versions/:version', requireAuth, send(200, (request) => {
    const { version } = fileVersionParamSchema.parse(request.params);
    return deleteFileVersionForUser(large, request.auth.user, request.params.projectId, request.params.fileId, version);
  }));
  router.get('/api/projects/:projectId/file-storage', requireAuth, send(200, (request) => getFileStorageForUser(large, request.auth.user, request.params.projectId)));

  return router;
}
