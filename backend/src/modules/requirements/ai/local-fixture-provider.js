// Deterministic requirements AI for local work without an OpenAI key
// (REQUIREMENTS_AI_PROVIDER=local-fixture). It produces structurally valid output from
// the input and never runs in production: env.js refuses the setting there, and
// createRequirementsAiService refuses it again.

const FIXTURE_SECTIONS = new Set(['requirements', 'constraints']);

function quote(text, max = 160) {
  const value = String(text ?? '').trim().replace(/\s+/g, ' ');
  return value.length > max ? `${value.slice(0, max - 3).trimEnd()}...` : value;
}

function fixturePrompt(track, line) {
  const text = quote(line.text);
  if (track === 'architecture') {
    return line.section === 'constraints'
      ? `Which business rules or policies does "${text}" set for this work?`
      : `What business rules and data does "${text}" depend on?`;
  }
  return line.section === 'constraints'
    ? `How does the constraint "${text}" change what people see and do?`
    : `What should "${text}" look like for the people who use it, and how will we know it works?`;
}

export function createLocalFixtureRequirementsAiProvider() {
  return {
    provider: 'local-fixture',
    async draftQuestions({ briefLines = [], existingTopics = [], track }) {
      const covered = new Set(existingTopics
        .filter((topic) => topic.track === track && topic.sourceRef)
        .map((topic) => topic.sourceRef));
      const trackLabel = track === 'architecture' ? 'Functional' : 'Experience';

      return {
        model: 'local-fixture',
        questions: briefLines
          .filter((line) => FIXTURE_SECTIONS.has(line.section) && !covered.has(line.ref))
          .map((line) => ({
            prompt: fixturePrompt(track, line),
            rationale: `${line.label} of the brief has no ${trackLabel} topic yet.`,
            recommendation: `Build "${quote(line.text, 100)}" as the brief describes it.`,
            settles: `${line.label}: ${quote(line.text, 100)}`,
            sourceRef: line.ref,
            suggestedOwnerRole: 'Product owner',
          })),
      };
    },
  };
}
