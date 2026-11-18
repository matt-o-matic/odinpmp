<script setup>
import { computed, nextTick, reactive, ref, useId, watch } from 'vue';

import { authSession } from '../../lib/auth/index.js';
import { useChannelApi, useChannelViewer } from '../../lib/channels/channel-api.js';
import { editingLabel } from '../../lib/channels/channels.js';
import { onProjectRefresh } from '../../lib/live/live-refresh.js';
import {
  MAX_FILE_BYTES,
  canPreviewFile,
  fileAttachments,
  fileDateLabel,
  fileErrorMessage,
  fileScanState,
  fileSizeLabel,
  fileToBase64,
  filterFiles,
  isFileReady,
  isHomeFile,
  linkableFiles,
  linkableItems,
  openFile,
  sameNamedFile,
  saveBlob,
  saveUrl,
} from '../../lib/projects/project-files.js';
import { previewKindOf } from '../../lib/projects/file-preview.js';
import { canMoveFile, guestsWillSee, moveDestinations } from '../../lib/projects/file-tree.js';
import { forgetUpload, matchPendingUpload, readPendingUploads, sendLargeUpload } from '../../lib/projects/large-upload.js';
import {
  fileUnderSignature,
  requestsForFile,
  signingErrorMessage,
  signingKindLabel,
  signingProgressLabel,
  signingStatus,
} from '../../lib/projects/project-signing.js';
import { flattenProjectItems, itemTypeMeta } from '../../lib/projects/work-item-relations.js';
import RequirementsConfirmDialog from '../requirements/RequirementsConfirmDialog.vue';
import RequirementsDialog from '../requirements/RequirementsDialog.vue';
import FileComments from '../channels/FileComments.vue';
import FilePreviewDialog from './FilePreviewDialog.vue';
import SigningRequestDetail from './signing/SigningRequestDetail.vue';
import SigningRequestDialog from './signing/SigningRequestDialog.vue';

// The app's API for members; the guest view provides the guest API (lib/channels/channel-api.js).
const api = useChannelApi();
// Set in the guest view: who is looking, and that the team's own controls stay hidden.
const viewer = useChannelViewer();

// A target's files. On the project this is the vault, every file in the project wherever it sits;
// on a work item it is the files uploaded to the item and those linked to it. A row keeps Download
// and Open in reach and opens for its versions, where it sits, and what can be done with it.
const props = defineProps({
  // A file to open and bring into view, from a link to it.
  focusFileId: { default: '', type: String },
  // A signature request to open, from a link to it (vault only).
  focusSigningId: { default: '', type: String },
  // In a channel's library: the folder shown (null for the top level). Uploads go into it.
  folderId: { default: null, type: String },
  // Moves when someone else changed this library (channel.updated, files).
  liveVersion: { default: 0, type: Number },
  projectId: { default: '', type: String },
  targetId: { default: '', type: String },
  targetType: { default: 'project', type: String },
  token: { default: '', type: String },
  // The project's top folder (ProjectFileTree.vue): the vault without the channels' files, which
  // show in their channel's folder instead.
  topLevel: { default: false, type: Boolean },
});

// changed: a file here was renamed or moved, so a folder view around it can update its counts.
const emit = defineEmits(['changed', 'navigate']);

const LIST_STEP = 50;
const PICKER_LIMIT = 50;
const uid = useId();
const headingId = `${uid}-files`;
const searchId = `${uid}-file-search`;
const fileInputId = `${uid}-file-input`;
const descriptionId = `${uid}-file-description`;
const noteId = `${uid}-file-note`;
const pickerSearchId = `${uid}-picker-search`;

const files = ref([]);
const canWrite = ref(false);
// Sending and managing signature requests needs decision rights (project admins and managers).
const canManageSigning = ref(false);
const loading = ref(false);
const errorMessage = ref('');
const statusMessage = ref('');
const query = ref('');
const shownCount = ref(LIST_STEP);
const busyFileId = ref('');
const expandedFileId = ref('');
const versions = ref([]);
const versionsLoading = ref(false);
const versionsError = ref('');
const rowElements = new Map();

// One dialog at a time: uploading or versioning a file, or picking what to link.
const dialog = reactive({ error: '', file: null, kind: '', pickerQuery: '', selectedId: '', saving: false, choices: [], choicesLoading: false });
const form = reactive({ description: '', file: null, note: '' });
const removal = reactive({ error: '', file: null, kind: '', link: null, saving: false, version: null });
// Signature requests (docs/document-signing), listed in the vault.
const requests = ref([]);
const showFinished = ref(false);
const signingCreate = reactive({ fileId: '', open: false });
const signingDetailId = ref('');
const sharing = reactive({ error: '', file: null, saving: false });
let openedSigningId = '';
// What the server allows (GET file-storage): uploads in parts up to maxUploadBytes, and the
// storage the project's files use. A server without it keeps base64 uploads up to 15 MB.
const fileStorage = reactive({ bytes: null, canDeleteVersions: false, maxUploadBytes: MAX_FILE_BYTES, uploadsByParts: false });
// The upload in the dialog: its progress, how to stop it, and a version conflict to settle.
const transfer = reactive({ conflict: null, controller: null, conflictChoice: 'keep-both', sentBytes: 0, totalBytes: 0, uploadId: '' });
// Uploads this browser started here and did not finish, to resume or discard.
const pendingUploads = ref([]);
// The file open in the viewer (FilePreviewDialog), on servers with signed links. Found by id, so
// a new version shows when the list reloads, and a deleted file closes the viewer.
const previewFileId = ref('');

const isVault = computed(() => props.targetType === 'project');
const isChannel = computed(() => props.targetType === 'channel');
// A guest's own markers carry the account their files are recorded under.
const currentUserId = computed(() => viewer?.fileActorId ?? authSession.state.currentUser?.id ?? '');
// Someone else's editing marker on the file an upload would change, which asks to confirm (AC-09).
const editingConfirm = ref(false);
const editingByOther = (file) => (file?.editing?.userId && file.editing.userId !== currentUserId.value ? file.editing : null);
const previewFile = computed(() => files.value.find((file) => file.id === previewFileId.value) ?? null);
const waitingRequests = computed(() => requests.value.filter((request) => request.status === 'pending'));
const finishedRequests = computed(() => requests.value.filter((request) => request.status !== 'pending'));
const listedRequests = computed(() => (showFinished.value ? requests.value : waitingRequests.value));
const target = computed(() => ({ targetId: props.targetId, targetType: props.targetType }));
const ready = computed(() => Boolean(props.token && props.projectId && props.targetId));
// A channel library shows one folder at a time.
const folderFiles = computed(() => {
  if (isChannel.value) return files.value.filter((file) => (file.folderId ?? null) === (props.folderId ?? null));
  return props.topLevel ? files.value.filter((file) => file.targetType !== 'channel') : files.value;
});
const filtered = computed(() => filterFiles(folderFiles.value, query.value));
const shown = computed(() => filtered.value.slice(0, shownCount.value));
const dialogTitle = computed(() => ({
  'link-file': 'Link a file from the vault',
  'link-item': `Link ${dialog.file?.fileName ?? 'file'} to a work item`,
  upload: 'Upload a file',
  version: `New version of ${dialog.file?.fileName ?? 'file'}`,
}[dialog.kind] ?? 'Files'));
const isUploadDialog = computed(() => dialog.kind === 'upload' || dialog.kind === 'version');
const maxUploadBytes = computed(() => (fileStorage.uploadsByParts ? fileStorage.maxUploadBytes : MAX_FILE_BYTES));
const uploadStart = computed(() => ({
  ...(dialog.kind === 'version' && dialog.file ? { expectedVersion: dialog.file.version, fileId: dialog.file.id } : { ...target.value, ...(isChannel.value && props.folderId ? { folderId: props.folderId } : {}) }),
  ...(editingConfirm.value ? { confirmEditing: true } : {}),
}));
// The interrupted upload the chosen file continues, if any.
const resumable = computed(() => (fileStorage.uploadsByParts ? matchPendingUpload(pendingUploads.value, form.file, uploadStart.value) : null));
const targetPendingUploads = computed(() => pendingUploads.value.filter((entry) => (entry.fileId ? files.value.some((file) => file.id === entry.fileId) : entry.targetId === props.targetId && entry.targetType === props.targetType)));
const transferPercent = computed(() => (transfer.totalBytes ? Math.floor((transfer.sentBytes / transfer.totalBytes) * 100) : 0));
const sending = computed(() => Boolean(transfer.controller));
const isLinkDialog = computed(() => dialog.kind === 'link-file' || dialog.kind === 'link-item');
const versionedByUpload = computed(() => (dialog.kind === 'upload' ? sameNamedFile(files.value, target.value, form.file?.name, isChannel.value ? props.folderId : null) : null));
const uploadEditing = computed(() => (isUploadDialog.value ? editingByOther(dialog.kind === 'version' ? dialog.file : versionedByUpload.value) : null));
const pickerMatches = computed(() => (dialog.kind === 'link-file'
  ? linkableFiles(dialog.choices, target.value, dialog.pickerQuery)
  : linkableItems(dialog.choices, dialog.file, dialog.pickerQuery)));
