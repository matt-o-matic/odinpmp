import assert from 'node:assert/strict';
import test from 'node:test';

import { canMoveFile, fileLocationKey, fileTreeQuery, fileTreeTrail, guestsWillSee, moveDestinations, treeChannels } from '../src/lib/projects/file-tree.js';

const tree = {
  canManage: true,
  channels: [
    { archived: false, fileCount: 1, folders: [], guestCount: 2, id: 'ch-client', isGeneral: false, name: 'Client' },
    { archived: true, fileCount: 0, folders: [], guestCount: 0, id: 'ch-old', isGeneral: false, name: 'Archive me' },
    {
      archived: false, fileCount: 3, guestCount: 0, id: 'ch-general', isGeneral: true, name: 'General',
      folders: [
        { fileCount: 1, id: 'f-contracts', name: 'Contracts', parentId: null },
        { fileCount: 2, id: 'f-signed', name: 'Signed', parentId: 'f-contracts' },
        { fileCount: 0, id: 'f-admin', name: 'Admin', parentId: null },
      ],
    },
  ],
  project: { id: 'p1', name: 'Northwind' },
  rootFileCount: 4,
};

test('channels show as folders: General first, then by name, archived last', () => {
  assert.deepEqual(treeChannels(tree).map(({ id }) => id), ['ch-general', 'ch-client', 'ch-old']);
  assert.deepEqual(treeChannels(null), []);
});

test('the trail runs from the project through the channel to the folder', () => {
  assert.deepEqual(fileTreeTrail(tree, { channelId: 'ch-general', folderId: 'f-signed' }).map(({ kind, label }) => `${kind}:${label}`), ['project:Northwind', 'channel:#General', 'folder:Contracts', 'folder:Signed']);
  assert.deepEqual(fileTreeTrail(tree).map(({ label }) => label), ['Northwind']);
  assert.deepEqual(fileTreeTrail(tree, { channelId: 'gone' }).map(({ label }) => label), ['Northwind']);
});

test('a file can move to the project, any open channel, or any folder, in tree order', () => {
  const options = moveDestinations(tree, { folderId: 'f-contracts', targetId: 'ch-general', targetType: 'channel' });
  assert.deepEqual(options.map(({ path }) => path), ['Northwind', '#General', '#General / Admin', '#General / Contracts', '#General / Contracts / Signed', '#Client']);
  assert.deepEqual(options.map(({ depth }) => depth), [0, 1, 2, 2, 3, 1]);
  assert.equal(options.find(({ current }) => current).key, 'folder:f-contracts');
  assert.deepEqual(options.find(({ key }) => key === 'folder:f-signed').destination, { channelId: 'ch-general', folderId: 'f-signed', kind: 'channel' });
  assert.equal(options.find(({ key }) => key === 'channel:ch-client').guestCount, 2);
  assert.equal(options.some(({ key }) => key === 'channel:ch-old'), false);
});

test('where a file is, and which files can move', () => {
  assert.equal(fileLocationKey({ targetType: 'project' }), 'project');
  assert.equal(fileLocationKey({ folderId: null, targetId: 'c', targetType: 'channel' }), 'channel:c');
  assert.equal(fileLocationKey({ targetType: 'epic' }), '');
  assert.equal(canMoveFile({ targetType: 'channel' }), true);
  assert.equal(canMoveFile({ targetType: 'task' }), false);
});

test('a refused move names how many guests would see the file', () => {
  assert.deepEqual(guestsWillSee({ data: { details: { code: 'guests_will_see', guestCount: 3 } } }), { guestCount: 3 });
  assert.equal(guestsWillSee({ data: { details: { code: 'file_name_taken' } } }), null);
});

test('the location lives in its own query keys, and the rest of the query stays', () => {
  assert.deepEqual(fileTreeQuery({ file: 'x', filesFolder: 'old' }, { channelId: 'c1', folderId: 'f1' }), { file: 'x', filesChannel: 'c1', filesFolder: 'f1' });
  assert.deepEqual(fileTreeQuery({ filesChannel: 'c1', filesFolder: 'f1' }, {}), { filesChannel: undefined, filesFolder: undefined });
});
