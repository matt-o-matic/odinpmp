import { randomUUID } from 'node:crypto';

import { summarizeProjectSnapshot } from './project-ai-helpers.js';

function normalizeGeneratedTask(task) {
  return {
    aiGenerated: true,
    assigneeId: null,
    assigneeName: '',
    description: String(task.description ?? '').trim(),
    id: randomUUID(),
    name: String(task.name ?? 'Generated task').trim() || 'Generated task',
    points: task.points ?? null,
    priority: Number(task.priority ?? 4),
    status: task.status ?? 'Not Started',
    targetEndDate: null,
    targetStartDate: null,
  };
}

function normalizeGeneratedStory(story) {
  return {
    aiGenerated: true,
    assigneeId: null,
    assigneeName: '',
    description: String(story.description ?? '').trim(),
    id: randomUUID(),
    name: String(story.name ?? 'Generated story').trim() || 'Generated story',
    points: story.points ?? null,
    priority: Number(story.priority ?? 4),
    status: story.status ?? 'Not Started',
    targetEndDate: null,
    targetStartDate: null,
    tasks: (story.tasks ?? []).map(normalizeGeneratedTask),
  };
}

function normalizeGeneratedEpic(epic) {
  return {
    aiGenerated: true,
    assigneeId: null,
    assigneeName: '',
    description: String(epic.description ?? '').trim(),
    id: randomUUID(),
    name: String(epic.name ?? 'Generated epic').trim() || 'Generated epic',
    points: epic.points ?? null,
    priority: Number(epic.priority ?? 4),
    status: epic.status ?? 'Not Started',
    stories: (epic.stories ?? []).map(normalizeGeneratedStory),
    targetEndDate: null,
    targetStartDate: null,
  };
}

function firstSentence(text) {
  const normalized = String(text ?? '').trim().replace(/\s+/g, ' ');

  if (!normalized) {
    return '';
  }

  const match = normalized.match(/.+?[.!?](?:\s|$)/);
  return match ? match[0].trim() : normalized;
}

export function createFallbackProjectAiService() {
  return {
    async enhanceDescription({ description, project }) {
      const summary = summarizeProjectSnapshot(project);
      const baseDescription = firstSentence(description) || 'Define scope, ownership, and delivery sequencing clearly.';
      const suggestions = [
        `${project.name} is a ${summary.status.toLowerCase()} initiative focused on ${baseDescription.replace(/[.!?]+$/, '')}. The current plan spans ${summary.epicCount} epics, ${summary.storyCount} stories, and ${summary.taskCount} tasks, with emphasis on execution clarity, dependency sequencing, and visible owner accountability.`,
      ];

      return {
        model: 'deterministic-fallback',
        provider: 'fallback',
        suggestions,
      };
    },
    async analyzeProject({ project }) {
      const summary = summarizeProjectSnapshot(project);
      const risks = [];

      if (summary.epicCount === 0) {
        risks.push('No epics are defined yet, so the project has no execution structure.');
      }

      if (summary.taskCount === 0) {
        risks.push('No tasks are defined yet, which makes owner-level execution tracking impossible.');
      }

      if (summary.atRiskCount > 0) {
        risks.push(`${summary.atRiskCount} items are already marked At Risk.`);
      }

      const nextStep = summary.inProgressCount > 0
        ? 'Convert active work into explicit completion criteria and owner checkpoints.'
        : 'Promote the first tranche of work from planning into active execution with named owners.';

      const analysis = [
        `Overview: ${project.name} is ${summary.status.toLowerCase()} and currently spans ${summary.epicCount} epics, ${summary.storyCount} stories, and ${summary.taskCount} tasks.`,
        `Progress signal: ${summary.inProgressCount} items are in progress and ${summary.completedCount} items are completed.`,
        `Risk check: ${risks.length > 0 ? risks.join(' ') : 'No immediate structural risks were detected from the current tree.'}`,
        `Recommended next step: ${nextStep}`,
      ].join('\n\n');

      return {
        analysis,
        model: 'deterministic-fallback',
        provider: 'fallback',
      };
    },
    async generateStructure({ project }) {
      const focus = firstSentence(project.description) || `Deliver ${project.name} with clear workstream ownership`;

      return {
        epics: [
          {
            description: `Define the first execution workstream for ${project.name}. Focus on ${focus.toLowerCase()}.`,
            id: randomUUID(),
            name: 'Execution Foundations',
            points: 8,
            priority: 4,
            status: 'Not Started',
            stories: [
              {
                description: 'Capture scope, owners, and sequencing for the first milestone.',
                id: randomUUID(),
                name: 'Scope the first milestone',
                points: 5,
                priority: 4,
                status: 'Not Started',
                tasks: [
                  {
                    description: 'List the immediate deliverables and success criteria.',
                    id: randomUUID(),
                    name: 'Define deliverables',
                    priority: 4,
                    status: 'Not Started',
                  },
                  {
                    description: 'Name the primary owner and confirm dependencies.',
                    id: randomUUID(),
                    name: 'Assign ownership',
                    priority: 4,
                    status: 'Not Started',
                  },
                ],
              },
            ],
          },
          {
            description: `Build the feedback loop that keeps ${project.name} visible and on track.`,
            id: randomUUID(),
            name: 'Delivery Control',
            points: 8,
            priority: 4,
            status: 'Not Started',
            stories: [
              {
                description: 'Create a repeatable review cadence for the new plan.',
                id: randomUUID(),
                name: 'Review execution weekly',
                points: 3,
                priority: 4,
                status: 'Not Started',
                tasks: [
                  {
                    description: 'Summarize progress, blockers, and next decisions.',
                    id: randomUUID(),
                    name: 'Prepare review brief',
                    priority: 4,
                    status: 'Not Started',
                  },
                ],
              },
            ],
          },
        ],
        model: 'deterministic-fallback',
        provider: 'fallback',
      };
    },
    async generateStories({ projectJson }) {
      return {
        model: 'deterministic-fallback',
        provider: 'fallback',
        stories: [
          normalizeGeneratedStory({
            description: `Expand the epic scope based on: ${firstSentence(projectJson) || 'Project context'}`,
            name: 'Generated story',
            tasks: [],
          }),
        ],
      };
    },
    async generateTasks({ storyDescription }) {
      return {
        model: 'deterministic-fallback',
        provider: 'fallback',
        tasks: [
          normalizeGeneratedTask({
            description: `Break down the story: ${firstSentence(storyDescription) || 'Story context'}`,
            name: 'Generated task',
          }),
        ],
      };
    },
    async enhanceRichText({ fullText, selectedText, mode }) {
      const target = selectedText ? `selection: ${selectedText}` : 'full text';
      const suggestions = [
        `${mode === 'summarize' ? 'Summary' : mode === 'expand' ? 'Expanded version' : 'Rewrite'} of ${target}: ${firstSentence(fullText) || 'Add more detail.'}`,
      ];

      return {
        model: 'deterministic-fallback',
        provider: 'fallback',
        suggestions,
      };
    },
  };
}