const pickerShown = computed(() => pickerMatches.value.slice(0, PICKER_LIMIT));

let loadToken = 0;

// `quiet` reloads after someone else's change: in the background, keeping the list on failure.
async function loadFiles({ quiet = false } = {}) {
  const run = ++loadToken;
  if (!ready.value) {
    files.value = [];
    canWrite.value = false;
    return;
  }
  if (!quiet) {
    loading.value = true;
    errorMessage.value = '';
  }
  try {
    const client = quiet ? api.passive : api;
    const [result, signing, storage] = await Promise.all([
      client.getFiles(props.projectId, target.value, props.token),
      // Only the vault lists requests; a server without signing leaves the list as it was.
      isVault.value ? client.listSigningRequests(props.projectId, {}, props.token).catch(() => null) : null,
      client.getFileStorage(props.projectId, props.token).catch(() => null),
    ]);
    if (run !== loadToken) return;
    files.value = result.files ?? [];
    canWrite.value = result.canWrite === true;
    if (storage) {
      Object.assign(fileStorage, {
        bytes: storage.storage?.bytes ?? null,
        canDeleteVersions: storage.canDeleteVersions === true,
        maxUploadBytes: Number(storage.maxUploadBytes ?? MAX_FILE_BYTES),
        uploadsByParts: storage.uploadsByParts === true,
      });
    }
    pendingUploads.value = readPendingUploads(props.projectId);
    if (signing) {
      requests.value = signing.requests ?? [];
      canManageSigning.value = signing.canManage === true;
    }
  } catch (error) {
    if (run === loadToken && !quiet) errorMessage.value = fileErrorMessage(error, 'Unable to load files.');
  } finally {
    if (run === loadToken) loading.value = false;
  }
}

async function loadVersions(file) {
  versionsLoading.value = true;
  versionsError.value = '';
  try {
    const result = await api.getFileVersions(props.projectId, file.id, props.token);
    if (expandedFileId.value === file.id) versions.value = result.versions ?? [];
  } catch (error) {
    versionsError.value = fileErrorMessage(error, 'Unable to load this file\'s versions.');
  } finally {
    versionsLoading.value = false;
  }
}

function toggle(file) {
  if (expandedFileId.value === file.id) {
    expandedFileId.value = '';
    return;
  }
  expandedFileId.value = file.id;
  versions.value = [];
  loadVersions(file);
}

// After a change: the list again, and the open row's versions with it.
async function refresh() {
  await loadFiles();
  const open = files.value.find((file) => file.id === expandedFileId.value);
  if (open) await loadVersions(open);
}

function report(message) {
  statusMessage.value = message;
  errorMessage.value = '';
}

// ---- Rename and Move to ----
// A file is renamed or moved where it is kept: in the vault, or on the channel it was uploaded to.
// Guests never see these.
const fileChange = reactive({ destinationKey: '', error: '', file: null, guests: null, kind: '', name: '', saving: false, tree: null, treeError: '', treeLoading: false });
const canChangeFile = (file) => canWrite.value && !viewer?.guest && (isVault.value || isHomeFile(file, target.value));
const destinations = computed(() => (fileChange.tree ? moveDestinations(fileChange.tree, fileChange.file) : []));
const pickedDestination = computed(() => destinations.value.find((option) => option.key === fileChange.destinationKey) ?? null);

function openRename(file) {
  Object.assign(fileChange, { destinationKey: '', error: '', file, guests: null, kind: 'rename', name: file.fileName, saving: false });
}

async function openMove(file) {
  Object.assign(fileChange, { destinationKey: '', error: '', file, guests: null, kind: 'move', name: '', saving: false, tree: null, treeError: '', treeLoading: true });
  try {
    fileChange.tree = await api.getProjectFileTree(props.projectId, props.token);
  } catch (error) {
    fileChange.treeError = fileErrorMessage(error, 'The folders could not load.');
  } finally {
    fileChange.treeLoading = false;
  }
}

function closeFileChange() {
  if (fileChange.saving) return;
  Object.assign(fileChange, { file: null, guests: null, kind: '' });
}

async function submitFileChange({ confirmGuests = false } = {}) {
  const file = fileChange.file;
  if (!file || fileChange.saving) return;
  const renaming = fileChange.kind === 'rename';
  const name = fileChange.name.trim();
  if (renaming && !name) {
    fileChange.error = 'Enter a file name.';
    return;
  }
  if (renaming && name === file.fileName) {
    closeFileChange();
    return;
  }
  const option = pickedDestination.value;
  if (!renaming && (!option || option.current)) {
    fileChange.error = 'Choose where to move the file.';
    return;
  }
  fileChange.saving = true;
  fileChange.error = '';
  try {
    const payload = renaming ? { fileName: name } : { destination: option.destination, ...(confirmGuests ? { confirmGuests: true } : {}) };
    await api.updateProjectFile(props.projectId, file.id, payload, props.token);
    fileChange.saving = false;
    Object.assign(fileChange, { file: null, guests: null, kind: '' });
    await loadFiles();
    report(renaming ? `Renamed to ${name}.` : `Moved ${file.fileName} to ${option.path}.`);
    emit('changed');
  } catch (error) {
    fileChange.saving = false;
    const guests = renaming ? null : guestsWillSee(error);
    if (guests && !confirmGuests) {
      fileChange.guests = { channelName: option.channelName, count: guests.guestCount };
      return;
    }
    fileChange.guests = null;
    fileChange.error = fileErrorMessage(error, renaming ? 'The file could not be renamed.' : 'The file could not be moved.');
  }
}

// A signed link straight to storage, so no file passes through the browser's memory. A server
// that does not report uploads in parts, or has no signed links (503), sends the bytes as before.
const signedLinkUnavailable = (error) => error?.status === 503;
async function signedLink(file, options) {
  if (!fileStorage.uploadsByParts) return null;
  try {
    const link = await api.getFileDownloadUrl(props.projectId, file.id, options, props.token);
    return { fileName: link.fileName, url: api.resolveTransferUrl(link.url) };
  } catch (error) {
    if (signedLinkUnavailable(error)) return null;
    throw error;
  }
}

async function download(file, version = null) {
  if (busyFileId.value) return;
  busyFileId.value = file.id;
  errorMessage.value = '';
  // The version is always named: a new one must never come back from the browser's cache.
  const versionNumber = version?.version ?? file.version;
  try {
    const link = await signedLink(file, { version: versionNumber });
    if (link) {
      saveUrl(link.url, link.fileName);
    } else {
      const result = await api.getFileContent(file.id, props.token, { download: true, version: versionNumber });
      saveBlob(result.blob, version?.fileName ?? file.fileName);
    }
  } catch (error) {
    errorMessage.value = fileErrorMessage(error, 'Unable to download the file.');
  } finally {
    busyFileId.value = '';
  }
}

async function open(file) {
  if (busyFileId.value) return;
  // With signed links the viewer shows it, Office files included.
  if (fileStorage.uploadsByParts) {
    previewFileId.value = file.id;
    return;
  }
  busyFileId.value = file.id;
  errorMessage.value = '';
  try {
    await openFile(() => api.getFileContent(file.id, props.token, { version: file.version }), file);
  } catch (error) {
    errorMessage.value = fileErrorMessage(error, 'Unable to open the file.');
  } finally {
    busyFileId.value = '';
  }
}

