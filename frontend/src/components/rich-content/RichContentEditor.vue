<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue';
import { EditorContent, useEditor } from '@tiptap/vue-3';
import { mergeAttributes } from '@tiptap/core';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Underline from '@tiptap/extension-underline';

import { apiClient } from '../../lib/auth/index.js';
import { filterMentionables } from '../../lib/requirements/mention-tokens.js';
import { commentHtmlToMarkdown, hasMarkdownTable, mentionKind, renderCommentHtml, tableHeaderCells } from '../../lib/rich-content/comment-markdown.js';
import {
  editorHtmlToStoredMarkdown,
  getFileContentUrl,
  richTextToEditorHtml,
  serializeRichHtml,
} from '../../lib/rich-content/html.js';
import { useOverlayScrollLock } from '../../lib/ui/overlay-scroll-lock.js';
import EmojiPicker from '../channels/EmojiPicker.vue';

const props = defineProps({
  compact: {
    default: false,
    type: Boolean,
  },
  editable: {
    default: true,
    type: Boolean,
  },
  // Id of the visible label; it names the editable text box for assistive technology.
  labelledBy: {
    default: '',
    type: String,
  },
  minHeight: {
    default: '',
    type: String,
  },
  modelValue: {
    default: '',
    type: String,
  },
  placeholder: {
    default: 'Write here...',
    type: String,
  },
  // 'html', 'markdown', or 'comment' (Markdown with inline tags, lib/rich-content/comment-markdown.js).
  storageFormat: {
    default: 'html',
    type: String,
  },
  // 'comment': one row of text tools (style, bold, italic, underline, code, lists, quote,
  // link, table) and no images or AI. Row and column tools show while the cursor is in a table.
  toolset: {
    default: 'full',
    type: String,
  },
  // 'focus': the tools show only while the editor or its tools have focus.
  toolbarMode: {
    default: 'always',
    type: String,
  },
  // Loads the people who can be tagged: async () => [{ ref, name, detail }]. Without it, tags
  // come from the project's mentionable users.
  mentionables: {
    default: null,
    type: Function,
  },
  // Enter outside lists, quotes and code emits submit; Shift+Enter starts a new line.
  submitOnEnter: {
    default: false,
    type: Boolean,
  },
  projectId: {
    default: '',
    type: String,
  },
  targetId: {
    default: '',
    type: String,
  },
  targetType: {
    default: 'project',
    type: String,
  },
  token: {
    default: '',
    type: String,
  },
  title: {
    default: '',
    type: String,
  },
});

const emit = defineEmits(['busy', 'submit', 'update:modelValue']);

const uid = useId();
const root = ref(null);
const fileInput = ref(null);
const linkInput = ref(null);
const linkEditing = ref(false);
const linkDraft = ref('');
const linkError = ref('');
const isComment = computed(() => props.toolset === 'comment');
// toolbarMode 'focus': the tools show while focus is inside the editor. Leaving by pointer
// waits until the press ends, so a button below does not move between press and release.
const toolsShown = ref(props.toolbarMode !== 'focus');
// The emoji button's picker. It goes in where the cursor was when the button was pressed, and
// the tools stay up while it is open.
const emoji = reactive({ anchor: null, open: false, selection: null });
let pointerHeld = false;
let hideAfterPointer = false;

function hideToolsIfFocusLeft() {
  if (props.toolbarMode !== 'focus' || linkEditing.value || emoji.open) return;
  if (typeof document !== 'undefined' && root.value?.contains(document.activeElement)) return;
  toolsShown.value = false;
}

function onFocusIn() {
  if (props.toolbarMode === 'focus') toolsShown.value = true;
}

function onFocusOut() {
  if (props.toolbarMode !== 'focus') return;
  if (pointerHeld) {
    hideAfterPointer = true;
    return;
  }
  setTimeout(hideToolsIfFocusLeft, 0);
}

function onPointerDown() {
  pointerHeld = true;
}

function onPointerUp() {
  pointerHeld = false;
  if (!hideAfterPointer) return;
  hideAfterPointer = false;
  // The click that follows the release runs first.
  setTimeout(hideToolsIfFocusLeft, 0);
}

onMounted(() => {
  if (props.toolbarMode !== 'focus' || typeof document === 'undefined') return;
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('pointercancel', onPointerUp, true);
});

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return;
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('pointerup', onPointerUp, true);
  document.removeEventListener('pointercancel', onPointerUp, true);
});
const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl';
const editorError = ref('');
const aiError = ref('');
const aiIndex = ref(0);
const aiMenuOpen = ref(false);
const aiModalOpen = ref(false);
const aiSuggestions = ref([]);
const aiWorking = ref(false);
const aiSelectionRange = ref({ from: 0, hasSelection: false, to: 0 });
const apiBaseUrl = computed(() => apiClient.baseUrl);
const hasTargetContext = computed(() => Boolean(props.token && props.projectId && props.targetId));

useOverlayScrollLock(aiModalOpen);

function buildEditorMarkup(html) {
  if (props.storageFormat === 'comment') return renderCommentHtml(html);
  return richTextToEditorHtml(html, apiBaseUrl.value, {
    storageFormat: props.storageFormat,
  });
}

