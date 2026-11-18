function uniqueStrings(values = []) {
  return [...new Set((values ?? []).map((value) => String(value ?? '').trim()).filter(Boolean))];
}

export function normalizeCoverageText(value = '') {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function coverageWordCount(value = '') {
  return normalizeCoverageText(value)
    .replace(/[^a-z0-9\s]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function hasAnyPattern(text = '', patterns = []) {
  return (patterns ?? []).some((pattern) => pattern.test(text));
}

function countPatternMatches(text = '', pattern) {
  return (String(text ?? '').match(pattern) ?? []).length;
}

function buildSectionPatterns(...labels) {
  const normalizedLabels = labels.flat().filter(Boolean);
  return normalizedLabels.flatMap((label) => {
    const fragment = String(label ?? '').trim();
    if (!fragment) {
      return [];
    }

    return [
      new RegExp(`(^|\\n)\\s*#{1,6}\\s*${fragment}\\b`, 'im'),
      new RegExp(`(^|\\n)\\s*(?:\\*\\*|__)?\\s*${fragment}\\s*(?:\\*\\*|__)?\\s*:`, 'im'),
      new RegExp(`(^|\\n)\\s*(?:\\*\\*|__)?\\s*${fragment}\\s*(?:\\*\\*|__)?\\s*$`, 'im'),
    ];
  });
}

const workItemDescriptionCoverageRules = {
  epic: {
    checks: [
      {
        label: 'what we are trying to accomplish',
        patterns: [
          ...buildSectionPatterns('(summary|objective|goal)'),
          /\bwhat are we trying to accomplish\b/i,
          /^\s*(define|create|build|establish|deliver|enable)\b[\s\S]{0,200}\b(for|to)\b/i,
        ],
      },
      {
        label: 'business outcome',
        patterns: [
          ...buildSectionPatterns('business outcome', 'outcome'),
          /\bwhy (this|it) matters\b/i,
          /\b(?:intended|desired|target) outcome\b/i,
          /\b(?:increase|improve|reduce|lower|grow)\b/i,
        ],
      },
      {
        label: 'users or stakeholders',
        patterns: [
          ...buildSectionPatterns('(users? ?\\/ ?stakeholders?|stakeholders?|users?)'),
          /\bwho benefits or is impacted\b/i,
          /\bprimary stakeholders?\b/i,
          /\bprimary users?\b/i,
        ],
      },
      {
        label: 'scope',
        patterns: [...buildSectionPatterns('scope', 'in scope'), /\bwhat is included\b/i, /\bscope includes\b/i],
      },
      {
        label: 'out of scope boundary',
        patterns: [...buildSectionPatterns('out of scope'), /\bintentionally not doing\b/i, /\bnot in scope\b/i, /\bout of scope\b/i],
      },
      {
        label: 'success criteria',
        patterns: [...buildSectionPatterns('success criteria'), /\bhow will we know\b/i, /\bmeasures? of success\b/i, /\bsuccess means\b/i, /\bsuccess looks like\b/i],
      },
      {
        label: 'dependencies or risks',
        patterns: [
          ...buildSectionPatterns('dependencies? ?\\/ ?risks?', 'risks?', 'dependencies'),
          /\bwhat could block or shape the work\b/i,
          /\bkey dependencies?\b/i,
          /\bkey risks?\b/i,
          /\brisks include\b/i,
        ],
      },
    ],
    minimumWords: 45,
  },
  story: {
    checks: [
      {
        label: 'user, capability, and outcome',
        test(text) {
          return /as a\b/i.test(text) && /i want\b/i.test(text) && /so that\b/i.test(text);
        },
      },
      {
        label: 'context',
        patterns: [...buildSectionPatterns('context'), /\bwhy is this needed\b/i],
      },
      {
        label: 'acceptance criteria',
        test(text) {
          const hasHeading = hasAnyPattern(text, buildSectionPatterns('acceptance criteria'));
          const givenWhenThenCount = countPatternMatches(text, /\bgiven\b[\s\S]{0,240}?\bwhen\b[\s\S]{0,240}?\bthen\b/gi);
          const bulletCount = countPatternMatches(text, /^\s*[-*]\s+/gm);
          return hasHeading && (givenWhenThenCount >= 2 || bulletCount >= 2);
        },
      },
      {
        label: 'business rules',
        patterns: [...buildSectionPatterns('business rules'), /\bpermissions?, calculations?, or edge cases\b/i],
      },
      {
        label: 'ux or content notes',
        patterns: [...buildSectionPatterns('ux ?\\/ ?content notes', 'ux notes'), /\bscreens?, labels?, states?, messages?\b/i],
      },
      {
        label: 'technical notes',
        patterns: [...buildSectionPatterns('technical notes'), /\bapi, data, integration, logging, analytics, or architecture considerations\b/i],
      },
      {
        label: 'dependencies',
        patterns: [...buildSectionPatterns('dependencies'), /\bwhat must exist first\b/i],
      },
      {
        label: 'out of scope boundary',
        patterns: [...buildSectionPatterns('out of scope'), /\bshould not be handled in this story\b/i, /\bnot handled in this story\b/i],
      },
    ],
    minimumWords: 65,
  },
  task: {
    checks: [
      {
        label: 'objective',
        patterns: [...buildSectionPatterns('objective'), /\bwhat specific piece of work needs to be completed\b/i],
      },
      {
        label: 'implementation notes',
        patterns: [...buildSectionPatterns('implementation notes'), /\brelevant technical direction, constraints, or known approach\b/i],
      },
      {
        label: 'affected areas',
        patterns: [...buildSectionPatterns('affected areas'), /\bfiles?, services?, components?, apis?, database tables?, configs?, or environments?\b/i],
      },
      {
        label: 'testing notes',
        patterns: [...buildSectionPatterns('testing notes'), /\bwhat should be verified\b/i],
      },
      {
        label: 'definition of done',
        test(text) {
          return hasAnyPattern(text, buildSectionPatterns('definition of done'))
            && countPatternMatches(text, /^\s*[-*]\s+/gm) >= 3;
        },
      },
    ],
    minimumWords: 35,
  },
};

export function collectWorkItemDescriptionCoverageGaps(itemType = 'task', description = '') {
  const text = normalizeCoverageText(description);
  const rules = workItemDescriptionCoverageRules[itemType];
  if (!rules) {
    return [];
  }

  const missing = [];
  if (coverageWordCount(text) < rules.minimumWords) {
    missing.push(`more actionable detail (${rules.minimumWords}+ words)`);
  }

  for (const check of rules.checks) {
    const passed = typeof check.test === 'function'
      ? check.test(text)
      : hasAnyPattern(text, check.patterns ?? []);
    if (!passed) {
      missing.push(check.label);
    }
  }

  return missing;
}

export function containsPlaceholderText(value = '') {
  return /\[PLACEHOLDER\]/i.test(String(value ?? '').trim());
}

export function hasSyntheticWorkItemName(name = '', itemType = 'task') {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const escapedType = String(itemType ?? 'task').trim().toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  return new RegExp(`^${escapedType}[\\s:_-]+[0-9a-f]{6,}$`, 'i').test(normalized);
}

function normalizeComparisonTokens(value = '') {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export function storyLikelyRehashesParent(story = {}, parentEpic = {}) {
  const storyNameTokens = normalizeComparisonTokens(story?.name ?? '');
  const epicNameTokens = normalizeComparisonTokens(parentEpic?.name ?? '');
  const storyDescriptionTokens = normalizeComparisonTokens(story?.description ?? '');
  const epicDescriptionTokens = normalizeComparisonTokens(parentEpic?.description ?? '');

  const sharedNameTokens = storyNameTokens.filter((token) => epicNameTokens.includes(token));
  if (
    storyNameTokens.length > 0
    && sharedNameTokens.length === storyNameTokens.length
    && storyNameTokens.length === epicNameTokens.length
  ) {
    return true;
  }

  const sharedDescriptionTokens = storyDescriptionTokens.filter((token) => epicDescriptionTokens.includes(token));
  return storyDescriptionTokens.length > 0
    && storyDescriptionTokens.length <= 18
    && sharedDescriptionTokens.length >= Math.max(6, Math.floor(storyDescriptionTokens.length * 0.75));
}

export function isUsableStory(story = {}, parentEpic = {}) {
  if (hasSyntheticWorkItemName(story?.name, 'story')) {
    return false;
  }
  if (containsPlaceholderText(story?.name) || containsPlaceholderText(story?.description)) {
    return false;
  }
  if (collectWorkItemDescriptionCoverageGaps('story', story?.description).length > 0) {
    return false;
  }
  if (storyLikelyRehashesParent(story, parentEpic)) {
    return false;
  }
  return true;
}