async function restore(file, version) {
  if (busyFileId.value) return;
  busyFileId.value = file.id;
  errorMessage.value = '';
  try {
    const result = await api.restoreFileVersion(props.projectId, file.id, version.version, { expectedVersion: file.version }, props.token);
    await refresh();
    report(result.unchanged ? 'That version is already the current contents.' : `Version ${version.version} restored as version ${result.file.version}.`);
  } catch (error) {
    await refresh();
    // After the refresh, which clears the list's own errors.
    errorMessage.value = fileErrorMessage(error, 'Unable to restore that version.');
  } finally {
    busyFileId.value = '';
  }
}

function resetForm() {
  form.description = '';
  form.file = null;
  form.note = '';
}

function openDialog(kind, file = null) {
  resetForm();
  editingConfirm.value = false;
  Object.assign(dialog, { choices: [], choicesLoading: false, error: '', file, kind, pickerQuery: '', saving: false, selectedId: '' });
  if (kind === 'link-file') loadChoices(async () => (await api.getFiles(props.projectId, { targetId: props.projectId, targetType: 'project' }, props.token)).files ?? []);
  if (kind === 'link-item') loadChoices(async () => flattenProjectItems((await api.getProject(props.projectId, props.token)).project));
}

async function loadChoices(read) {
  dialog.choicesLoading = true;
  try {
    dialog.choices = await read();
  } catch (error) {
    dialog.error = fileErrorMessage(error, 'Unable to load the list.');
  } finally {
    dialog.choicesLoading = false;
  }
}

function resetTransfer() {
  Object.assign(transfer, { conflict: null, controller: null, conflictChoice: 'keep-both', sentBytes: 0, totalBytes: 0, uploadId: '' });
}

// Cancel stops an upload in progress; otherwise it closes the dialog when nothing is saving.
async function closeDialog() {
  if (sending.value) {
    transfer.controller.abort();
    return;
  }
  if (dialog.saving) return;
  if (transfer.uploadId) {
    // A joined upload waiting on a conflict choice: drop it.
    const { uploadId } = transfer;
    forgetUpload(uploadId);
    api.cancelFileUpload(props.projectId, uploadId, props.token).catch(() => {});
  }
  resetTransfer();
  dialog.kind = '';
}

function pickFile(event) {
  form.file = event.target.files?.[0] ?? null;
  resetTransfer();
  dialog.error = form.file && form.file.size > maxUploadBytes.value ? `${form.file.name} is ${fileSizeLabel(form.file.size)}. Files can be up to ${fileSizeLabel(maxUploadBytes.value)}.` : '';
}

const fileTooLarge = computed(() => Boolean(form.file && form.file.size > maxUploadBytes.value));

const SCAN_NOTE = 'It can be downloaded once the virus scan finishes.';

// Saves an upload whose parts are all in storage. A newer version saved meanwhile is a conflict:
// the dialog then asks whether to keep both or save on top, and completes again.
async function completeTransfer(extra = {}) {
  try {
    const result = await api.completeFileUpload(props.projectId, transfer.uploadId, {
      ...(dialog.kind === 'upload' ? { fileDescription: form.description } : { note: form.note }),
      ...extra,
    }, props.token);
    forgetUpload(transfer.uploadId);
    resetTransfer();
    const { file } = result;
    return file.version > 1 ? `${file.fileName} is now version ${file.version}. ${SCAN_NOTE}` : `${file.fileName} uploaded. ${SCAN_NOTE}`;
  } catch (error) {
    if (error?.data?.details?.code === 'file_changed' && error.data.details.canKeepBoth) {
      transfer.conflict = { currentVersion: error.data.details.currentVersion };
      return null;
    }
    throw error;
  }
}

async function submitLargeUpload() {
  const controller = new AbortController();
  transfer.controller = controller;
  try {
    const upload = await sendLargeUpload({
      api: api,
      file: form.file,
      onProgress: ({ sentBytes, totalBytes }) => Object.assign(transfer, { sentBytes, totalBytes }),
      projectId: props.projectId,
      resolveUrl: (url) => api.resolveTransferUrl(url),
      resume: resumable.value,
      signal: controller.signal,
      start: uploadStart.value,
      token: props.token,
    });
    transfer.uploadId = upload.id;
  } catch (error) {
    pendingUploads.value = readPendingUploads(props.projectId);
    if (error?.name !== 'AbortError') throw error;
    // Cancelled: storage drops the parts sent so far.
    const stopped = pendingUploads.value.find((entry) => entry.fileName === form.file.name && entry.size === form.file.size);
    if (stopped) {
      forgetUpload(stopped.uploadId);
      await api.cancelFileUpload(props.projectId, stopped.uploadId, props.token).catch(() => {});
      pendingUploads.value = readPendingUploads(props.projectId);
    }
    throw error;
  } finally {
    transfer.controller = null;
  }
  return completeTransfer();
}

async function submitUpload() {
  if (transfer.conflict) {
    return completeTransfer(transfer.conflictChoice === 'keep-both' ? { keepBoth: true } : { expectedVersion: transfer.conflict.currentVersion });
  }
  if (fileStorage.uploadsByParts && form.file.size > 0) return submitLargeUpload();
  const fileContentsBase64 = await fileToBase64(form.file);
  const fileType = form.file.type || 'application/octet-stream';
  if (dialog.kind === 'version') {
    const file = dialog.file;
    const result = await api.uploadFileVersion(props.projectId, file.id, {
      ...(editingConfirm.value ? { confirmEditing: true } : {}),
      expectedVersion: file.version,
      fileContentsBase64,
      fileName: form.file.name,
      fileType,
      note: form.note,
    }, props.token);
    return result.unchanged ? 'That is the same as the current version, so nothing changed.' : `Version ${result.file.version} uploaded.`;
  }
  const result = await api.uploadProjectFile(props.projectId, {
    fileContentsBase64,
    fileDescription: form.description,
    fileName: form.file.name,
    fileType,
    inlineImage: false,
    ...target.value,
    ...(isChannel.value && props.folderId ? { folderId: props.folderId } : {}),
  }, props.token);
  return result.file.version > 1 ? `${result.file.fileName} is now version ${result.file.version}.` : `${result.file.fileName} uploaded.`;
}

async function submitLink() {
  const fileId = dialog.kind === 'link-file' ? dialog.selectedId : dialog.file.id;
  const chosen = dialog.kind === 'link-item' ? dialog.choices.find((item) => item.id === dialog.selectedId) : null;
  const linkTarget = chosen ? { targetId: chosen.id, targetType: chosen.itemType } : target.value;
  await api.linkFile(props.projectId, fileId, linkTarget, props.token);
  return 'File linked.';
}

async function submitDialog() {
  if (dialog.saving) return;
  if (isUploadDialog.value && (!form.file || fileTooLarge.value)) {
    dialog.error ||= 'Choose a file.';
    return;
  }
  if (uploadEditing.value && !editingConfirm.value && !transfer.conflict) {
    dialog.error = `${uploadEditing.value.name || 'Someone'} is editing this file. Tick "Upload anyway" to upload over their work.`;
    return;
  }
  if (isLinkDialog.value && !dialog.selectedId) {
    dialog.error = dialog.kind === 'link-file' ? 'Choose a file.' : 'Choose a work item.';
    return;
  }
  dialog.saving = true;
  dialog.error = '';
  try {
    const message = isUploadDialog.value ? await submitUpload() : await submitLink();
    dialog.saving = false;
    // No message: a version conflict to settle in the dialog.
    if (message === null) return;
    dialog.kind = '';
    await refresh();
    report(message);
  } catch (error) {
    dialog.saving = false;
    if (error?.name === 'AbortError') {
      resetTransfer();
      dialog.kind = '';
      report('Upload cancelled.');
      return;
    }
    // Someone marked the file as being edited after the dialog opened: show it, and ask as above.
    if (error?.data?.details?.code === 'file_being_edited') {
      const listed = files.value.find((entry) => entry.id === (dialog.file?.id ?? versionedByUpload.value?.id));
      if (listed) listed.editing = error.data.details.editing;
    }
    dialog.error = fileErrorMessage(error, 'Unable to save that.');
  }
}

