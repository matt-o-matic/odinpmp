import { isDuplicatePrompt } from '../requirements-topics.js';
import { emptySummaryOutput, SUMMARY_LIMITS } from './summary-output.js';

// Deterministic Odin summary for local work without an OpenAI key
// (REQUIREMENTS_AI_PROVIDER=local-fixture, refused in production). It reads the same model
// input the real provider gets and derives citation-valid output from votes and replies:
//   - aligned: a source that two or more people back (author plus upvoters), a reply that
//     agrees with its parent, or two people saying the same thing;
//   - divergent: a source someone downvoted, or a reply that disagrees with its parent;
//   - proposedAnswer: the source with the most net support, once two people back it.
// It never follows text inside sources; it only counts and quotes.

const AGREE = /(^|[^a-z])(?<!dis)(agree|agreed|\+1|seconded|same here|exactly|me too)([^a-z]|$)/i;
const DISAGREE = /(^|[^a-z])(disagree|don't agree|do not agree|not convinced|rather not|i'd push back|push back)([^a-z]|$)|^\s*no[,.!\s]/i;

function firstSentence(text, max = 200) {
  const value = String(text ?? '').trim().replace(/\s+/g, ' ');
  const sentence = value.split(/(?<=[.!?])\s/)[0] ?? value;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function backers(source) {
  return unique([source.author, ...(source.upvotedBy ?? [])]).filter((person) => !(source.downvotedBy ?? []).includes(person));
}

export function summarizeWithLocalFixture(modelInput) {
  const content = modelInput?.untrustedContent ?? {};
  const sources = Array.isArray(content.sources) ? content.sources : [];
  const people = new Map((content.people ?? []).map((person) => [person.ref, person]));
  const byRef = new Map(sources.map((source) => [source.ref, source]));
  const output = emptySummaryOutput();
  if (sources.length === 0) return output;

  // Aligned ------------------------------------------------------------------
  const alignedByAnchor = new Map();
  const addAligned = (anchor, supporters, refs) => {
    const entry = alignedByAnchor.get(anchor.ref) ?? { sources: [], statement: firstSentence(anchor.text), supporters: [] };
    entry.supporters = unique([...entry.supporters, ...supporters]);
    entry.sources = unique([...entry.sources, ...refs]);
    alignedByAnchor.set(anchor.ref, entry);
  };
  for (const source of sources) {
    if (backers(source).length >= 2) addAligned(source, backers(source), [source.ref]);
  }
  for (const reply of sources) {
    const parent = reply.replyTo ? byRef.get(reply.replyTo) : null;
    if (parent && parent.author !== reply.author && AGREE.test(reply.text) && !DISAGREE.test(reply.text)) {
      addAligned(parent, [...backers(parent), reply.author], [parent.ref, reply.ref]);
    }
  }
  for (let left = 0; left < sources.length; left += 1) {
    for (let right = left + 1; right < sources.length; right += 1) {
      const [first, second] = [sources[left], sources[right]];
      if (first.author !== second.author && isDuplicatePrompt(first.text, second.text)) {
        addAligned(first, [first.author, second.author], [first.ref, second.ref]);
      }
    }
  }
  output.aligned = [...alignedByAnchor.values()].slice(0, SUMMARY_LIMITS.aligned);

  // Divergent ----------------------------------------------------------------
  const divergentByAnchor = new Map();
  const addDivergent = (anchor, against) => {
    const entry = divergentByAnchor.get(anchor.ref) ?? {
      issue: `Whether to go with: "${firstSentence(anchor.text, 160)}"`,
      positions: [{ actors: backers(anchor), sources: [anchor.ref], summary: firstSentence(anchor.text) }],
    };
    entry.positions.push(against);
    divergentByAnchor.set(anchor.ref, entry);
  };
  for (const source of sources) {
    const downvoters = unique(source.downvotedBy ?? []);
    if (downvoters.length > 0) {
      addDivergent(source, { actors: downvoters, sources: [source.ref], summary: 'Voted against this.' });
    }
  }
  for (const reply of sources) {
    if (!DISAGREE.test(reply.text)) continue;
    const parent = reply.replyTo
      ? byRef.get(reply.replyTo)
      : sources.slice(0, sources.indexOf(reply)).find((candidate) => candidate.author !== reply.author);
    if (!parent || parent.author === reply.author) continue;
    addDivergent(parent, { actors: backers(reply), sources: [reply.ref], summary: firstSentence(reply.text) });
  }
  output.divergent = [...divergentByAnchor.values()]
    .map((entry) => ({ ...entry, positions: entry.positions.slice(0, SUMMARY_LIMITS.positions) }))
    .slice(0, SUMMARY_LIMITS.divergent);

  // Under-explored and outstanding -------------------------------------------
  const roles = new Set(sources.map((source) => people.get(source.author)?.role));
  const prompt = firstSentence(content.subject?.prompt ?? 'this topic', 160);
  if (!roles.has('client stakeholder')) {
    output.underExplored.push({
      area: 'Client stakeholders\' view',
      suggestedQuestion: `What do client stakeholders need from "${prompt}"?`,
      why: 'Only team members have commented so far.',
    });
  }
  if (!roles.has('team member')) {
    output.underExplored.push({
      area: 'Delivery team\'s view',
      suggestedQuestion: 'What would it take to deliver this, and what would it rule out?',
      why: 'Only client stakeholders have commented so far.',
    });
  }

  const owner = (content.people ?? []).find((person) => person.topicRole === 'owner')?.ref ?? null;
  const authority = (content.people ?? []).find((person) => person.standing === 'required')?.ref ?? null;
  for (const entry of output.divergent) {
    output.outstanding.push({
      blocking: true,
      item: `Settle the disagreement: ${entry.issue}`,
      sources: unique(entry.positions.flatMap((position) => position.sources)),
      suggestedOwnerRole: String(content.subject?.suggestedOwnerRole ?? '').trim() || 'Product owner',
      waitingOn: owner ? [owner] : [],
    });
  }
  const answered = new Set(sources.map((source) => source.replyTo).filter(Boolean));
  for (const source of sources) {
    if (source.text.trim().endsWith('?') && !answered.has(source.ref)) {
      output.outstanding.push({
        blocking: false,
        item: `Answer the open question in ${source.ref}.`,
        sources: [source.ref],
        suggestedOwnerRole: '',
        waitingOn: owner && owner !== source.author ? [owner] : [],
      });
    }
  }
  output.outstanding = output.outstanding.slice(0, SUMMARY_LIMITS.outstanding);

  // Feedback themes (rounds and screens) -----------------------------------------
  // Annotations grouped by the feedback dimension they name ("about Color"), each comment
  // with the annotation its thread starts from.
  if (modelInput?.scope?.type !== 'topic') {
    const themeOf = new Map();
    const themes = new Map();
    const rootOf = (source) => {
      let current = source;
      const seen = new Set();
      while (current?.replyTo && !seen.has(current.ref)) {
        seen.add(current.ref);
        current = byRef.get(current.replyTo) ?? null;
      }
      return current;
    };
    for (const source of sources.filter((entry) => entry.kind === 'annotation')) {
      const theme = /, about ([^,.]+)/.exec(source.text)?.[1]?.trim() || 'General feedback';
      themeOf.set(source.ref, theme);
      const entry = themes.get(theme) ?? { detail: '', sources: [], theme };
      entry.sources.push(source.ref);
      themes.set(theme, entry);
    }
    for (const source of sources.filter((entry) => entry.kind === 'annotation-comment')) {
      const theme = themeOf.get(rootOf(source)?.ref);
      if (theme) themes.get(theme).sources.push(source.ref);
    }
    output.feedbackThemes = [...themes.values()]
      .sort((left, right) => right.sources.length - left.sources.length)
      .slice(0, SUMMARY_LIMITS.feedbackThemes)
      .map((entry) => ({
        ...entry,
        detail: `${entry.sources.length} ${entry.sources.length === 1 ? 'mark or comment' : 'marks and comments'}, starting with: ${firstSentence(byRef.get(entry.sources[0])?.text ?? '', 160)}`,
        sources: entry.sources.slice(0, SUMMARY_LIMITS.refsPerTheme),
      }));
  }

  // Proposed answer ----------------------------------------------------------
  // The aligned point with the most net support (supporters minus downvotes on its anchor
  // source), once at least two people back it. Ties go to the earlier point. Without one,
  // the owner's latest statement nobody voted against, as the owner's answer, or without an
  // owner a lone client stakeholder's, awaiting confirmation.
  let best = null;
  for (const entry of output.aligned) {
    const anchor = byRef.get(entry.sources[0]);
    const score = entry.supporters.length - unique(anchor?.downvotedBy ?? []).length;
    if (score >= 2 && (!best || score > best.score)) best = { entry, score };
  }
  if (best) {
    output.proposedAnswer = best.entry.statement;
    output.proposedAnswerSources = [...best.entry.sources];
    output.proposedAnswerStatus = 'agreed';
    return output;
  }
  const authors = unique(sources.map((source) => source.author));
  const loneClient = authors.length === 1 && people.get(authors[0])?.role === 'client stakeholder' ? authors[0] : null;
  const answerer = owner ?? authority ?? loneClient;
  const answer = [...sources].reverse().find((source) => source.author === answerer && (source.downvotedBy ?? []).length === 0
    && !source.text.trim().endsWith('?'));
  if (answer && output.divergent.length === 0) {
    output.proposedAnswer = firstSentence(answer.text);
    output.proposedAnswerSources = [answer.ref];
    output.proposedAnswerStatus = owner ? 'owner-answered' : (authority ? 'authority-answered' : 'awaiting-confirmation');
  }
  return output;
}

export function createLocalFixtureSummaryAi() {
  return {
    provider: 'local-fixture',
    async summarize({ modelInput }) {
      return { model: 'local-fixture', output: summarizeWithLocalFixture(modelInput) };
    },
  };
}