function buildPersistedMarkup(html) {
  if (props.storageFormat === 'comment') return commentHtmlToMarkdown(html);
  if (props.storageFormat === 'markdown') {
    return editorHtmlToStoredMarkdown(html, apiBaseUrl.value);
  }

  return serializeRichHtml(html, apiBaseUrl.value);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

let peopleLoad = null;
// A different `mentionables` (a channel's Odin switch changed, say) is asked again on the next @.
watch(() => props.mentionables, () => { peopleLoad = null; });
// Set while the @ list is open; it takes Enter, Tab, arrows and Escape.
let mentionListOpen = false;

async function mentionItems(query) {
  if (props.mentionables) {
    // Loaded once per editor; a failed load is retried on the next @.
    peopleLoad ??= Promise.resolve(props.mentionables()).catch((error) => {
      peopleLoad = null;
      throw error;
    });
    try {
      const people = await peopleLoad;
      return filterMentionables(people ?? [], query).map((person) => ({ detail: person.detail ?? '', id: person.ref, label: person.name, ref: person.ref }));
    } catch {
      return [];
    }
  }

  if (!props.token || !props.projectId) {
    return [];
  }

  // Runs on each keystroke after "@", so it stays in the background.
  const result = await apiClient.passive.getMentionables(props.projectId, query, props.token);

  return result.users.slice(0, 8).map((user) => ({
    detail: '',
    id: user.id,
    label: user.name,
    name: user.name,
  }));
}

function mentionAttributes(item) {
  return item.ref ? { id: item.ref, label: item.label, ref: item.ref } : { id: item.id, label: item.label };
}

function createMentionSuggestion() {
  return {
    char: '@',
    items: ({ query }) => mentionItems(query),
    render() {
      let element;
      let status;
      let selectedIndex = 0;
      let latestProps = null;
      const listId = `${uid}-people`;

      // The list is a listbox the editor points at with aria-activedescendant, and a
      // polite status says how many people match.
      function setEditorPointers(editorDom, optionId) {
        if (!editorDom) return;
        if (optionId) {
          editorDom.setAttribute('aria-activedescendant', optionId);
          editorDom.setAttribute('aria-controls', listId);
        } else {
          editorDom.removeAttribute('aria-activedescendant');
          editorDom.removeAttribute('aria-controls');
        }
      }

      function renderList() {
        if (!element || !latestProps) {
          return;
        }

        const { command, items } = latestProps;
        const editorDom = latestProps.editor?.view?.dom;
        element.innerHTML = '';

        if (items.length === 0) {
          element.removeAttribute('role');
          element.removeAttribute('aria-label');
          const emptyItem = document.createElement('div');
          emptyItem.className = 'mention-dropdown__empty';
          emptyItem.textContent = props.mentionables ? 'Nobody to tag matches' : 'No matching users';
          element.appendChild(emptyItem);
          setEditorPointers(editorDom, null);
          if (status) status.textContent = emptyItem.textContent;
          return;
        }

        element.setAttribute('role', 'listbox');
        element.setAttribute('aria-label', 'People to tag');
        items.forEach((item, index) => {
          const option = document.createElement('div');
          option.className = `mention-dropdown__item${index === selectedIndex ? ' mention-dropdown__item--active' : ''}`;
          option.id = `${listId}-${index}`;
          option.setAttribute('role', 'option');
          option.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
          const name = document.createElement('span');
          name.className = 'mention-dropdown__name';
          name.textContent = `@${item.label}`;
          option.appendChild(name);
          if (item.detail) {
            const detail = document.createElement('span');
            detail.className = 'mention-dropdown__detail';
            detail.textContent = item.detail;
            option.appendChild(detail);
          }
          option.onmousedown = (event) => {
            event.preventDefault();
            command(mentionAttributes(item));
          };
          option.onmouseenter = () => {
            selectedIndex = index;
            renderList();
          };
          element.appendChild(option);
        });
        setEditorPointers(editorDom, `${listId}-${selectedIndex}`);
        if (status) status.textContent = `${items.length} ${items.length === 1 ? 'person' : 'people'} to tag. Use the arrow keys, then Enter.`;
      }

      function positionElement(clientRect) {
        if (!element || !clientRect) {
          return;
        }

        const rect = clientRect();

        if (!rect) {
          return;
        }

        element.style.left = `${rect.left + window.scrollX}px`;
        element.style.top = `${rect.bottom + window.scrollY + 8}px`;
      }

      return {
        onKeyDown({ event }) {
          if (!latestProps) {
            return false;
          }

          if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIndex = (selectedIndex + 1) % Math.max(latestProps.items.length, 1);
            renderList();
            return true;
          }

          if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIndex = (selectedIndex - 1 + Math.max(latestProps.items.length, 1)) % Math.max(latestProps.items.length, 1);
            renderList();
            return true;
          }

          if (event.key === 'Enter' || (event.key === 'Tab' && latestProps.items.length)) {
            event.preventDefault();

            if (latestProps.items[selectedIndex]) {
              latestProps.command(mentionAttributes(latestProps.items[selectedIndex]));
            }

            return true;
          }

          if (event.key === 'Escape') {
            // Closes the list only, not a dialog or panel around the editor.
            event.preventDefault();
            event.stopPropagation();
            setEditorPointers(latestProps.editor?.view?.dom, null);
            element?.remove();
            element = null;
            return true;
          }

          return false;
        },
        onExit() {
          mentionListOpen = false;
          setEditorPointers(latestProps?.editor?.view?.dom, null);
          element?.remove();
          status?.remove();
          element = null;
          status = null;
          latestProps = null;
          selectedIndex = 0;
        },
        onStart(inputProps) {
          mentionListOpen = true;
          latestProps = inputProps;
          selectedIndex = 0;
          element = document.createElement('div');
          element.className = 'mention-dropdown';
          element.id = listId;
          status = document.createElement('span');
          status.className = 'visually-hidden';
          status.setAttribute('role', 'status');
          document.body.appendChild(element);
          document.body.appendChild(status);
          renderList();
          positionElement(inputProps.clientRect);
        },
        onUpdate(inputProps) {
          latestProps = inputProps;
          selectedIndex = 0;
          renderList();
          positionElement(inputProps.clientRect);
        },
      };
    },
  };
}

const OdinImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fileId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-file-id') || element.getAttribute('src')?.match(/^odin-file:\/\/(.+)$/)?.[1] || null,
        renderHTML: (attributes) => (attributes.fileId ? { 'data-file-id': attributes.fileId } : {}),
      },
    };
  },
});

const OdinMention = Mention.extend({
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-ref') || element.getAttribute('data-user-id') || element.getAttribute('data-userid') || null,
        renderHTML: (attributes) => (attributes.ref ? {} : { 'data-user-id': attributes.id ?? '' }),
      },
      // A tag in a comment: user:<id>, stakeholder:<id>, or person:<portal key>.
      ref: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-ref') || null,
        renderHTML: (attributes) => (attributes.ref ? { 'data-mention-ref': attributes.ref, 'data-mention-kind': mentionKind(String(attributes.ref).split(':')[0]) } : {}),
      },
      label: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention-label') || element.textContent?.replace(/^@/, '') || null,
        renderHTML: (attributes) => ({
          'data-mention-label': attributes.label ?? '',
        }),
      },
    };
  },
  parseHTML() {
    return [
      { tag: 'span.mention[data-mention-ref]' },
      { tag: 'span.mention[data-user-id]' },
      { tag: 'span.mention[data-userid]' },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        class: 'mention',
        ...(node.attrs.ref ? {} : { 'data-user-id': node.attrs.id ?? '' }),
        'data-mention-label': node.attrs.label ?? '',
      }),
      `@${node.attrs.label ?? node.attrs.id ?? ''}`,
    ];
  },
  renderText({ node }) {
    return `@${node.attrs.label ?? node.attrs.id ?? ''}`;
  },
}).configure({
  HTMLAttributes: {
    class: 'mention',
  },
  suggestion: createMentionSuggestion(),
});

// Submitting from the keyboard: Mod+Enter in a comment, and Enter when submitOnEnter is set
// (outside lists, quotes and code; Shift+Enter starts a new line). This runs as an editor
// prop, ahead of every keymap, so the open @ list is checked here and keeps its Enter.
function handleSubmitKeys(view, event) {
  if (event.key !== 'Enter' || mentionListOpen || event.isComposing) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && (isComment.value || props.submitOnEnter)) {
    event.preventDefault();
    emit('submit');
    return true;
  }
  if (mod || event.shiftKey || event.altKey || !props.submitOnEnter) return false;
  const current = editor.value;
  if (current && (current.isActive('listItem') || current.isActive('codeBlock') || current.isActive('blockquote'))) return false;
  event.preventDefault();
  emit('submit');
  return true;
}

// A table that ends the comment gets an empty line after it, so there is somewhere to type
// below it. The empty line is not stored.
function keepLineAfterTable() {
  editor.value?.commands.command(({ state, tr }) => {
    if (state.doc.lastChild?.type.name !== 'table') return false;
    tr.insert(state.doc.content.size, state.schema.nodes.paragraph.create());
    return true;
  });
}

function insertCommentTable() {
  editor.value?.chain().focus().insertTable({ cols: 3, rows: 3, withHeaderRow: true }).run();
  keepLineAfterTable();
}

// Enter at the end of a line typed as a header row, `| Name | Role |`, turns it into a
// table with an empty row below, and the cursor in that row.
function convertTypedHeaderRow(current) {
  const { $from, empty } = current.state.selection;
  const line = $from.parent;
  if (!empty || line.type.name !== 'paragraph' || $from.depth !== 1 || $from.parentOffset !== line.content.size) return false;
  let plainText = true;
  line.forEach((node) => {
    if (!node.isText) plainText = false;
  });
  const cells = plainText ? tableHeaderCells(line.textContent) : null;
  if (!cells) return false;
  const start = $from.before();
  const paragraph = (text) => ({ type: 'paragraph', ...(text ? { content: [{ text, type: 'text' }] } : {}) });
  current.chain().insertContentAt({ from: start, to: $from.after() }, {
    content: [
      { content: cells.map((text) => ({ content: [paragraph(text)], type: 'tableHeader' })), type: 'tableRow' },
      { content: cells.map(() => ({ content: [paragraph('')], type: 'tableCell' })), type: 'tableRow' },
    ],
    type: 'table',
  }).run();
  keepLineAfterTable();
  const table = current.state.doc.nodeAt(start);
  if (table?.type.name === 'table') current.commands.setTextSelection(start + 1 + table.child(0).nodeSize + 3);
  return true;
}

