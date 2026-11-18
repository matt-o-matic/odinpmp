import assert from 'node:assert/strict';
import test from 'node:test';

import { createTenantAwareProjectAiService } from '../src/lib/ai/tenant-aware-project-ai.js';

function createResponsesClient(sequence = []) {
  let index = 0;
  return {
    responses: {
      async create() {
        const step = sequence[index++];
        if (!step) {
          throw new Error('Unexpected create call.');
        }
        if (step.error) {
          throw step.error;
        }
        const text = JSON.stringify(step.output);
        return {
          output: [{
            content: [{
              text,
              type: 'output_text',
            }],
            role: 'assistant',
            type: 'message',
          }],
          output_text: text,
          status: 'completed',
        };
      },
    },
  };
}

test('tenant-aware project AI validates generated work-item statuses against tenant status definitions', async () => {
  const client = createResponsesClient([
    {
      output: {
        epics: [
          {
            description: 'Generated epic',
            name: 'Execution Plan',
            status: 'Not Started',
            stories: [],
          },
        ],
      },
    },
    {
      output: {
        epics: [
          {
            description: 'Generated epic',
            name: 'Execution Plan',
            status: 'Queued',
            stories: [],
          },
        ],
      },
    },
  ]);

  const service = createTenantAwareProjectAiService({
    defaultApiKey: 'test-key',
    defaultModel: 'gpt-5.6-luna',
    openAiFactory: () => client,
    tenantsRepository: {
      async getOpenAiConfig({ defaults }) {
        return {
          ...defaults,
          openai_key: 'test-key',
          valid_config: true,
        };
      },
      async listStatusDefinitions() {
        return [
          { name: 'Queued' },
        ];
      },
    },
  });

  const result = await service.generateStructure({
    project: {
      description: 'Rebuild the Ledger reporting tool for Northwind.',
      epics: [],
      name: 'Ledger Reporter Rebuild',
      status: 'Planned',
    },
    tenantId: 'tenant-acme',
    user: { id: 'user-grace' },
  });

  assert.equal(result.epics[0].status, 'Queued');
});
