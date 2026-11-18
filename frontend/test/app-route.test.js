import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('App route handling opens the assistant on a blank draft, creating no chat until the first message', async () => {
  const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  assert.match(source, /if \(!assistantStore\.state\.chat\) assistantStore\.startDraft\(\{\}\);/);
  assert.match(source, /await assistantStore\.openForProject\(\{ fresh, projectId \}\)/);
});

test('App route handling starts fresh when a linked chat no longer exists', async () => {
  const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8');
  assert.match(source, /if \(error\?\.status === 404\) \{\s*assistantStore\.clearError\(\);\s*assistantStore\.startDraft\(\{\}\);\s*await replaceAssistantRoute\(\{ open: true \}\);\s*\}/);
});

test('main bootstrap mounts the app before auth restore settles', async () => {
  const source = await readFile(
    new URL('../src/main.js', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /createApp\(App\)\.use\(router\)\.mount\('#app'\);\s*void authSession\.restore\(\)\.catch\(\(\) => null\);/s,
  );
});
