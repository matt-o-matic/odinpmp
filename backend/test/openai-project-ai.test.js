import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAiProjectAiService } from '../src/lib/ai/openai-project-ai.js';

function createClientStub(sequence = [], requests = []) {
  let index = 0;
  return {
    chat: {
      completions: {
        async create() {
          throw new Error('chat.completions.create should not be used.');
        },
      },
    },
    responses: {
      async create(request) {
        requests.push(request);
        const step = sequence[index++];
        if (!step) {
          throw new Error('Unexpected Responses API call.');
        }
        if (step.error) {
          throw step.error;
        }
        return {
          id: `response-${index}`,
          output_text: JSON.stringify(step.output),
          status: 'completed',
        };
      },
    },
  };
}

test('openai project AI uses Responses API for structured generators and repairs invalid work-item statuses', async () => {
  const requests = [];
  const client = createClientStub([
    {
      output: {
        epics: [
          {
            description: 'Generated epic',
            name: 'Execution Plan',
            status: 'Blocked',
            stories: [
              {
                description: 'Generated story',
                name: 'Generated Story',
                status: 'Blocked',
                tasks: [],
              },
            ],
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
            status: 'Not Started',
            stories: [
              {
                description: 'Generated story',
                name: 'Generated Story',
                status: 'Not Started',
                tasks: [],
              },
            ],
          },
        ],
      },
    },
  ], requests);

  const service = createOpenAiProjectAiService({
    apiKey: 'test-key',
    client,
    model: 'gpt-5.5',
  });

  const result = await service.generateStructure({
    allowedWorkItemStatuses: ['Not Started', 'In Progress', 'Completed'],
    model: 'gpt-5.5',
    project: {
      description: 'Rebuild the Ledger reporting tool for Northwind.',
      epics: [],
      name: 'Ledger Reporter Rebuild',
      status: 'Planned',
    },
  });

  assert.equal(result.provider, 'openai');
  assert.equal(result.epics[0].status, 'Not Started');
  assert.equal(requests.length, 2);
  assert.match(requests[1].input.at(-1)?.content?.[0]?.text ?? '', /Blocked/);
});

test('openai project AI uses Responses API for suggestion arrays', async () => {
  const client = createClientStub([
    {
      output: {
        suggestions: [
          '# Option 1\n\nSharper plan.',
          '# Option 2\n\nAlternative framing.',
          '# Option 3\n\nOperational rewrite.',
        ],
      },
    },
  ]);

  const service = createOpenAiProjectAiService({
    apiKey: 'test-key',
    client,
    model: 'gpt-5.5',
  });

  const result = await service.enhanceDescription({
    description: 'Rebuild the Ledger reporting tool for Northwind.',
    model: 'gpt-5.5',
    project: {
      description: 'Rebuild the Ledger reporting tool for Northwind.',
      name: 'Ledger Reporter Rebuild',
    },
  });

  assert.equal(result.provider, 'openai');
  assert.equal(result.suggestions.length, 3);
  assert.match(result.suggestions[0], /Option 1/);
});

test('openai project AI uses Responses API for project analysis', async () => {
  const client = createClientStub([
    {
      output: {
        analysis: '- Risk: requirements drift.\n- Next step: confirm scope.',
      },
    },
  ]);

  const service = createOpenAiProjectAiService({
    apiKey: 'test-key',
    client,
    model: 'gpt-5.5',
  });

  const result = await service.analyzeProject({
    model: 'gpt-5.5',
    project: {
      description: 'Rebuild the Ledger reporting tool for Northwind.',
      epics: [],
      name: 'Ledger Reporter Rebuild',
      status: 'Planned',
    },
  });

  assert.equal(result.provider, 'openai');
  assert.match(result.analysis, /requirements drift/);
});

test('openai project AI sends the reasoning effort it is given', async () => {
  const requests = [];
  const client = createClientStub([
    { output: { analysis: '- Risk: none.' } },
    { output: { analysis: '- Risk: none.' } },
  ], requests);
  const service = createOpenAiProjectAiService({ apiKey: 'test-key', client, model: 'gpt-5.5' });
  const project = { description: '', epics: [], name: 'Effort check', status: 'Planned' };

  await service.analyzeProject({ project, reasoningEffort: 'high' });
  await service.analyzeProject({ project, reasoningEffort: 'none' });
  assert.deepEqual(requests.map((request) => request.reasoning), [{ effort: 'high' }, undefined]);
});