// In a comment a table cell holds one line, so Enter moves to the next cell, and from the
// last cell adds a row, as Tab does.
function handleTableKeys(event) {
  const current = editor.value;
  if (!isComment.value || !current || event.key !== 'Enter' || mentionListOpen || event.isComposing) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (current.isActive('table')) {
    event.preventDefault();
    if (!current.commands.goToNextCell()) current.chain().addRowAfter().goToNextCell().run();
    return true;
  }
  if (!convertTypedHeaderRow(current)) return false;
  event.preventDefault();
  return true;
}

// Plain text holding a Markdown table, such as one copied from a chat or a code editor, is
// pasted formatted. A copied table that is already HTML is left to the editor.
function handleMarkdownPaste(_view, event) {
  const current = editor.value;
  if (props.storageFormat !== 'comment' || !current || current.isActive('table') || current.isActive('codeBlock')) return false;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!hasMarkdownTable(text) || /<table[\s>]/i.test(event.clipboardData?.getData('text/html') ?? '')) return false;
  event.preventDefault();
  current.chain().focus().insertContent(renderCommentHtml(text)).run();
  keepLineAfterTable();
  // Typing goes on below a table the paste ended with, not in its last cell.
  current.commands.command(({ state, tr }) => {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).type.name !== 'table') continue;
      tr.setSelection(Selection.near(tr.doc.resolve($from.after(depth))));
      return true;
    }
    return false;
  });
  return true;
}

const tableTools = [
  { action: () => editor.value?.chain().focus().addRowAfter().run(), label: 'Add row' },
  { action: () => editor.value?.chain().focus().addColumnAfter().run(), label: 'Add column' },
  { action: () => editor.value?.chain().focus().deleteRow().run(), label: 'Delete row' },
  { action: () => editor.value?.chain().focus().deleteColumn().run(), label: 'Delete column' },
  { action: () => editor.value?.chain().focus().deleteTable().run(), label: 'Delete table' },
];

const editor = useEditor({
  content: buildEditorMarkup(props.modelValue),
  editable: props.editable,
  // Custom attributes replace Tiptap's own role="textbox", so the role is restated with them, and
  // editors without a label keep Tiptap's defaults untouched.
  editorProps: {
    ...(props.labelledBy ? { attributes: { 'aria-labelledby': props.labelledBy, 'aria-multiline': 'true', role: 'textbox' } } : {}),
    handleKeyDown: (view, event) => handleTableKeys(event) || handleSubmitKeys(view, event),
    handlePaste: handleMarkdownPaste,
  },
  extensions: [
    StarterKit.configure({
      heading: {
        levels: [1, 2, 3],
      },
      link: false,
      underline: false,
    }),
    OdinImage,
    Link.configure({
      autolink: true,
      openOnClick: false,
    }),
    Placeholder.configure({
      placeholder: props.placeholder,
    }),
    OdinMention,
    // A comment stores its tables as Markdown, which has no column widths.
    Table.configure({
      resizable: props.toolset !== 'comment',
    }),
    TableRow,
    TableHeader,
    TableCell,
    Underline,
  ],
  onUpdate({ editor: currentEditor }) {
    emit('update:modelValue', buildPersistedMarkup(currentEditor.getHTML()));
  },
});

watch(
  () => props.modelValue,
  (value) => {
    if (!editor.value) {
      return;
    }

    const currentMarkup = buildPersistedMarkup(editor.value.getHTML());
    const nextMarkup = props.storageFormat === 'comment' ? String(value ?? '').trim() : buildPersistedMarkup(value ?? '');

    if (currentMarkup !== nextMarkup) {
      editor.value.commands.setContent(buildEditorMarkup(value), false);
    }
  },
);

watch(
  () => props.editable,
  (editable) => {
    editor.value?.setEditable(editable);
  },
);

watch(
  () => props.targetId,
  () => {
    editorError.value = '';
    aiError.value = '';
    aiModalOpen.value = false;
    aiMenuOpen.value = false;
    aiSuggestions.value = [];
    aiIndex.value = 0;
  },
);

async function triggerImageSelection() {
  if (!hasTargetContext.value) {
    return;
  }

  fileInput.value?.click();
}

async function uploadInlineImage(event) {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  if (!hasTargetContext.value) {
    event.target.value = '';
    return;
  }

  emit('busy', true);
  editorError.value = '';

  try {
    const buffer = await file.arrayBuffer();
    const result = await apiClient.uploadProjectFile(
      props.projectId,
      {
        fileContentsBase64: arrayBufferToBase64(buffer),
        fileDescription: file.name,
        fileName: file.name,
        fileType: file.type || 'application/octet-stream',
        inlineImage: true,
        targetId: props.targetId,
        targetType: props.targetType,
      },
      props.token,
    );

    editor.value?.chain().focus().setImage({
      alt: file.name,
      fileId: result.file.id,
      src: getFileContentUrl(result.file.id, apiBaseUrl.value),
      title: file.name,
    }).run();
  } catch (error) {
    editorError.value = error.message ?? 'Unable to upload the image.';
  } finally {
    emit('busy', false);
    event.target.value = '';
  }
}

