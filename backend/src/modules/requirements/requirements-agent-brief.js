import { PROJECT_CAPABILITIES, requireProjectCapability } from '../../lib/auth/project-capabilities.js';
import { REQUIREMENTS_TRACKS, REVIEW_TRACK } from './requirements.repository.js';
import { listTrackTopicsForUser, tenantIdFor } from './requirements.service.js';

// "Copy agent instructions" on the Review tab: one markdown block a person pastes into a
// coding agent. It carries this project's values (ids, the round to build on, the topics
// questions may link to) and the rules that reject a package; the package kit's README.md
// (docs/requirements-gathering/agent-guide.md) has the full guide. Review is project-wide:
// one round at a time, built from screens and prototypes, with questions from either track.

const TRACK_LABELS = { architecture: 'Functional', experience: 'Experience' };
const MAX_TOPICS = 60;

function oneLine(value, maxLength = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

function topicLine(topic) {
  const state = topic.decision?.statement ? `decided: ${oneLine(topic.decision.statement, 100)}` : topic.state;
  const track = TRACK_LABELS[topic.track] ? `${TRACK_LABELS[topic.track]}, ` : '';
  return `- \`${topic.id}\`: ${oneLine(topic.prompt)} (${track}${state})`;
}

export function renderAgentBrief({ latestRound = null, nextVersion = 1, project, topics = [] }) {
  const listed = topics.slice(0, MAX_TOPICS);
  const lines = [
    `# Review package task: ${oneLine(project.name || 'Odin project', 120)}`,
    '',
    'Build an Odin review package: the screens, prototypes and flows people see and use, for the project\'s team and stakeholders to review as one round. Then validate it and upload it.',
    '',
    'The package kit (odin-review-package-kit.zip, downloaded from the Review tab in Odin) has the full guide in README.md, the spec, an example, and a validator. If you were not given the kit, ask for it before you start.',
    '',
    '## This project',
    '',
    `- Project id: \`${project.id}\``,
    `- Set \`"track": "${REVIEW_TRACK}"\` in manifest.json. Review is project-wide; this is the only value Odin accepts.`,
    latestRound
      ? `- Builds on round ${latestRound.number} (${latestRound.status}): set \`"basedOnRoundId": "${latestRound.id}"\`. Read that round's feedback first, with \`odin_get_round_feedback\` if you have the Odin MCP server, or ask for it.`
      : '- No review rounds yet: leave `basedOnRoundId` out.',
    `- This upload becomes version ${nextVersion} of the project's review package.`,
    '',
    '## Topics your questions can link to',
    '',
  ];
  if (listed.length === 0) {
    lines.push('The project has no topics yet. Leave `topicId` off your questions; publishing the round creates a topic for each one.');
  } else {
    lines.push('Set a question\'s `topicId` to one of these ids, from either track, to post its answers to that discussion. Ids from anywhere else reject the package. A question without `topicId` gets a new topic when the round is published.', '');
    lines.push(...listed.map(topicLine));
    if (topics.length > listed.length) lines.push(`- …and ${topics.length - listed.length} more. Ask for the full list, or use \`odin_get_requirements_context\`.`);
  }
  lines.push(
    '',
    '## Rules that reject a package',
    '',
    '- `manifest.json` sits at the root of the zip. Zip the package\'s contents, not its folder.',
    '- `"schema": "odin.review-package/v1"`, plus `track`, `title`, `summary`, and 1-7 `sections` (each type at most once).',
    '- Ids are lowercase letters, digits, and single hyphens. Keep a screen\'s or question\'s id when you revise it, so reviewers\' comments carry forward.',
    '- Only these file types: html, js, mjs, css, json, png, jpg, jpeg, webp, gif, svg, woff, woff2, txt, md. HTML and JavaScript only inside a prototype\'s folder.',
    '- Prototypes are offline: no CDN scripts, web fonts, or API calls, and no cookies or localStorage. Use relative paths and put shared files in `assets/`.',
    '- Unknown or misspelled fields inside sections are errors. Mermaid flows must parse.',
    '',
    '## Validate and upload',
    '',
    `1. In the kit: \`npm install\`, then \`node validate.mjs <package.zip or folder> --track ${REVIEW_TRACK}\`. Exit code 0 means Odin would accept it, apart from topic ids, the malware scan, and Mermaid, which Odin checks at upload.`,
    `2. Upload with the Odin MCP server (\`odin_create_package_upload\` with project id \`${project.id}\`, then the PUT it describes, then \`odin_get_package_status\`), or with an upload URL a person creates for you in Odin:`,
    '',
    '   ```sh',
    '   curl --fail-with-body -X PUT -H "Content-Type: application/zip" --data-binary @package.zip "<upload URL>"',
    '   ```',
    '',
    '3. 201 means the package is a draft that a person publishes. 422 lists errors with a code, file, and manifest path; the URL is spent, so fix the package and get a new one. Upload URLs work once and expire after 10 minutes.',
  );
  return `${lines.join('\n')}\n`;
}

/** The project's agent brief. A track in the route is accepted for older links and ignored. */
export async function getAgentBriefForUser(deps, { projectId, user }) {
  const tenantId = tenantIdFor(user);
  await requireProjectCapability({ capability: PROJECT_CAPABILITIES.READ, projectId, repository: deps.projectRepository, tenantId, user });
  const [project, rounds, packages, ...topicLists] = await Promise.all([
    deps.projectRepository.getProjectDetail?.({ projectId, tenantId }) ?? null,
    deps.roundsRepository?.listRounds?.({ projectId, tenantId, track: '' }) ?? [],
    deps.packagesRepository?.listPackages?.({ projectId, tenantId, track: REVIEW_TRACK }) ?? [],
    ...REQUIREMENTS_TRACKS.map((track) => listTrackTopicsForUser(deps, { projectId, query: { q: '', view: 'all' }, track, user })),
  ]);
  const published = rounds.filter((round) => round.status !== 'draft');
  const latestRound = published.reduce((latest, round) => (!latest || round.number > latest.number ? round : latest), null);
  const nextVersion = packages.reduce((max, pkg) => Math.max(max, Number(pkg.version) || 0), 0) + 1;
  const markdown = renderAgentBrief({
    latestRound,
    nextVersion,
    project: { id: projectId, name: project?.name ?? '' },
    topics: topicLists.flatMap((list) => list.topics ?? []),
  });
  return { markdown, ok: true, track: REVIEW_TRACK };
}
