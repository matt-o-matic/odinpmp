import { createAgentChatService } from '../../src/modules/assistant/agent-chat.service.js';
import { createInMemoryAgentChatsRepository } from '../../src/modules/assistant/agent-chats.repository.js';
import { createAssistantTurnQueue } from '../../src/modules/assistant/assistant-turn-queue.js';
import { projectItemCreateSchema } from '../../src/modules/projects/projects.schema.js';
import { createProjectItemForUser } from '../../src/modules/projects/projects.service.js';

// An assistant chat service for service-level tests and evals with no HTTP server: applying a
// staged proposal creates items through the projects service directly, as the item route does.
export function createInProcessAgentChats({ chatsRepository = createInMemoryAgentChatsRepository(), projectRepository }) {
  const service = createAgentChatService({
    chatsRepository,
    modelResolver: async () => { throw new Error('No model in this setup.'); },
    openSession: async ({ user }) => ({
      api: {
        async request(method, path, { body } = {}) {
          const match = path.match(/^\/api\/projects\/([^/]+)\/items$/);
          if (method === 'POST' && match) return createProjectItemForUser(user, decodeURIComponent(match[1]), projectItemCreateSchema.parse(body), projectRepository);
          throw new Error(`The in-process API does not handle ${method} ${path}.`);
        },
      },
      close: async () => {},
    }),
    projectRepository,
    turnQueue: createAssistantTurnQueue(),
  });

  // Applies every pending item of the proposal cards in a chat.
  async function applyAll({ chatId, user }) {
    const { chat } = await service.getChat({ chatId, user });
    for (const message of chat.messages) {
      if (message.proposal?.items.some((item) => item.status === 'pending')) {
        await service.resolveProposal({ chatId, input: { decision: 'apply', proposalId: message.proposal.id }, user });
      }
    }
  }

  return { applyAll, chatsRepository, service };
}
