import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

import {
  AiStructuredOutputValidationError,
  generateValidatedStructuredOutput,
} from '../src/lib/ai/responses-structured-output.js';

const statusSchema = z.object({
  name: z.string(),
  status: z.string(),
});

function createStubClient(sequence = [], requests = []) {
  let index = 0;
  return {
    responses: {
      async create(request) {
        requests.push(request);
        const step = sequence[index++];
        if (!step) {
          throw new Error('Unexpected create call.');
        }
        if (step.error) {
          throw step.error;
        }
        const outputText = step.rawText ?? JSON.stringify(step.output ?? {});
        return {
          id: step.id ?? `resp-${index}`,
          incomplete_details: step.incompleteReason ? { reason: step.incompleteReason } : null,
          output: [{
            content: [{
              text: outputText,
              type: 'output_text',
            }],
            role: 'assistant',
            type: 'message',
          }],
          output_text: outputText,
          status: step.status ?? (step.incompleteReason ? 'incomplete' : 'completed'),
        };
      },
    },
  };
}

test('generateValidatedStructuredOutput retries semantic validation failures with deterministic repair context', async () => {
  const requests = [];
  const client = createStubClient([
    {
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned / Discovery Required',
      },
    },
    {
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned',
      },
    },
  ], requests);

  const result = await generateValidatedStructuredOutput({
    client,
    input: [{
      content: [{ text: 'Create a project brief.', type: 'input_text' }],
      role: 'user',
      type: 'message',
    }],
    instructions: 'Return the requested schema.',
    model: 'gpt-5.5',
    operationName: 'assistant.intake',
    schema: statusSchema,
    schemaName: 'assistant_intake_dialogue',
    validator(output) {
      if (output.status === 'Planned') {
        return [];
      }
      return [{
        allowedValues: ['Planned', 'In Progress', 'At Risk', 'Review', 'Completed', 'Archived'],
        message: 'Status must be one of the canonical project statuses.',
        path: ['status'],
        received: output.status,
      }];
    },
  });

  assert.equal(result.status, 'Planned');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].previous_response_id, 'resp-1');

  const repairPrompt = requests[1].input.at(-1)?.content?.[0]?.text ?? '';
  assert.match(repairPrompt, /status/i);
  assert.match(repairPrompt, /Planned \/ Discovery Required/);
  assert.match(repairPrompt, /canonical project statuses/i);
});

test('generateValidatedStructuredOutput salvages fenced JSON without spending a repair attempt', async () => {
  const requests = [];
  const client = createStubClient([
    {
      rawText: '```json\n{"name":"Ledger Reporter Rebuild","status":"Planned"}\n```',
    },
  ], requests);

  const result = await generateValidatedStructuredOutput({
    client,
    input: [{
      content: [{ text: 'Create a project brief.', type: 'input_text' }],
      role: 'user',
      type: 'message',
    }],
    instructions: 'Return the requested schema.',
    model: 'gpt-5.5',
    operationName: 'assistant.intake',
    schema: statusSchema,
    schemaName: 'assistant_intake_dialogue',
  });

  assert.equal(result.status, 'Planned');
  assert.equal(requests.length, 1);
});

test('generateValidatedStructuredOutput resumes after incomplete structured output and keeps response chaining', async () => {
  const requests = [];
  const client = createStubClient([
    {
      id: 'resp-incomplete-1',
      incompleteReason: 'max_output_tokens',
      rawText: '{"name":"Ledger Reporter Rebuild"',
    },
    {
      id: 'resp-complete-2',
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned',
      },
    },
  ], requests);

  const result = await generateValidatedStructuredOutput({
    client,
    input: [{
      content: [{ text: 'Create a project brief.', type: 'input_text' }],
      role: 'user',
      type: 'message',
    }],
    instructions: 'Return the requested schema.',
    model: 'gpt-5.5',
    operationName: 'assistant.intake',
    schema: statusSchema,
    schemaName: 'assistant_intake_dialogue',
  });

  assert.equal(result.status, 'Planned');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].previous_response_id, 'resp-incomplete-1');

  const repairPrompt = requests[1].input.at(-1)?.content?.[0]?.text ?? '';
  assert.match(repairPrompt, /continue correcting/i);
});

test('generateValidatedStructuredOutput falls back to a fresh request when previous_response_id is no longer available', async () => {
  const requests = [];
  const client = createStubClient([
    {
      id: 'resp-1',
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned / Discovery Required',
      },
    },
    {
      error: new Error("400 Previous response with id 'resp-1' not found."),
    },
    {
      id: 'resp-2',
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned',
      },
    },
  ], requests);

  const result = await generateValidatedStructuredOutput({
    client,
    input: [{
      content: [{ text: 'Create a project brief.', type: 'input_text' }],
      role: 'user',
      type: 'message',
    }],
    instructions: 'Return the requested schema.',
    model: 'gpt-5.5',
    operationName: 'assistant.intake',
    schema: statusSchema,
    schemaName: 'assistant_intake_dialogue',
    validator(output) {
      if (output.status === 'Planned') {
        return [];
      }
      return [{
        allowedValues: ['Planned'],
        message: 'Status must be canonical.',
        path: ['status'],
        received: output.status,
      }];
    },
  });

  assert.equal(result.status, 'Planned');
  assert.equal(requests.length, 3);
  assert.equal(requests[1].previous_response_id, 'resp-1');
  assert.equal('previous_response_id' in requests[2], false);
  assert.equal(requests[2].input[0].role, 'user');
  assert.match(requests[2].input.at(-1)?.content?.[0]?.text ?? '', /status must be canonical/i);
});

test('generateValidatedStructuredOutput fails loudly after bounded retries are exhausted', async () => {
  const client = createStubClient([
    {
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned / Discovery Required',
      },
    },
    {
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned / Discovery Required',
      },
    },
  ]);

  await assert.rejects(
    () => generateValidatedStructuredOutput({
      client,
      input: [{
        content: [{ text: 'Create a project brief.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      }],
      instructions: 'Return the requested schema.',
      maxRepairAttempts: 1,
      model: 'gpt-5.5',
      operationName: 'assistant.intake',
      schema: statusSchema,
      schemaName: 'assistant_intake_dialogue',
      validator(output) {
        return [{
          allowedValues: ['Planned'],
          message: 'Status must be canonical.',
          path: ['status'],
          received: output.status,
        }];
      },
    }),
    (error) => {
      assert.ok(error instanceof AiStructuredOutputValidationError);
      assert.equal(error.statusCode, 502);
      assert.equal(error.details.attemptCount, 2);
      assert.equal(error.details.operation, 'assistant.intake');
      assert.equal(error.details.issues[0].path, 'status');
      return true;
    },
  );
});

test('generateValidatedStructuredOutput sends reasoning as an object for GPT-5 models', async () => {
  const requests = [];
  const client = createStubClient([
    {
      output: {
        name: 'Ledger Reporter Rebuild',
        status: 'Planned',
      },
    },
  ], requests);

  const result = await generateValidatedStructuredOutput({
    client,
    input: [{
      content: [{ text: 'Create a project brief.', type: 'input_text' }],
      role: 'user',
      type: 'message',
    }],
    instructions: 'Return the requested schema.',
    model: 'gpt-5.5',
    operationName: 'assistant.intake',
    reasoningEffort: 'medium',
    schema: statusSchema,
    schemaName: 'assistant_intake_dialogue',
  });

  assert.equal(result.status, 'Planned');
  assert.deepEqual(requests[0].reasoning, { effort: 'medium' });
});