// Links are edited in a field under the tools: Enter applies, Escape cancels.
function toggleLink() {
  if (!editor.value) {
    return;
  }

  linkDraft.value = editor.value.getAttributes('link').href ?? '';
  linkError.value = '';
  linkEditing.value = true;
  nextTick(() => linkInput.value?.focus());
}

function normalizeLinkHref(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const href = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  return /^(https?:|mailto:)/i.test(href) ? href : null;
}

function closeLinkEditor() {
  linkEditing.value = false;
  linkError.value = '';
  editor.value?.chain().focus().run();
}

watch(linkEditing, (open) => {
  if (!open) setTimeout(hideToolsIfFocusLeft, 0);
});

function applyLink() {
  if (!editor.value) return;
  const href = normalizeLinkHref(linkDraft.value);
  if (href === null) {
    linkError.value = 'Use a web address (https://…) or an email link (mailto:…).';
    return;
  }
  const chain = editor.value.chain().focus().extendMarkRange('link');
  if (!href) {
    chain.unsetLink().run();
  } else if (editor.value.state.selection.empty && !editor.value.isActive('link')) {
    // With nothing selected the address itself is inserted, set apart from a word before it.
    const { from } = editor.value.state.selection;
    const before = from > 1 ? editor.value.state.doc.textBetween(from - 1, from) : '';
    // Typing after it continues as plain text, not as part of the link.
    chain.insertContent([
      ...(before && !/\s/.test(before) ? [{ text: ' ', type: 'text' }] : []),
      { marks: [{ attrs: { href }, type: 'link' }], text: href, type: 'text' },
    ]).unsetMark('link').run();
  } else {
    chain.setLink({ href }).run();
  }
  linkEditing.value = false;
  linkError.value = '';
}

function removeLink() {
  editor.value?.chain().focus().extendMarkRange('link').unsetLink().run();
  linkEditing.value = false;
}

function onLinkKeydown(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    applyLink();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeLinkEditor();
  }
}