// The editing marker (docs/engagements/plan.md, Library): set it, or clear your own. People with
// decision rights can clear anyone's.
async function setEditing(file, on) {
  if (busyFileId.value) return;
  busyFileId.value = file.id;
  errorMessage.value = '';
  try {
    if (on) await api.setFileEditing(props.projectId, file.id, props.token);
    else await api.clearFileEditing(props.projectId, file.id, props.token);
    await loadFiles({ quiet: true });
    report(on ? `${file.fileName} is marked as being edited by you. Others are asked before they upload over it.` : `${file.fileName} is no longer marked as being edited.`);
  } catch (error) {
    errorMessage.value = fileErrorMessage(error, 'Unable to change the editing marker.');
  } finally {
    busyFileId.value = '';
  }
}
const canClearEditing = (file) => Boolean(file.editing) && (file.editing.userId === currentUserId.value || fileStorage.canDeleteVersions);

function askDelete(file) {
  Object.assign(removal, { error: '', file, kind: 'delete', link: null, saving: false });
}

function askUnlink(file, link) {
  Object.assign(removal, { error: '', file, kind: 'unlink', link, saving: false });
}

function askDeleteVersion(file, version) {
  Object.assign(removal, { error: '', file, kind: 'version', link: null, saving: false, version });
}

// Drops an interrupted upload this browser kept for resuming.
async function discardPendingUpload(entry) {
  forgetUpload(entry.uploadId);
  pendingUploads.value = readPendingUploads(props.projectId);
  await api.cancelFileUpload(props.projectId, entry.uploadId, props.token).catch(() => {});
}

function closeRemoval() {
  if (!removal.saving) removal.kind = '';
}

async function confirmRemoval() {
  if (removal.saving) return;
  removal.saving = true;
  removal.error = '';
  try {
    if (removal.kind === 'delete') {
      await api.deleteFile(removal.file.id, props.token);
    } else if (removal.kind === 'version') {
      await api.deleteFileVersion(props.projectId, removal.file.id, removal.version.version, props.token);
    } else {
      await api.unlinkFile(props.projectId, removal.file.id, removal.link.linkId, props.token);
    }
    const message = { delete: `${removal.file.fileName} deleted.`, version: `Version ${removal.version?.version} deleted.` }[removal.kind] ?? 'File unlinked.';
    removal.saving = false;
    removal.kind = '';
    await refresh();
    report(message);
  } catch (error) {
    removal.saving = false;
    removal.error = fileErrorMessage(error, { delete: 'Unable to delete the file.', version: 'Unable to delete that version.' }[removal.kind] ?? 'Unable to unlink the file.');
  }
}

// The link that puts a file on this item, when that is how it got here.
const linkHere = (file) => fileAttachments(file, props.projectId).find((place) => place.linkId && place.targetId === props.targetId && place.targetType === props.targetType) ?? null;
const attachmentsOf = (file) => fileAttachments(file, props.projectId).filter((place) => isVault.value || place.targetId !== props.targetId);
// Delete sits with the file: on the item it was uploaded to, or in the vault.
// A file in a signature request stays (the API refuses), so Delete is not offered for it.
const canDelete = (file) => !viewer?.guest && (isVault.value || isHomeFile(file, target.value)) && !fileUnderSignature(requests.value, file.id);
const fileRequests = (file) => requestsForFile(requests.value, file.id);
// The newest request a file is in that still matters: waiting, or signed by everyone.
const fileSigning = (file) => fileRequests(file).find((request) => request.status === 'pending' || request.status === 'completed') ?? null;

function openSigningCreate(file = null) {
  signingCreate.fileId = file?.id ?? '';
  signingCreate.open = true;
}

async function signingCreated(request) {
  signingCreate.open = false;
  await refresh();
  report(`Sent "${request.title}" for signature.`);
  signingDetailId.value = request.id;
}

function openSigning(request) {
  signingDetailId.value = request.id;
}

// Sharing with stakeholders asks first; keeping a file to the team does not.
async function setAudience(file, audience) {
  if (audience === 'external') {
    Object.assign(sharing, { error: '', file, saving: false });
    return;
  }
  if (busyFileId.value) return;
  busyFileId.value = file.id;
  errorMessage.value = '';
  try {
    await api.setFileAudience(props.projectId, file.id, 'internal', props.token);
    await loadFiles({ quiet: true });
    report(`${file.fileName} is internal again.`);
  } catch (error) {
    errorMessage.value = signingErrorMessage(error, 'Unable to change who can see the file.');
  } finally {
    busyFileId.value = '';
  }
}

async function confirmSharing() {
  if (sharing.saving || !sharing.file) return;
  sharing.saving = true;
  sharing.error = '';
  try {
    await api.setFileAudience(props.projectId, sharing.file.id, 'external', props.token);
    const name = sharing.file.fileName;
    sharing.file = null;
    await loadFiles({ quiet: true });
    report(`${name} is shared with stakeholders.`);
  } catch (error) {
    sharing.error = signingErrorMessage(error, 'Unable to share the file.');
  } finally {
    sharing.saving = false;
  }
}

function closeSharing() {
  if (!sharing.saving) sharing.file = null;
}

function openRequestedSigning() {
  if (!isVault.value || !props.focusSigningId || openedSigningId === props.focusSigningId) return;
  openedSigningId = props.focusSigningId;
  signingDetailId.value = props.focusSigningId;
}
const uploaderOf = (file) => file.uploadedBy?.name ?? 'Unknown user';
// Open shows what a browser can display safely. With signed links the viewer also shows MP4 and
// WebM video, Markdown, and Office files as PDFs.
const canOpen = (file) => isFileReady(file) && (fileStorage.uploadsByParts ? Boolean(previewKindOf(file)) : canPreviewFile(file));
const canDeleteVersion = (version) => fileStorage.canDeleteVersions && !version.current && !version.deletedAt;
const removalTitle = computed(() => ({ delete: 'Delete this file?', version: `Delete version ${removal.version?.version}?` }[removal.kind] ?? 'Unlink this file?'));
const removalConfirmLabel = computed(() => ({ delete: 'Delete file', version: 'Delete version' }[removal.kind] ?? 'Unlink file'));
const setRow = (id, element) => { if (element) rowElements.set(id, element); else rowElements.delete(id); };

async function focusRequestedFile() {
  const file = files.value.find((entry) => entry.id === props.focusFileId);
  if (!file) return;
  if (expandedFileId.value !== file.id) toggle(file);
  if (!shown.value.some((entry) => entry.id === file.id)) shownCount.value = filtered.value.length;
  await nextTick();
  rowElements.get(file.id)?.scrollIntoView?.({ block: 'center' });
}

watch(() => [props.projectId, props.targetId, props.targetType, props.token], async () => {
  expandedFileId.value = '';
  statusMessage.value = '';
  shownCount.value = LIST_STEP;
  await loadFiles();
  await focusRequestedFile();
  openRequestedSigning();
}, { immediate: true });
watch(() => props.focusFileId, focusRequestedFile);
watch(() => props.focusSigningId, openRequestedSigning);
onProjectRefresh(() => loadFiles({ quiet: true }));
watch(() => props.liveVersion, async () => {
  await loadFiles({ quiet: true });
  const open = files.value.find((file) => file.id === expandedFileId.value);
  if (open) await loadVersions(open);
});
watch(() => props.folderId, () => { shownCount.value = LIST_STEP; });
watch(query, () => { shownCount.value = LIST_STEP; });
</script>

