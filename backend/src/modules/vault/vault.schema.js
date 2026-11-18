import { z } from 'zod';

// A channel is a file target too: its library.
const targetTypeSchema = z.enum(['project', 'epic', 'story', 'task', 'ticket', 'clarification', 'channel']);
const folderIdSchema = z.string().trim().min(1).max(36).nullable().optional();

export const fileQuerySchema = z.object({
  targetId: z.string().trim().min(1).max(120),
  targetType: targetTypeSchema,
});

export const fileUploadSchema = fileQuerySchema.extend({
  fileContentsBase64: z.string().trim().min(1).max(20_000_000),
  fileDescription: z.preprocess((value) => value ?? '', z.string().trim().max(1000)).optional().default(''),
  fileName: z.string().trim().min(1).max(240),
  fileType: z.string().trim().min(1).max(120),
  // A folder in a channel library; the library's top level without one.
  folderId: folderIdSchema,
  inlineImage: z.boolean().optional().default(false),
  // An upload that must not save over someone's file: refused (409) if the name is taken, or if
  // the file under it no longer has the contents' signature (MD5) the uploader expects to replace.
  createOnly: z.boolean().optional(),
  expectedSignature: z.string().trim().min(1).max(128).nullable().optional(),
});

// What a link can point at: a work item. The project needs no link, as the vault lists every file
// in it, and a requirements topic reaches stakeholders outside the team.
export const fileLinkSchema = z.object({
  targetId: z.string().trim().min(1).max(120),
  targetType: z.enum(['epic', 'story', 'task', 'ticket']),
});

const nullableNote = z.preprocess((value) => value ?? '', z.string().trim().max(1000)).optional().default('');

// Who may see a file: the team only (internal), or the project's stakeholders too (external).
export const fileAudienceSchema = z.object({
  audience: z.enum(['internal', 'external']),
}).strict();

// A new version of a file. Its name and type stay as they are unless given; expectedVersion is the
// version the uploader saw, so a version someone else added meanwhile is never saved over.
export const fileVersionUploadSchema = z.object({
  // Uploading over someone else's editing marker needs this.
  confirmEditing: z.boolean().optional(),
  expectedVersion: z.number().int().min(1),
  fileContentsBase64: z.string().trim().min(1).max(20_000_000),
  fileDescription: z.string().trim().max(1000).optional(),
  fileName: z.string().trim().min(1).max(240).optional(),
  fileType: z.string().trim().min(1).max(120).optional(),
  note: nullableNote,
});

export const fileVersionRestoreSchema = z.object({
  expectedVersion: z.number().int().min(1),
});

const versionNumber = z.coerce.number().int().min(1).optional();

export const fileVersionParamSchema = z.object({ version: z.coerce.number().int().min(1) });

export const fileContentQuerySchema = z.object({
  download: z.enum(['0', '1']).optional(),
  version: versionNumber,
});

// Up to MAX_INLINE_DOWNLOAD_BYTES come back in the reply when inline=1, for tools.
export const fileDownloadQuerySchema = z.object({
  inline: z.enum(['0', '1']).optional(),
  version: versionNumber,
});

// A large upload. A new file names its target; a new version names its file and the
// version it was made from. The size limit is the server's (FILE_UPLOAD_MAX_BYTES),
// checked by the service, not here.
export const fileUploadStartSchema = z.object({
  // Uploading over someone else's editing marker needs this.
  confirmEditing: z.boolean().optional(),
  contentType: z.preprocess((value) => value || 'application/octet-stream', z.string().trim().min(1).max(120)),
  expectedVersion: z.number().int().min(1).optional(),
  fileId: z.string().trim().min(1).max(36).optional(),
  fileName: z.string().trim().min(1).max(240),
  fileSize: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  // A folder in a channel library, for a new file. A new version stays in its file's folder.
  folderId: folderIdSchema,
  targetId: z.string().trim().min(1).max(120).optional(),
  targetType: targetTypeSchema.optional(),
}).strict().refine((value) => !value.fileId || value.expectedVersion != null, { message: 'A new version needs the version it was made from (expectedVersion).', path: ['expectedVersion'] });

export const fileUploadPartsSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100),
}).strict();

// keepBoth saves an upload that lost a version race as a new file; expectedVersion saves it on
// top of the newer version instead.
export const fileUploadCompleteSchema = z.object({
  expectedVersion: z.number().int().min(1).optional(),
  fileDescription: z.string().trim().max(1000).optional(),
  keepBoth: z.boolean().optional(),
  note: nullableNote,
}).strict();

export const fileDownloadUrlQuerySchema = z.object({
  agentView: z.enum(['0', '1']).optional(),
  disposition: z.enum(['attachment', 'inline']).optional(),
  version: versionNumber,
});

export const filePreviewUrlQuerySchema = z.object({
  agentView: z.enum(['0', '1']).optional(),
  version: versionNumber,
});

// agentView=1 narrows a read to what agents may see. The MCP file tools always send it.
export const agentViewQuerySchema = z.object({
  agentView: z.enum(['0', '1']).optional(),
});

// A window of a text file, in characters, so a long file is read a page at a time.
export const FILE_TEXT_MAX_CHARS = 50_000;
export const fileTextQuerySchema = z.object({
  maxChars: z.coerce.number().int().min(1).max(FILE_TEXT_MAX_CHARS).default(20_000),
  offset: z.coerce.number().int().min(0).max(100_000_000).default(0),
  version: versionNumber,
});
