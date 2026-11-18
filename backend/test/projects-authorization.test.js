import assert from 'node:assert/strict';
import test from 'node:test';

import { createInMemoryAssistantRepository } from '../src/modules/assistant/assistant.repository.js';
import { createAgentChatService } from '../src/modules/assistant/agent-chat.service.js';
import { createInMemoryAgentChatsRepository } from '../src/modules/assistant/agent-chats.repository.js';
import { createAssistantTurnQueue } from '../src/modules/assistant/assistant-turn-queue.js';
import { createInMemoryProjectsRepository } from '../src/modules/projects/projects.repository.js';
import {
  getProjectForUser,
  listProjectsForUser,
  saveProjectTreeForUser,
  updateProjectAssistantBriefForUser,
  updateProjectForUser,
} from '../src/modules/projects/projects.service.js';

const authorizedUser = {
  id: 'user-editor',
  memberships: [{ role: 'user', tenantId: 'tenant-1' }],
};
const unauthorizedUser = {
  id: 'user-outsider',
  memberships: [{ role: 'user', tenantId: 'tenant-1' }],
};
const readOnlyUser = {
  id: 'user-viewer',
  memberships: [{ role: 'user', tenantId: 'tenant-1' }],
};

function createRepository() {
  return createInMemoryProjectsRepository({
    authRepository: {
      state: {
        tenants: [{ id: 'tenant-1' }],
        users: [authorizedUser, unauthorizedUser, readOnlyUser],
      },
    },
    seed: {
      projectMemberships: {
        'project-1': [{ id: authorizedUser.id, role: 'editor' }, { id: readOnlyUser.id, role: 'viewer' }],
      },
      projects: [{
        description: 'Initial description',
        endDate: '2026-08-31',
        epics: [],
        id: 'project-1',
        name: 'Authorized Project',
        role: 'admin',
        startDate: '2026-07-01',
        status: 'Planned',
        tenantId: 'tenant-1',
      }],
    },
  });
}

test('project list and detail expose only explicitly authorized projects', async () => {
  const repository = createRepository();

  const authorizedList = await listProjectsForUser(authorizedUser, repository);
  const unauthorizedList = await listProjectsForUser(unauthorizedUser, repository);
  assert.deepEqual(authorizedList.projects.map((project) => project.id), ['project-1']);
  assert.deepEqual(unauthorizedList.projects, []);

  const detail = await getProjectForUser(authorizedUser, 'project-1', repository);
  assert.equal(detail.project.id, 'project-1');
  await assert.rejects(
    getProjectForUser(unauthorizedUser, 'project-1', repository),
    (error) => error.statusCode === 404,
  );
});

test('project update, tree replacement, and assistant brief require plan-edit capability', async () => {
  const repository = createRepository();
  const assistantRepository = createInMemoryAssistantRepository();
  const initialProject = await repository.getProjectDetail({ projectId: 'project-1', tenantId: 'tenant-1' });
  const update = {
    description: 'Updated description',
    endDate: '2026-09-30',
    name: 'Updated Project',
    startDate: '2026-07-01',
    status: 'In Progress',
    expectedUpdatedAt: initialProject.updatedAt,
  };

  await assert.rejects(
    updateProjectForUser(unauthorizedUser, 'project-1', update, repository),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    saveProjectTreeForUser(unauthorizedUser, 'project-1', { epics: [] }, repository),
    (error) => error.statusCode === 404,
  );
  await assert.rejects(
    updateProjectAssistantBriefForUser(
      unauthorizedUser,
      'project-1',
      { name: 'Hidden brief' },
      repository,
      assistantRepository,
    ),
    (error) => error.statusCode === 404,
  );

  const updated = await updateProjectForUser(authorizedUser, 'project-1', update, repository);
  assert.equal(updated.project.name, 'Updated Project');
  const tree = await saveProjectTreeForUser(authorizedUser, 'project-1', { epics: [], expectedUpdatedAt: updated.project.updatedAt }, repository);
  assert.deepEqual(tree.project.epics, []);
  const brief = await updateProjectAssistantBriefForUser(
    authorizedUser,
    'project-1',
    { name: 'Authorized brief' },
    repository,
    assistantRepository,
  );
  assert.equal(brief.project.assistantState.brief.name, 'Authorized brief');
});


function createChatService(projectRepository, requests = []) {
  return createAgentChatService({
    chatsRepository: createInMemoryAgentChatsRepository(),
    modelResolver: async () => { throw new Error('No model in this test.'); },
    openSession: async () => ({
      api: {
        async request(method, path, { body } = {}) {
          requests.push({ body, method, path });
          return { item: { id: body?.item?.id ?? 'created', name: body?.item?.name } };
        },
      },
      close: async () => {},
    }),
    projectRepository,
    turnQueue: createAssistantTurnQueue(),
  });
}

test('assistant chats on a project require project read access', async () => {
  const service = createChatService(createRepository());
  await assert.rejects(service.createChat({ projectId: 'project-1', user: unauthorizedUser }), (error) => [403, 404].includes(error.statusCode));
  const { chat } = await service.createChat({ projectId: 'project-1', user: readOnlyUser });
  assert.equal(chat.projectId, 'project-1');
});

test('staging and applying proposed work requires plan-edit, and applies the branch through the API as the user', async () => {
  const requests = [];
  const service = createChatService(createRepository(), requests);
  const epics = [{ description: 'Card payments', id: 'epic-new', name: 'Checkout', status: 'Not Started', stories: [{ description: 'Pay by card', id: 'story-new', name: 'Pay by card', sourceClarificationIds: ['topic-1'], status: 'Not Started' }] }];
  await assert.rejects(service.stageWorkItems({ epics, projectId: 'project-1', user: readOnlyUser }), (error) => [403, 404].includes(error.statusCode));

  const staged = await service.stageWorkItems({ epics, message: 'Proposed work from the plan.', projectId: 'project-1', title: 'Plan v1', user: authorizedUser });
  assert.equal(staged.actions.length, 1);
  assert.equal(staged.actions[0].targetId, 'epic-new');
  const { chat } = await service.getChat({ chatId: staged.session.id, user: authorizedUser });
  const proposal = chat.messages.at(-1).proposal;
  assert.equal(proposal.status, 'pending');

  const applied = await service.resolveProposal({ chatId: chat.id, input: { decision: 'apply', proposalId: proposal.id }, user: authorizedUser });
  assert.equal(applied.chat.messages.at(-1).proposal.status, 'applied');
  assert.deepEqual(requests.map((entry) => [entry.method, entry.path, entry.body.itemType, entry.body.parentId]), [
    ['POST', '/api/projects/project-1/items', 'epic', null],
    ['POST', '/api/projects/project-1/items', 'story', 'epic-new'],
  ]);
  assert.deepEqual(requests[1].body.item.sourceClarificationIds, ['topic-1']);
  await assert.rejects(service.resolveProposal({ chatId: chat.id, input: { decision: 'apply', proposalId: proposal.id }, user: authorizedUser }), (error) => error.statusCode === 409);
});
