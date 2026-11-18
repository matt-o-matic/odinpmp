// The channel screens' API for a direct message: the conversation, its posts and the file
// viewer (components/channels, FilePreviewDialog) call the app's API client by method name, as
// the guest view's API does (lib/guests/guest-api.js). This offers the same names with the same
// arguments, mapped to /api/chat/conversations: the project and channel ids those methods take
// are both the conversation's.
import { ApiError } from '../api/client.js';

function unsupported() {
  throw new ApiError('Files in a conversation upload in parts.', { data: { details: { code: 'large_uploads_unavailable' } }, status: 503 });
}

function methodsFor(client) {
  return {
    markChannelRead: (_projectId, conversationId, token) => client.markDirectConversationRead(conversationId, token),
    listChannelMentionables: (_projectId, conversationId, token) => client.listDirectMentionables(conversationId, token),
    listChannelPosts: (_projectId, conversationId, options, token) => client.listDirectPosts(conversationId, options, token),
    createChannelPost: (_projectId, conversationId, payload, token) => client.createDirectPost(conversationId, payload, token),
    updatePost: (conversationId, postId, payload, token) => client.updateDirectPost(conversationId, postId, payload, token),
    deletePost: (conversationId, postId, token) => client.deleteDirectPost(conversationId, postId, token),
    setPostReaction: (conversationId, postId, payload, token) => client.setDirectPostReaction(conversationId, postId, payload, token),
    votePoll: (conversationId, postId, answer, token) => client.voteDirectPoll(conversationId, postId, answer, token),
    closePoll: (conversationId, postId, token) => client.closeDirectPoll(conversationId, postId, token),
    getFileStorage: (conversationId, token) => client.getDirectFileStorage(conversationId, token),
    startFileUpload: (conversationId, payload, token) => client.startDirectUpload(conversationId, payload, token),
    getFileUpload: (conversationId, uploadId, token) => client.getDirectUpload(conversationId, uploadId, token),
    signFileUploadParts: (conversationId, uploadId, partNumbers, token) => client.signDirectUploadParts(conversationId, uploadId, partNumbers, token),
    completeFileUpload: (conversationId, uploadId, _payload, token) => client.completeDirectUpload(conversationId, uploadId, token),
    cancelFileUpload: (conversationId, uploadId, token) => client.cancelDirectUpload(conversationId, uploadId, token),
    getFileDownloadUrl: (conversationId, fileId, options, token) => client.getDirectFileDownloadUrl(conversationId, fileId, options, token),
    getFilePreviewUrl: (conversationId, fileId, options, token) => client.getDirectFilePreviewUrl(conversationId, fileId, options, token),
    uploadProjectFile: unsupported,
    uploadFileVersion: unsupported,
  };
}

/** The channel screens' API for direct messages, built on the app's client. */
export function createDirectMessageApi(client) {
  const api = {
    ...methodsFor(client),
    baseUrl: client.baseUrl,
    clientId: client.clientId,
    resolveTransferUrl: (url) => client.resolveTransferUrl(url),
  };
  api.passive = { ...api, ...methodsFor(client.passive ?? client) };
  api.passive.passive = api.passive;
  return api;
}
