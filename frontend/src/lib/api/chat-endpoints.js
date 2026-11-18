// Odin Chat's API: the sidebar and the Chat badge's totals, Mentions, Threads, and direct
// messages with their posts, files and live stream, under /api/chat. Spread into the app's
// API client (client.js), so calls share its working modes.

/**
 * `request(path, options)` and `subscribe(path, options)` are the client's own; `segment` encodes
 * one path segment.
 */
export function chatEndpoints({ request, segment, subscribe }) {
  const C = (conversationId, suffix = '') => `/api/chat/conversations/${segment(conversationId)}${suffix}`;
  const query = (values) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value) search.set(key, String(value));
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  return {
    async getChatSidebar(token) {
      return (await request('/api/chat/sidebar', { token })).data;
    },
    async getChatUnread(token) {
      return (await request('/api/chat/unread', { token })).data;
    },
    async listChatMentions({ before = '' } = {}, token) {
      return (await request(`/api/chat/mentions${query({ before })}`, { token })).data;
    },
    async listChatThreads(token) {
      return (await request('/api/chat/threads', { token })).data;
    },
    async listDirectMessagePeople(token) {
      return (await request('/api/chat/people', { token })).data;
    },
    async startDirectConversation(memberIds, token) {
      return (await request('/api/chat/conversations', { body: { memberIds }, method: 'POST', token })).data;
    },
    async getDirectConversation(conversationId, token) {
      return (await request(C(conversationId), { token })).data;
    },
    async markDirectConversationRead(conversationId, token) {
      return (await request(C(conversationId, '/read'), { body: {}, method: 'POST', token })).data;
    },
    async listDirectMentionables(conversationId, token) {
      return (await request(C(conversationId, '/mentionables'), { token })).data;
    },
    async listDirectPosts(conversationId, { before = '', limit = 0 } = {}, token) {
      return (await request(C(conversationId, `/posts${query({ before, limit })}`), { token })).data;
    },
    async createDirectPost(conversationId, payload, token) {
      return (await request(C(conversationId, '/posts'), { body: payload, method: 'POST', token })).data;
    },
    async updateDirectPost(conversationId, postId, payload, token) {
      return (await request(C(conversationId, `/posts/${segment(postId)}`), { body: payload, method: 'PATCH', token })).data;
    },
    async deleteDirectPost(conversationId, postId, token) {
      return (await request(C(conversationId, `/posts/${segment(postId)}`), { method: 'DELETE', token })).data;
    },
    async setDirectPostReaction(conversationId, postId, payload, token) {
      return (await request(C(conversationId, `/posts/${segment(postId)}/reactions`), { body: payload, method: 'PUT', token })).data;
    },
    async voteDirectPoll(conversationId, postId, answer, token) {
      return (await request(C(conversationId, `/posts/${segment(postId)}/poll/vote`), { body: { answer }, method: 'PUT', token })).data;
    },
    async closeDirectPoll(conversationId, postId, token) {
      return (await request(C(conversationId, `/posts/${segment(postId)}/poll/close`), { body: {}, method: 'POST', token })).data;
    },
    async getDirectFileStorage(conversationId, token) {
      return (await request(C(conversationId, '/file-storage'), { token })).data;
    },
    async listDirectFiles(conversationId, token) {
      return (await request(C(conversationId, '/files'), { token })).data;
    },
    async getDirectFileDownloadUrl(conversationId, fileId, { inline = false, version = null } = {}, token) {
      return (await request(C(conversationId, `/files/${segment(fileId)}/download-url${query({ disposition: inline ? 'inline' : '', version })}`), { token })).data;
    },
    async getDirectFilePreviewUrl(conversationId, fileId, { version = null } = {}, token) {
      return (await request(C(conversationId, `/files/${segment(fileId)}/preview-url${query({ version })}`), { token })).data;
    },
    async startDirectUpload(conversationId, payload, token) {
      return (await request(C(conversationId, '/uploads'), { body: payload, method: 'POST', token })).data;
    },
    async getDirectUpload(conversationId, uploadId, token) {
      return (await request(C(conversationId, `/uploads/${segment(uploadId)}`), { token })).data;
    },
    async signDirectUploadParts(conversationId, uploadId, partNumbers, token) {
      return (await request(C(conversationId, `/uploads/${segment(uploadId)}/parts`), { body: { partNumbers }, method: 'POST', token })).data;
    },
    async completeDirectUpload(conversationId, uploadId, token) {
      return (await request(C(conversationId, `/uploads/${segment(uploadId)}/complete`), { body: {}, method: 'POST', token })).data;
    },
    async cancelDirectUpload(conversationId, uploadId, token) {
      return (await request(C(conversationId, `/uploads/${segment(uploadId)}`), { method: 'DELETE', token })).data;
    },
    // `direct-message.updated` events ({ area, conversationId }) for one conversation.
    subscribeToDirectConversationEvents(conversationId, token, { onClose, onError, onEvent } = {}) {
      return subscribe(C(conversationId, '/events'), { method: 'GET', onClose, onError, onEvent, token });
    },
  };
}