const COMMENT_STYLES = [
  { label: 'Normal text', value: 'paragraph' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
  { label: 'Code block', value: 'codeBlock' },
];

function currentStyle() {
  if (!editor.value) return 'paragraph';
  for (const level of [1, 2, 3]) {
    if (editor.value.isActive('heading', { level })) return `h${level}`;
  }
  return editor.value.isActive('codeBlock') ? 'codeBlock' : 'paragraph';
}

function setStyle(value) {
  const chain = editor.value?.chain().focus();
  if (!chain) return;
  if (value === 'codeBlock') chain.setCodeBlock().run();
  else if (/^h[1-3]$/.test(value)) chain.setHeading({ level: Number(value.slice(1)) }).run();
  else chain.setParagraph().run();
}

function openEmojiPicker(event) {
  if (!editor.value) return;
  if (emoji.open) {
    emoji.open = false;
    return;
  }
  emoji.anchor = event.currentTarget;
  emoji.selection = { from: editor.value.state.selection.from, to: editor.value.state.selection.to };
  emoji.open = true;
}

function insertEmoji(value) {
  const chain = editor.value?.chain().focus();
  if (!chain) return;
  if (emoji.selection) chain.setTextSelection(emoji.selection);
  chain.insertContent(value).run();
  emoji.selection = null;
}

function closeEmojiPicker({ returnFocus = true } = {}) {
  emoji.open = false;
  if (returnFocus) editor.value?.commands.focus();
  // A press outside: the tools go if focus left with it.
  else setTimeout(hideToolsIfFocusLeft, 0);
}

const commentTools = [
  [
    { action: () => editor.value?.chain().focus().toggleBold().run(), active: () => editor.value?.isActive('bold'), icon: 'bi-type-bold', label: 'Bold', shortcut: 'B' },
    { action: () => editor.value?.chain().focus().toggleItalic().run(), active: () => editor.value?.isActive('italic'), icon: 'bi-type-italic', label: 'Italic', shortcut: 'I' },
    { action: () => editor.value?.chain().focus().toggleUnderline().run(), active: () => editor.value?.isActive('underline'), icon: 'bi-type-underline', label: 'Underline', shortcut: 'U' },
    { action: () => editor.value?.chain().focus().toggleCode().run(), active: () => editor.value?.isActive('code'), icon: 'bi-code', label: 'Code', shortcut: 'E' },
  ],
  [
    { action: () => editor.value?.chain().focus().toggleBulletList().run(), active: () => editor.value?.isActive('bulletList'), icon: 'bi-list-ul', label: 'Bulleted list', shortcut: 'Shift+8' },
    { action: () => editor.value?.chain().focus().toggleOrderedList().run(), active: () => editor.value?.isActive('orderedList'), icon: 'bi-list-ol', label: 'Numbered list', shortcut: 'Shift+7' },
    { action: () => editor.value?.chain().focus().toggleBlockquote().run(), active: () => editor.value?.isActive('blockquote'), icon: 'bi-quote', label: 'Quote', shortcut: 'Shift+B' },
  ],
  [
    { action: toggleLink, active: () => editor.value?.isActive('link'), icon: 'bi-link-45deg', label: 'Link', shortcut: '' },
    { action: insertCommentTable, active: () => editor.value?.isActive('table'), icon: 'bi-table', label: 'Table', shortcut: '' },
    { action: openEmojiPicker, active: () => emoji.open, icon: 'bi-emoji-smile', label: 'Emoji', shortcut: '' },
  ],
];

// Focuses like a textarea: now if the editor is on the page, otherwise on the next frames
// while it attaches (it renders a tick after mounting). A later attempt gives up if the page
// has moved focus somewhere else meanwhile, so it never takes focus back.
function focus(options = {}) {
  const requestedFrom = typeof document !== 'undefined' ? document.activeElement : null;
  const attempt = (tries) => {
    const current = editor.value;
    if (current?.isDestroyed) return;
    if (tries > 0) {
      const active = document.activeElement;
      if (active !== requestedFrom && active !== document.body && !root.value?.contains(active)) return;
    }
    if (!current || !current.view.dom.isConnected) {
      if (tries < 10 && typeof requestAnimationFrame === 'function') requestAnimationFrame(() => attempt(tries + 1));
      return;
    }
    const { state, view } = current;
    view.dispatch(state.tr.setSelection(options.position === 'start' ? Selection.atStart(state.doc) : Selection.atEnd(state.doc)));
    view.dom.focus({ preventScroll: Boolean(options.preventScroll) });
  };
  attempt(0);
}

// Puts a tag and a space at the end of the text, as choosing someone from the @ list does, and
// leaves the cursor after them. False while the editor isn't ready.
function insertMention({ label, ref: mentionRef }) {
  const current = editor.value;
  if (!current || current.isDestroyed) return false;
  return current.chain().focus('end').insertContent([{ attrs: { id: mentionRef, label, ref: mentionRef }, type: 'mention' }, { text: ' ', type: 'text' }]).run();
}

defineExpose({
  focus,
  insertMention,
  scrollIntoView: (options) => root.value?.scrollIntoView(options),
});

function removeSelectedImage() {
  if (!editor.value) {
    return;
  }

  const { selection } = editor.value.state;

  if (selection instanceof NodeSelection && selection.node.type.name === 'image') {
    editor.value.chain().focus().deleteSelection().run();
  }
}

function selectedTextSnapshot() {
  if (!editor.value) {
    return {
      from: 0,
      hasSelection: false,
      selectedText: '',
      to: 0,
    };
  }

  const { from, to } = editor.value.state.selection;
  const hasSelection = from !== to;
  const selectedText = hasSelection
    ? editor.value.state.doc.textBetween(from, to, '\n').trim()
    : '';

  return {
    from,
    hasSelection,
    selectedText,
    to,
  };
}

function promptModeLabel(mode) {
  if (mode === 'expand') {
    return 'Expand and Correct';
  }

  if (mode === 'summarize') {
    return 'Summarize';
  }

  return 'Rewrite';
}

async function runAiEnhance(mode) {
  if (!editor.value) {
    return;
  }

  if (!hasTargetContext.value) {
    return;
  }

  aiWorking.value = true;
  emit('busy', true);
  aiError.value = '';

  const snapshot = selectedTextSnapshot();
  aiSelectionRange.value = snapshot;

  try {
    const fullText = editor.value.getText({ blockSeparator: '\n\n' });
    const fullHtml = buildPersistedMarkup(editor.value.getHTML());
    const element = props.targetType === 'story' ? 'storyDescription' : 'projectDescription';

    const result = await apiClient.enhanceRichContent(
      props.projectId,
      {
        element,
        fullHtml,
        fullText,
        mode,
        selectedText: snapshot.selectedText,
        targetType: props.targetType,
        title: props.title,
      },
      props.token,
    );

    aiSuggestions.value = result.suggestions ?? [];
    aiIndex.value = 0;
    aiModalOpen.value = aiSuggestions.value.length > 0;
    aiMenuOpen.value = false;

    if (!aiModalOpen.value) {
      aiError.value = 'AI did not return any suggestions.';
    }
  } catch (error) {
    aiError.value = error.message ?? 'Unable to generate an AI suggestion.';
  } finally {
    aiWorking.value = false;
    emit('busy', false);
  }
}

function closeAiModal() {
  aiModalOpen.value = false;
  aiSuggestions.value = [];
  aiIndex.value = 0;
}

function currentAiSuggestion() {
  return aiSuggestions.value[aiIndex.value] ?? '';
}

function applyAiReplaceSelection() {
  if (!editor.value) {
    return;
  }

  const suggestion = currentAiSuggestion();
  if (!suggestion) {
    return;
  }

  const range = aiSelectionRange.value;

  if (!range.hasSelection) {
    return;
  }

  editor.value.chain().focus().insertContentAt({ from: range.from, to: range.to }, suggestion).run();
  closeAiModal();
}

function applyAiReplaceAll() {
  if (!editor.value) {
    return;
  }

  const suggestion = currentAiSuggestion();
  if (!suggestion) {
    return;
  }

  editor.value.commands.setContent(suggestion);
  closeAiModal();
}

function applyAiInsert() {
  if (!editor.value) {
    return;
  }

  const suggestion = currentAiSuggestion();
  if (!suggestion) {
    return;
  }

  editor.value.chain().focus().insertContent(suggestion).run();
  closeAiModal();
}

const toolbarGroups = [
  [
    { action: () => editor.value?.chain().focus().setParagraph().run(), active: () => editor.value?.isActive('paragraph'), icon: 'bi-text-paragraph', label: 'Body' },
    { action: () => editor.value?.chain().focus().toggleHeading({ level: 2 }).run(), active: () => editor.value?.isActive('heading', { level: 2 }), icon: 'bi-type-h2', label: 'H2' },
    { action: () => editor.value?.chain().focus().toggleHeading({ level: 3 }).run(), active: () => editor.value?.isActive('heading', { level: 3 }), icon: 'bi-type-h3', label: 'H3' },
  ],
  [
    { action: () => editor.value?.chain().focus().toggleBold().run(), active: () => editor.value?.isActive('bold'), icon: 'bi-type-bold', label: 'Bold' },
    { action: () => editor.value?.chain().focus().toggleItalic().run(), active: () => editor.value?.isActive('italic'), icon: 'bi-type-italic', label: 'Italic' },
    { action: () => editor.value?.chain().focus().toggleUnderline().run(), active: () => editor.value?.isActive('underline'), icon: 'bi-type-underline', label: 'Underline' },
    { action: () => editor.value?.chain().focus().toggleStrike().run(), active: () => editor.value?.isActive('strike'), icon: 'bi-type-strikethrough', label: 'Strike' },
  ],
  [
    { action: () => editor.value?.chain().focus().toggleBulletList().run(), active: () => editor.value?.isActive('bulletList'), icon: 'bi-list-ul', label: 'Bullets' },
    { action: () => editor.value?.chain().focus().toggleOrderedList().run(), active: () => editor.value?.isActive('orderedList'), icon: 'bi-list-ol', label: 'Numbers' },
    { action: () => editor.value?.chain().focus().toggleBlockquote().run(), active: () => editor.value?.isActive('blockquote'), icon: 'bi-blockquote-left', label: 'Quote' },
    { action: () => editor.value?.chain().focus().toggleCodeBlock().run(), active: () => editor.value?.isActive('codeBlock'), icon: 'bi-code-slash', label: 'Code' },
  ],
  [
    { action: toggleLink, active: () => editor.value?.isActive('link'), icon: 'bi-link-45deg', label: 'Link' },
    { action: () => editor.value?.chain().focus().insertTable({ cols: 3, rows: 3, withHeaderRow: true }).run(), active: () => editor.value?.isActive('table'), icon: 'bi-table', label: 'Table' },
    { action: openEmojiPicker, active: () => emoji.open, disabled: () => !props.editable, icon: 'bi-emoji-smile', label: 'Emoji' },
    { action: triggerImageSelection, active: () => false, disabled: () => !hasTargetContext.value, icon: 'bi-image', label: 'Image' },
    { action: removeSelectedImage, active: () => false, disabled: () => !props.editable, icon: 'bi-trash3', label: 'Remove image' },
  ],
  [
    { action: () => { aiMenuOpen.value = !aiMenuOpen.value; }, active: () => aiMenuOpen.value, disabled: () => !hasTargetContext.value, icon: 'bi-stars', label: 'AI' },
  ],
];
</script>

<template>
  <div
    ref="root"
    class="rich-editor"
    :class="{
      'rich-editor--comment': isComment,
      'rich-editor--compact': compact,
      'rich-editor--readonly': !editable,
      'rich-editor--tools-on-focus': toolbarMode === 'focus',
    }"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <div v-if="editable && isComment" v-show="toolsShown" class="rich-editor__toolbar rich-editor__toolbar--line" role="group" aria-label="Text formatting">
      <label class="visually-hidden" :for="`${uid}-style`">Text style</label>
      <select :id="`${uid}-style`" class="form-select form-select-sm rich-editor__style" :value="currentStyle()" @change="setStyle($event.target.value)">
        <option v-for="style in COMMENT_STYLES" :key="style.value" :value="style.value">{{ style.label }}</option>
      </select>
      <template v-for="(group, groupIndex) in commentTools" :key="groupIndex">
        <span class="rich-editor__divider" aria-hidden="true"></span>
        <button
          v-for="item in group"
          :key="item.label"
          :class="['rich-editor__tool', { 'rich-editor__tool--active': item.active?.() }]"
          :aria-label="item.label"
          :aria-pressed="['Emoji', 'Link', 'Table'].includes(item.label) ? undefined : (item.active?.() ? 'true' : 'false')"
          :aria-expanded="item.label === 'Emoji' ? String(emoji.open) : undefined"
          type="button"
          @mousedown.prevent
          @click="item.action"
        >
          <i class="bi rich-editor__tool-icon" :class="item.icon" aria-hidden="true"></i>
          <span class="rich-editor__tip" aria-hidden="true">{{ item.label }}<template v-if="item.shortcut"> ({{ modKey }}+{{ item.shortcut }})</template></span>
        </button>
      </template>
    </div>
    <div v-if="editable && isComment && toolsShown && editor?.isActive('table')" class="rich-editor__table-tools" role="group" aria-label="Table">
      <button v-for="tool in tableTools" :key="tool.label" class="ghost-button ghost-button--compact" type="button" @mousedown.prevent @click="tool.action">{{ tool.label }}</button>
    </div>
    <div v-if="!(editable && isComment)" class="rich-editor__toolbar">
      <div v-for="(group, groupIndex) in toolbarGroups" :key="groupIndex" class="rich-editor__toolbar-group">
        <button
          v-for="item in group"
          :key="item.label"
          :class="['rich-editor__tool', { 'rich-editor__tool--active': item.active?.() }]"
          :disabled="item.disabled?.()"
          :aria-label="item.label"
          :title="item.label"
          type="button"
          @click="item.action"
        >
          <i v-if="item.icon" class="bi rich-editor__tool-icon" :class="item.icon" aria-hidden="true"></i>
          <span class="rich-editor__tool-label">{{ item.label }}</span>
        </button>
      </div>
    </div>

    <div v-if="linkEditing" class="rich-editor__link-row">
      <label class="rich-editor__link-label" :for="`${uid}-link`">Link</label>
      <input
        :id="`${uid}-link`"
        ref="linkInput"
        v-model="linkDraft"
        class="form-control form-control-sm"
        type="url"
        inputmode="url"
        placeholder="https://…"
        :aria-invalid="linkError ? 'true' : undefined"
        :aria-describedby="linkError ? `${uid}-link-error` : undefined"
        @keydown="onLinkKeydown"
      />
      <button class="primary-button primary-button--compact" type="button" @click="applyLink">Apply</button>
      <button v-if="editor?.isActive('link')" class="ghost-button ghost-button--compact" type="button" @click="removeLink">Remove</button>
      <button class="ghost-button ghost-button--compact" type="button" @click="closeLinkEditor">Cancel</button>
      <p v-if="linkError" :id="`${uid}-link-error`" class="rich-editor__error rich-editor__link-error" role="alert">{{ linkError }}</p>
    </div>

    <div v-if="aiMenuOpen && !isComment" class="rich-editor__ai-menu">
      <button class="rich-editor__ai-item" type="button" :disabled="aiWorking" @click="runAiEnhance('rewrite')">
        {{ aiWorking ? 'Working...' : promptModeLabel('rewrite') }}
      </button>
      <button class="rich-editor__ai-item" type="button" :disabled="aiWorking" @click="runAiEnhance('expand')">
        {{ aiWorking ? 'Working...' : promptModeLabel('expand') }}
      </button>
      <button class="rich-editor__ai-item" type="button" :disabled="aiWorking" @click="runAiEnhance('summarize')">
        {{ aiWorking ? 'Working...' : promptModeLabel('summarize') }}
      </button>
    </div>

    <EditorContent
      v-if="editor"
      :editor="editor"
      class="rich-editor__surface"
      :style="minHeight ? { '--editor-min-height': minHeight } : undefined"
    />

    <input v-if="!isComment" ref="fileInput" accept="image/*" hidden type="file" @change="uploadInlineImage" />
    <EmojiPicker :anchor="emoji.anchor" :focus-anchor="false" label="Insert an emoji" :open="emoji.open" quick-label="Frequently used" verb="Insert" @close="closeEmojiPicker" @pick="insertEmoji" />

    <p v-if="editorError" class="rich-editor__error">{{ editorError }}</p>
    <p v-else-if="aiError" class="rich-editor__error">{{ aiError }}</p>

    <div v-if="aiModalOpen" class="rich-editor__ai-modal" role="dialog" aria-modal="true">
      <div class="rich-editor__ai-modal-card">
        <div class="rich-editor__ai-modal-header">
          <strong>AI suggestion</strong>
          <button class="ghost-button ghost-button--compact" type="button" @click="closeAiModal">Close</button>
        </div>

        <div class="rich-editor__ai-modal-body">
          <div class="rich-copy" v-html="currentAiSuggestion()"></div>
        </div>

        <div class="rich-editor__ai-modal-footer">
          <div class="actions-row">
            <button class="secondary-button secondary-button--compact" type="button" :disabled="aiIndex === 0" @click="aiIndex -= 1">
              Prev
            </button>
            <button class="secondary-button secondary-button--compact" type="button" :disabled="aiIndex >= aiSuggestions.length - 1" @click="aiIndex += 1">
              Next
            </button>
            <span class="muted-copy">{{ aiSuggestions.length ? `${aiIndex + 1} / ${aiSuggestions.length}` : '' }}</span>
          </div>

          <div class="actions-row">
            <button v-if="aiSelectionRange.hasSelection" class="primary-button" type="button" @click="applyAiReplaceSelection">
              Replace selection
            </button>
            <template v-else>
              <button class="primary-button" type="button" @click="applyAiReplaceAll">Replace text</button>
              <button class="secondary-button secondary-button--compact" type="button" @click="applyAiInsert">Insert</button>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