<template>
  <section class="workbench-card project-files" :aria-labelledby="headingId">
    <header class="project-files__head">
      <h3 :id="headingId" class="project-files__title">
        Files <span class="project-files__count">{{ folderFiles.length }}</span>
        <span v-if="isVault && fileStorage.bytes != null" class="project-files__usage">· {{ fileSizeLabel(fileStorage.bytes) }} used</span>
      </h3>
      <div v-if="canWrite" class="project-files__actions">
        <button v-if="!isVault && !isChannel" class="ghost-button project-files__action" type="button" @click="openDialog('link-file')">
          <i class="bi bi-link-45deg" aria-hidden="true"></i>
          <span>Link from vault</span>
        </button>
        <button v-if="isVault && canManageSigning" class="ghost-button project-files__action" type="button" @click="openSigningCreate()">
          <i class="bi bi-pen" aria-hidden="true"></i>
          <span>Request signatures</span>
        </button>
        <button class="ghost-button project-files__action" type="button" @click="openDialog('upload')">
          <i class="bi bi-upload" aria-hidden="true"></i>
          <span>Upload file</span>
        </button>
      </div>
    </header>

    <section v-if="isVault && requests.length" class="project-files__signing" :aria-labelledby="`${headingId}-signing`">
      <div class="project-files__signing-head">
        <h4 :id="`${headingId}-signing`" class="project-files__label">Signature requests · {{ waitingRequests.length }} waiting</h4>
        <button v-if="finishedRequests.length" class="ghost-button project-files__action" type="button" :aria-expanded="showFinished" @click="showFinished = !showFinished">
          {{ showFinished ? 'Hide finished' : `Show finished (${finishedRequests.length})` }}
        </button>
      </div>
      <ul v-if="listedRequests.length" class="project-files__requests">
        <li v-for="request in listedRequests" :key="request.id" class="project-files__request">
          <div class="project-files__version-text">
            <strong class="project-files__name">{{ request.title }}</strong>
            <span class="project-files__meta">
              <i :class="['bi', signingStatus(request.status).icon]" aria-hidden="true"></i>
              {{ signingStatus(request.status).label }} · {{ signingKindLabel(request.kind) }} · {{ signingProgressLabel(request.progress) }}
            </span>
          </div>
          <button class="ghost-button project-files__action" type="button" @click="openSigning(request)">Open<span class="visually-hidden"> {{ request.title }}</span></button>
        </li>
      </ul>
      <p v-else class="project-files__note">Nothing is waiting for signatures.</p>
    </section>

    <div v-if="isVault && files.length" class="rq-field">
      <label class="visually-hidden" :for="searchId">Search files</label>
      <input :id="searchId" v-model="query" autocomplete="off" class="form-control" placeholder="Search by name, description or work item" type="search" />
    </div>

    <p v-if="errorMessage" class="error-banner mb-0" role="alert">{{ errorMessage }}</p>
    <p class="project-files__status" role="status">{{ statusMessage }}</p>

    <ul v-if="canWrite && targetPendingUploads.length" class="project-files__pending" aria-label="Unfinished uploads">
      <li v-for="entry in targetPendingUploads" :key="entry.uploadId" class="project-files__pending-row">
        <span class="project-files__description">
          <i class="bi bi-cloud-arrow-up" aria-hidden="true"></i>
          {{ entry.fileName }} stopped before it finished. Upload the same file again to continue.
        </span>
        <button class="ghost-button project-files__action" type="button" @click="discardPendingUpload(entry)">Discard<span class="visually-hidden"> {{ entry.fileName }}</span></button>
      </li>
    </ul>

    <p v-if="loading && !files.length" class="project-files__note" role="status">Loading files…</p>
    <p v-else-if="!folderFiles.length && !errorMessage" class="project-files__note">{{ isChannel && folderId ? 'No files in this folder yet.' : 'No files yet.' }}</p>
    <p v-else-if="!filtered.length" class="project-files__note">No files match that search.</p>

    <ul v-if="shown.length" class="project-files__list">
      <li v-for="file in shown" :key="file.id" :ref="(element) => setRow(file.id, element)" class="project-files__row" :class="{ 'project-files__row--focused': file.id === focusFileId }">
        <div class="project-files__main">
          <div class="project-files__identity">
            <strong class="project-files__name">{{ file.fileName }}</strong>
            <span v-if="file.version > 1" class="project-files__version">v{{ file.version }}</span>
            <span v-if="!isVault && !isHomeFile(file, target)" class="project-files__tag">Linked</span>
            <span v-if="file.audience === 'external'" class="project-files__tag project-files__tag--shared"><i class="bi bi-people" aria-hidden="true"></i> Shared</span>
            <span v-if="fileScanState(file)" class="project-files__tag" :class="{ 'project-files__tag--danger': file.scanStatus !== 'pending' }">
              <i :class="['bi', fileScanState(file).icon]" aria-hidden="true"></i> {{ fileScanState(file).label }}
            </span>
            <span v-if="file.editing" class="project-files__tag project-files__tag--editing">
              <i class="bi bi-pencil-square" aria-hidden="true"></i> {{ editingLabel(file.editing, currentUserId) }}
            </span>
            <span v-if="fileSigning(file)" class="project-files__tag">
              <i :class="['bi', signingStatus(fileSigning(file).status).icon]" aria-hidden="true"></i>
              {{ fileSigning(file).status === 'completed' ? 'Signed' : 'Waiting for signatures' }}
            </span>
          </div>
          <p v-if="file.description && file.description !== file.fileName" class="project-files__description">{{ file.description }}</p>
          <p class="project-files__meta">{{ fileSizeLabel(file.fileSize) }} · {{ uploaderOf(file) }} · {{ fileDateLabel(file.versionUploadedAt ?? file.updatedAt) }}</p>
          <ul v-if="attachmentsOf(file).some((place) => place.route)" class="project-files__places" aria-label="Attached to">
            <li v-for="place in attachmentsOf(file).filter((entry) => entry.route)" :key="place.key">
              <i :class="['bi', place.icon]" aria-hidden="true"></i>
              <span class="visually-hidden">{{ place.label }}:</span>
              <RouterLink class="project-files__place" :to="place.route" @click="emit('navigate')">{{ place.name }}</RouterLink>
            </li>
          </ul>
        </div>

        <div class="project-files__row-actions">
          <button class="ghost-button project-files__action" type="button" :disabled="busyFileId === file.id || !isFileReady(file)" @click="download(file)">
            <i class="bi bi-download" aria-hidden="true"></i>
            <span>Download</span>
          </button>
          <button v-if="canOpen(file)" class="ghost-button project-files__action" type="button" :disabled="busyFileId === file.id" @click="open(file)">
            <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i>
            <span>Open</span>
          </button>
          <button
            class="project-files__toggle"
            type="button"
            :aria-expanded="expandedFileId === file.id"
            :aria-label="`${expandedFileId === file.id ? 'Hide' : 'Show'} versions and links for ${file.fileName}`"
            @click="toggle(file)"
          >
            <i :class="['bi', expandedFileId === file.id ? 'bi-chevron-up' : 'bi-chevron-down']" aria-hidden="true"></i>
          </button>
        </div>

        <div v-if="expandedFileId === file.id" class="project-files__detail">
          <section v-if="!viewer?.guest" class="project-files__section">
            <h4 class="project-files__label">Who can see it</h4>
            <div class="project-files__audience-row">
              <span class="project-files__description">
                <template v-if="file.audience === 'external'">Shared: stakeholders on this project can see and download it.</template>
                <template v-else>Internal: only the project team can see it.</template>
              </span>
              <template v-if="canWrite && file.targetType !== 'ticket'">
                <button v-if="file.audience !== 'external'" class="ghost-button project-files__action" type="button" :disabled="busyFileId === file.id" @click="setAudience(file, 'external')">Share with stakeholders</button>
                <button v-else-if="!fileUnderSignature(requests, file.id)" class="ghost-button project-files__action" type="button" :disabled="busyFileId === file.id" @click="setAudience(file, 'internal')">Make internal</button>
              </template>
            </div>
          </section>

          <section v-if="isVault && fileRequests(file).length" class="project-files__section">
            <h4 class="project-files__label">Signatures</h4>
            <ul class="project-files__requests">
              <li v-for="request in fileRequests(file)" :key="request.id" class="project-files__request">
                <div class="project-files__version-text">
                  <strong>{{ request.title }}</strong>
                  <span class="project-files__meta">
                    <i :class="['bi', signingStatus(request.status).icon]" aria-hidden="true"></i>
                    {{ signingStatus(request.status).label }} · {{ signingProgressLabel(request.progress) }}
                  </span>
                  <ul class="project-files__signers">
                    <li v-for="signer in (request.signers ?? []).filter((entry) => entry.status !== 'removed')" :key="signer.id" class="project-files__meta">
                      {{ signer.name }}: {{ signer.status === 'signed' ? `signed ${fileDateLabel(signer.signedAt)}` : signer.status === 'declined' ? 'declined' : 'not signed yet' }}
                    </li>
                  </ul>
                </div>
                <button class="ghost-button project-files__action" type="button" @click="openSigning(request)">Open<span class="visually-hidden"> {{ request.title }}</span></button>
              </li>
            </ul>
          </section>

          <section class="project-files__section">
            <h4 class="project-files__label">Versions</h4>
            <p v-if="versionsLoading && !versions.length" class="project-files__note" role="status">Loading versions…</p>
            <p v-else-if="versionsError" class="error-banner mb-0" role="alert">{{ versionsError }}</p>
            <ol v-else class="project-files__versions">
              <li v-for="version in versions" :key="version.version" class="project-files__version-row">
                <div class="project-files__version-text">
                  <span class="project-files__version-line">
                    <strong>Version {{ version.version }}</strong>
                    <span v-if="version.current" class="project-files__tag">Current</span>
                    <span v-if="version.deletedAt" class="project-files__tag"><i class="bi bi-trash" aria-hidden="true"></i> Deleted</span>
                    <span v-else-if="fileScanState(version)" class="project-files__tag" :class="{ 'project-files__tag--danger': version.scanStatus !== 'pending' }">
                      <i :class="['bi', fileScanState(version).icon]" aria-hidden="true"></i> {{ fileScanState(version).label }}
                    </span>
                    <span v-if="version.fileName !== file.fileName" class="project-files__version-name">{{ version.fileName }}</span>
                  </span>
                  <span class="project-files__meta">{{ fileSizeLabel(version.fileSize) }} · {{ version.uploadedBy?.name ?? 'Unknown user' }} · {{ fileDateLabel(version.uploadedAt) }}</span>
                  <span v-if="version.note" class="project-files__description">{{ version.note }}</span>
                </div>
                <div v-if="!version.current && !version.deletedAt" class="project-files__version-actions">
                  <button class="project-files__icon" type="button" :aria-label="`Download version ${version.version}`" :disabled="busyFileId === file.id || !isFileReady(version)" @click="download(file, version)">
                    <i class="bi bi-download" aria-hidden="true"></i>
                  </button>
                  <button v-if="canWrite && !viewer?.guest && version.scanStatus !== 'infected'" class="ghost-button project-files__action" type="button" :disabled="busyFileId === file.id" @click="restore(file, version)">Restore</button>
                  <button v-if="canDeleteVersion(version)" class="project-files__icon project-files__icon--danger" type="button" :aria-label="`Delete version ${version.version}`" :disabled="busyFileId === file.id" @click="askDeleteVersion(file, version)">
                    <i class="bi bi-trash" aria-hidden="true"></i>
                  </button>
                </div>
              </li>
            </ol>
          </section>

          <section v-if="file.links?.length" class="project-files__section">
            <h4 class="project-files__label">Linked to</h4>
            <ul class="project-files__links">
              <li v-for="place in fileAttachments(file, projectId).filter((entry) => entry.linkId)" :key="place.key" class="project-files__link-row">
                <span class="project-files__link-name">
                  <i :class="['bi', place.icon]" aria-hidden="true"></i>
                  <RouterLink class="project-files__place" :to="place.route" @click="emit('navigate')">{{ place.name }}</RouterLink>
                </span>
                <button v-if="canWrite" class="project-files__icon" type="button" :aria-label="`Unlink ${file.fileName} from ${place.name}`" @click="askUnlink(file, place)">
                  <i class="bi bi-x-lg" aria-hidden="true"></i>
                </button>
              </li>
            </ul>
          </section>

          <FileComments :file="file" :live-version="liveVersion" :project-id="projectId" :token="token" />

          <div v-if="canWrite" class="project-files__manage">
            <button v-if="!file.editing" class="ghost-button project-files__action" type="button" :disabled="busyFileId === file.id" @click="setEditing(file, true)">
              <i class="bi bi-pencil-square" aria-hidden="true"></i>
              <span>Mark as editing</span>
            </button>
            <button v-else-if="canClearEditing(file)" class="ghost-button project-files__action" type="button" :disabled="busyFileId === file.id" @click="setEditing(file, false)">
              <i class="bi bi-check2-square" aria-hidden="true"></i>
              <span>{{ file.editing.userId === currentUserId ? 'Done editing' : 'Clear editing marker' }}</span>
            </button>
            <button v-if="isVault && canManageSigning && file.targetType !== 'ticket'" class="ghost-button project-files__action" type="button" @click="openSigningCreate(file)">
              <i class="bi bi-pen" aria-hidden="true"></i>
              <span>Request signatures</span>
            </button>
            <button class="ghost-button project-files__action" type="button" @click="openDialog('version', file)">
              <i class="bi bi-file-earmark-arrow-up" aria-hidden="true"></i>
              <span>New version</span>
            </button>
            <button v-if="canChangeFile(file)" class="ghost-button project-files__action" type="button" @click="openRename(file)">
              <i class="bi bi-input-cursor-text" aria-hidden="true"></i>
              <span>Rename</span>
            </button>
            <button v-if="canChangeFile(file) && canMoveFile(file)" class="ghost-button project-files__action" type="button" @click="openMove(file)">
              <i class="bi bi-folder-symlink" aria-hidden="true"></i>
              <span>Move to…</span>
            </button>
            <button v-if="isVault" class="ghost-button project-files__action" type="button" @click="openDialog('link-item', file)">
              <i class="bi bi-link-45deg" aria-hidden="true"></i>
              <span>Link to work item</span>
            </button>
            <button v-if="linkHere(file)" class="ghost-button project-files__action" type="button" @click="askUnlink(file, linkHere(file))">
              <i class="bi bi-x-lg" aria-hidden="true"></i>
              <span>Unlink from this item</span>
            </button>
            <button v-if="canDelete(file)" class="ghost-button ghost-button--danger project-files__action project-files__delete" type="button" @click="askDelete(file)">
              <i class="bi bi-trash" aria-hidden="true"></i>
              <span>Delete file</span>
            </button>
          </div>
        </div>
      </li>
    </ul>

    <button v-if="filtered.length > shown.length" class="ghost-button project-files__action project-files__more" type="button" @click="shownCount += LIST_STEP">
      Show more ({{ filtered.length - shown.length }} left)
    </button>

    <RequirementsDialog :busy="dialog.saving" :open="Boolean(dialog.kind)" :title="dialogTitle" @close="closeDialog" @submit="submitDialog">
      <template v-if="isUploadDialog">
        <div class="rq-field">
          <label :for="fileInputId">File</label>
          <input :id="fileInputId" class="form-control" type="file" data-autofocus :disabled="dialog.saving || Boolean(transfer.conflict)" @change="pickFile" />
          <p class="rq-field__hint mb-0">Up to {{ fileSizeLabel(maxUploadBytes) }}.</p>
        </div>
        <p v-if="resumable && !sending" class="rq-field__hint mb-0">
          This continues the upload of {{ resumable.fileName }} that stopped. Parts already sent are kept.
        </p>
        <div v-if="sending || transfer.sentBytes" class="project-files__progress">
          <progress :aria-labelledby="`${uid}-progress`" :max="100" :value="transferPercent"></progress>
          <span :id="`${uid}-progress`" class="project-files__meta" role="status">
            <template v-if="transfer.uploadId">Uploaded · {{ fileSizeLabel(transfer.totalBytes) }}</template>
            <template v-else>Uploading {{ transferPercent }}% · {{ fileSizeLabel(transfer.sentBytes) }} of {{ fileSizeLabel(transfer.totalBytes) }}</template>
          </span>
        </div>
        <fieldset v-if="transfer.conflict" class="rq-field">
          <legend class="project-files__conflict">Someone saved version {{ transfer.conflict.currentVersion }} while this uploaded.</legend>
          <label class="project-files__choice">
            <input v-model="transfer.conflictChoice" class="form-check-input mt-0" name="upload-conflict" type="radio" value="keep-both" />
            <span>Keep both: save this as a new file next to it</span>
          </label>
          <label class="project-files__choice">
            <input v-model="transfer.conflictChoice" class="form-check-input mt-0" name="upload-conflict" type="radio" value="on-top" />
            <span>Save this as version {{ transfer.conflict.currentVersion + 1 }}, on top of theirs</span>
          </label>
        </fieldset>
        <fieldset v-if="uploadEditing && !transfer.conflict" class="rq-field">
          <legend class="project-files__conflict">{{ editingLabel(uploadEditing, currentUserId) }}.</legend>
          <label class="project-files__choice">
            <input v-model="editingConfirm" class="form-check-input mt-0" type="checkbox" />
            <span>Upload anyway. Their marker stays until they finish.</span>
          </label>
        </fieldset>
        <p v-if="versionedByUpload" class="rq-field__hint mb-0">
          {{ versionedByUpload.fileName }} is already here, so this becomes version {{ versionedByUpload.version + 1 }}. Earlier versions stay.
        </p>
        <div v-if="dialog.kind === 'upload'" class="rq-field">
          <label :for="descriptionId">Description (optional)</label>
          <input :id="descriptionId" v-model="form.description" class="form-control" maxlength="1000" />
        </div>
        <div v-else class="rq-field">
          <label :for="noteId">What changed (optional)</label>
          <input :id="noteId" v-model="form.note" class="form-control" maxlength="1000" />
        </div>
      </template>

      <template v-else-if="isLinkDialog">
        <div class="rq-field">
          <label :for="pickerSearchId">{{ dialog.kind === 'link-file' ? 'Find a file' : 'Find a work item' }}</label>
          <input :id="pickerSearchId" v-model="dialog.pickerQuery" autocomplete="off" class="form-control" data-autofocus placeholder="Search by name" type="search" />
        </div>
        <p v-if="dialog.choicesLoading" class="rq-field__hint" role="status">Loading…</p>
        <fieldset v-else class="rq-field">
          <legend class="visually-hidden">{{ dialog.kind === 'link-file' ? 'File' : 'Work item' }}</legend>
          <ul v-if="pickerShown.length" class="rq-checklist project-files__picker">
            <li v-for="choice in pickerShown" :key="choice.id">
              <label>
                <input v-model="dialog.selectedId" class="form-check-input mt-0" name="file-link-choice" type="radio" :value="choice.id" />
                <template v-if="dialog.kind === 'link-file'">
                  <i class="bi bi-file-earmark" aria-hidden="true"></i>
                  <span class="project-files__picker-name">{{ choice.fileName }}</span>
                  <span class="project-files__picker-meta">{{ fileSizeLabel(choice.fileSize) }}</span>
                </template>
                <template v-else>
                  <i :class="['bi', itemTypeMeta(choice.itemType).icon]" aria-hidden="true"></i>
                  <span class="project-files__picker-name">{{ choice.name || 'Untitled item' }}</span>
                  <span class="project-files__picker-meta">{{ itemTypeMeta(choice.itemType).label }}</span>
                </template>
              </label>
            </li>
          </ul>
          <p v-else class="rq-field__hint">Nothing to link{{ dialog.pickerQuery ? ' matches that search' : ' yet' }}.</p>
          <p v-if="pickerMatches.length > pickerShown.length" class="rq-field__hint">
            Showing the first {{ pickerShown.length }} of {{ pickerMatches.length }}. Refine the search to find more.
          </p>
        </fieldset>
      </template>

      <p v-if="dialog.error" class="error-banner mb-0" role="alert">{{ dialog.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="dialog.saving && !sending" @click="closeDialog">{{ sending ? 'Stop upload' : 'Cancel' }}</button>
        <button class="primary-button" type="submit" :disabled="dialog.saving || dialog.choicesLoading || fileTooLarge">
          <template v-if="sending">Uploading…</template>
          <template v-else-if="dialog.saving">Saving…</template>
          <template v-else-if="transfer.conflict">Save</template>
          <template v-else-if="dialog.kind === 'upload'">Upload file</template>
          <template v-else-if="dialog.kind === 'version'">Upload version</template>
          <template v-else>Link file</template>
        </button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="removal.saving"
      :confirm-label="removalConfirmLabel"
      :error="removal.error"
      :open="Boolean(removal.kind)"
      :title="removalTitle"
      @close="closeRemoval"
      @confirm="confirmRemoval"
    >
      <p v-if="removal.kind === 'delete'" class="mb-0">
        Delete {{ removal.file?.fileName }}<template v-if="removal.file?.version > 1"> and all {{ removal.file.version }} versions</template>, everywhere it is linked? This can't be undone.
      </p>
      <p v-else-if="removal.kind === 'version'" class="mb-0">
        Delete version {{ removal.version?.version }} of {{ removal.file?.fileName }}? Its contents are removed for good; the other versions stay.
      </p>
      <p v-else-if="removal.kind === 'unlink'" class="mb-0">
        Take {{ removal.file?.fileName }} off {{ removal.link?.name }}? The file stays in the vault.
      </p>
    </RequirementsConfirmDialog>

    <RequirementsDialog :busy="sharing.saving" :open="Boolean(sharing.file)" :title="'Share with stakeholders?'" @close="closeSharing" @submit="confirmSharing">
      <p class="mb-0">Everyone with a stakeholder link on this project can see and download {{ sharing.file?.fileName }}, including every new version.</p>
      <p v-if="sharing.error" class="error-banner mb-0" role="alert">{{ sharing.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="sharing.saving" @click="closeSharing">Cancel</button>
        <button class="primary-button" type="submit" :disabled="sharing.saving">{{ sharing.saving ? 'Sharing…' : 'Share' }}</button>
      </template>
    </RequirementsDialog>

    <FilePreviewDialog
      :busy="Boolean(previewFile) && busyFileId === previewFile.id"
      :file="previewFile"
      :open="Boolean(previewFile)"
      :project-id="projectId"
      :token="token"
      @close="previewFileId = ''"
      @download="download(previewFile)"
    />

    <RequirementsDialog
      :busy="fileChange.saving"
      :open="Boolean(fileChange.kind) && !fileChange.guests"
      :title="fileChange.kind === 'rename' ? `Rename ${fileChange.file?.fileName ?? 'file'}` : `Move ${fileChange.file?.fileName ?? 'file'}`"
      @close="closeFileChange"
      @submit="submitFileChange()"
    >
      <div v-if="fileChange.kind === 'rename'" class="rq-field">
        <label :for="`${uid}-rename`">File name</label>
        <input :id="`${uid}-rename`" v-model="fileChange.name" class="form-control" maxlength="255" autocomplete="off" data-autofocus />
      </div>
      <template v-else>
        <p v-if="fileChange.treeLoading" class="project-files__note" role="status">Loading folders…</p>
        <p v-else-if="fileChange.treeError" class="error-banner mb-0" role="alert">{{ fileChange.treeError }}</p>
        <fieldset v-else class="project-files__destinations">
          <legend class="project-files__label">Move to</legend>
          <label
            v-for="option in destinations"
            :key="option.key"
            class="project-files__destination"
            :class="{ 'project-files__destination--current': option.current }"
            :style="{ '--depth': option.depth }"
          >
            <input v-model="fileChange.destinationKey" type="radio" :name="`${uid}-destination`" :value="option.key" :disabled="option.current" />
            <i :class="['bi', option.depth === 0 ? 'bi-briefcase' : option.depth === 1 ? 'bi-hash' : 'bi-folder2']" aria-hidden="true"></i>
            <span class="project-files__destination-name">{{ option.depth === 1 ? option.label.slice(1) : option.label }}</span>
            <span v-if="option.current" class="project-files__tag">Here now</span>
            <span v-else-if="option.depth === 1 && option.guestCount" class="project-files__tag"><i class="bi bi-person-badge" aria-hidden="true"></i> {{ option.guestCount }} {{ option.guestCount === 1 ? 'guest' : 'guests' }}</span>
          </label>
        </fieldset>
      </template>
      <p v-if="fileChange.error" class="error-banner mb-0" role="alert">{{ fileChange.error }}</p>
      <template #footer>
        <button class="ghost-button" type="button" :disabled="fileChange.saving" @click="closeFileChange">Cancel</button>
        <button class="primary-button" type="submit" :disabled="fileChange.saving || (fileChange.kind === 'move' && !fileChange.tree)">
          {{ fileChange.saving ? 'Saving…' : fileChange.kind === 'rename' ? 'Rename' : 'Move' }}
        </button>
      </template>
    </RequirementsDialog>

    <RequirementsConfirmDialog
      :busy="fileChange.saving"
      confirm-label="Move anyway"
      :error="fileChange.error"
      :open="Boolean(fileChange.guests)"
      :title="'Guests will see this file'"
      @close="closeFileChange"
      @confirm="submitFileChange({ confirmGuests: true })"
    >
      <p class="mb-0">
        {{ fileChange.guests?.count }} {{ fileChange.guests?.count === 1 ? 'guest' : 'guests' }} in #{{ fileChange.guests?.channelName }}
        will see {{ fileChange.file?.fileName }}.
      </p>
    </RequirementsConfirmDialog>

    <SigningRequestDialog
      v-if="isVault"
      :files="files"
      :initial-file-id="signingCreate.fileId"
      :open="signingCreate.open"
      :project-id="projectId"
      :token="token"
      @close="signingCreate.open = false"
      @created="signingCreated"
    />

    <SigningRequestDetail
      v-if="isVault"
      :open="Boolean(signingDetailId)"
      :project-id="projectId"
      :request-id="signingDetailId"
      :token="token"
      @changed="loadFiles({ quiet: true })"
      @close="signingDetailId = ''"
    />
  </section>
</template>

<style scoped>
.project-files { display: grid; gap: 0.75rem; container-type: inline-size; font-size: 0.875rem; }
.project-files__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }
/* The legacy stylesheet sizes and underlines every h3/h4 with !important. */
.project-files__title { margin: 0; padding: 0; border-bottom: 0; font-family: var(--font-display); font-size: 1.05rem !important; }
.project-files__count { margin-left: 0.25rem; color: var(--muted); font-weight: 400; }
.project-files__usage { margin-left: 0.25rem; color: var(--muted); font-family: var(--font-body, inherit); font-size: 0.8rem; font-weight: 400; }
.project-files__pending { display: grid; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.project-files__pending-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; min-height: 2.75rem; padding: 0.25rem 0.5rem 0.25rem 0.75rem; border: 1px dashed var(--line); border-radius: 0.4rem; }
.project-files__progress { display: grid; gap: 0.25rem; }
.project-files__progress progress { width: 100%; height: 0.5rem; accent-color: var(--accent); }
.project-files__conflict { margin-bottom: 0.25rem; font-size: 0.875rem; font-weight: 600; }
.project-files__choice { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; }
.project-files__choice input { flex: 0 0 auto; width: 1rem; height: 1rem; min-height: 0; }
.project-files__tag--danger .bi { color: var(--danger); }
.project-files__icon--danger:hover { color: var(--danger); }
.project-files__actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.project-files__action { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; min-height: 2.75rem; }
.project-files__note { margin: 0; color: var(--muted); }
.project-files__status { margin: 0; color: var(--ink-soft); }
.project-files__status:empty { display: none; }
.project-files__list { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
.project-files__row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 0.5rem 0.75rem; padding: 0.5rem 0.5rem 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); color: var(--ink); }
.project-files__row--focused { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.project-files__main { display: grid; gap: 0.25rem; min-width: 0; padding-block: 0.25rem; }
.project-files__identity { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; min-width: 0; }
.project-files__name { min-width: 0; overflow-wrap: anywhere; }
.project-files__version,
.project-files__tag { padding: 0.1rem 0.45rem; border-radius: 999px; background: var(--surface-soft); color: var(--ink-soft); font-size: 0.75rem; font-weight: 600; }
.project-files__description { margin: 0; color: var(--ink-soft); overflow-wrap: anywhere; }
.project-files__meta { margin: 0; color: var(--muted); font-size: 0.75rem; }
.project-files__places { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; margin: 0; padding: 0; color: var(--muted); font-size: 0.75rem; list-style: none; }
.project-files__places li { display: inline-flex; align-items: baseline; gap: 0.25rem; min-width: 0; }
.project-files__place { color: var(--accent); font-weight: 600; overflow-wrap: anywhere; }
html.dark .project-files__place { color: var(--accent-bright); }
.project-files__row-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 0.25rem; }
.project-files__toggle,
.project-files__icon { display: inline-grid; place-items: center; width: 2.75rem; height: 2.75rem; border: 0; border-radius: 0.375rem; background: transparent; color: var(--muted); }
.project-files__toggle:hover,
.project-files__icon:hover { background: var(--surface-soft); color: var(--ink); }
.project-files__detail { display: grid; grid-column: 1 / -1; gap: 0.75rem; padding: 0.75rem 0.25rem 0.25rem; border-top: 1px solid var(--line); }
.project-files__section { display: grid; gap: 0.35rem; }
.project-files__label { margin: 0; padding: 0; color: var(--muted); font-size: 0.75rem !important; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.project-files__versions,
.project-files__links { display: grid; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.project-files__version-row,
.project-files__link-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; min-height: 2.75rem; }
.project-files__version-text { display: grid; gap: 0.1rem; min-width: 0; }
.project-files__version-line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 0.5rem; }
.project-files__version-name { color: var(--ink-soft); overflow-wrap: anywhere; }
.project-files__version-actions { display: flex; align-items: center; gap: 0.25rem; }
.project-files__link-name { display: inline-flex; align-items: baseline; gap: 0.35rem; min-width: 0; }
.project-files__manage { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.project-files__destinations { display: grid; gap: 0.15rem; max-height: min(55dvh, 28rem); margin: 0; padding: 0; overflow-y: auto; border: 0; }
.project-files__destination { display: flex; align-items: center; gap: 0.5rem; min-height: 2.75rem; padding: 0.25rem 0.5rem 0.25rem calc(0.5rem + var(--depth, 0) * 1.1rem); border-radius: 0.35rem; cursor: pointer; }
.project-files__destination:hover { background: var(--surface-soft); }
.project-files__destination:has(input:checked) { background: var(--surface-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.project-files__destination:has(input:focus-visible) { outline: 0.18rem solid var(--accent); outline-offset: 0.05rem; }
.project-files__destination--current { color: var(--muted); cursor: default; }
.project-files__destination-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.project-files__delete { margin-left: auto; }
.project-files__more { justify-self: center; }
.project-files__tag { display: inline-flex; align-items: center; gap: 0.25rem; }
.project-files__tag--shared { color: var(--ink); }
.project-files__tag--editing { border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
.project-files__signing { display: grid; gap: 0.35rem; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.4rem; background: var(--surface); }
.project-files__signing-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem; }
.project-files__requests,
.project-files__signers { display: grid; gap: 0.25rem; margin: 0; padding: 0; list-style: none; }
.project-files__audience-row,
.project-files__request { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; min-height: 2.75rem; }
.project-files__picker { max-height: 16rem; }
.project-files__picker label { min-height: 2.75rem; }
.project-files__picker input { flex: 0 0 auto; width: 1rem; height: 1rem; min-height: 0; }
.project-files__picker-name { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.project-files__picker-meta { color: var(--muted); font-size: 0.75rem; white-space: nowrap; }
.project-files__action:focus-visible,
.project-files__toggle:focus-visible,
.project-files__icon:focus-visible,
.project-files__place:focus-visible { outline: 0.18rem solid var(--accent); outline-offset: 0.1rem; }

/* By the panel's width, as it sits in a drawer, a dialog and an item editor. */
@container (max-width: 36rem) {
  .project-files__row { grid-template-columns: minmax(0, 1fr); }
  .project-files__row-actions { justify-content: flex-start; }
  .project-files__delete { margin-left: 0; }
}
</style>
