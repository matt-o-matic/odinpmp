// Polls for the channels fixture (channels-api.js): a post's `poll` as the API presents it to one
// viewer, and the vote and close routes. The tallies follow backend/src/modules/channels/polls.js
// (Borda points for rankings, grouped written answers, rating averages); backend/test/polls.test.js
// checks the real ones. world.pollVotes holds { postId, userId, answer }.

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/** A new post's poll from what the composer sent, with option ids as the server gives them. */
export function storedPoll(input) {
  return {
    closedAt: null,
    closesAt: input.closesAt ?? null,
    kind: input.kind,
    options: (input.options ?? []).map((label, index) => ({ id: `o${index + 1}`, label })),
    question: input.question,
    settings: { anonymous: Boolean(input.settings?.anonymous), maxChoices: input.settings?.maxChoices ?? null, scaleMax: input.kind === 'rating' ? (input.settings?.scaleMax ?? 5) : null, showResults: input.settings?.showResults ?? 'always' },
  };
}

function tally(poll, votes, named, nameOf) {
  const voterCount = votes.length;
  const who = (vote) => nameOf(vote.userId);
  const share = (count) => (voterCount ? round(count / voterCount, 4) : 0);
  if (poll.kind === 'single' || poll.kind === 'multiple') {
    return { kind: poll.kind, voterCount, options: poll.options.map((option) => {
      const chose = votes.filter((vote) => vote.answer.optionIds.includes(option.id));
      return { count: chose.length, id: option.id, label: option.label, share: share(chose.length), ...(named ? { voters: chose.map(who) } : {}) };
    }) };
  }
  if (poll.kind === 'ranking') {
    const n = poll.options.length;
    const options = poll.options.map((option) => {
      const ranks = votes.map((vote) => vote.answer.order.indexOf(option.id) + 1);
      return { averageRank: ranks.length ? round(ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length) : null, id: option.id, label: option.label, points: ranks.reduce((sum, rank) => sum + (n - rank), 0) };
    }).sort((left, right) => right.points - left.points);
    const best = (n - 1) * voterCount;
    return { kind: 'ranking', maxPoints: best, voterCount, options: options.map((option, index) => ({ ...option, place: index + 1, share: best ? round(option.points / best, 4) : 0 })) };
  }
  if (poll.kind === 'text') {
    const groups = new Map();
    for (const vote of votes) {
      const group = groups.get(vote.answer.text.toLowerCase()) ?? { count: 0, text: vote.answer.text, voters: [] };
      group.count += 1;
      group.voters.push(who(vote));
      groups.set(vote.answer.text.toLowerCase(), group);
    }
    return { kind: 'text', voterCount, answers: [...groups.values()].sort((left, right) => right.count - left.count).map(({ count, text, voters }) => ({ count, share: share(count), text, ...(named ? { voters } : {}) })) };
  }
  const values = votes.map((vote) => vote.answer.value);
  return {
    average: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    distribution: Array.from({ length: poll.settings.scaleMax }, (_, index) => {
      const gave = votes.filter((vote) => vote.answer.value === index + 1);
      return { count: gave.length, share: share(gave.length), value: index + 1, ...(named ? { voters: gave.map(who) } : {}) };
    }),
    kind: 'rating',
    scaleMax: poll.settings.scaleMax,
    voterCount,
  };
}

/** The poll on `post` as `userId` sees it. */
export function presentPoll(world, post, userId, nameOf) {
  const poll = post.poll;
  const votes = (world.pollVotes ?? []).filter((vote) => vote.postId === post.id);
  const mine = votes.find((vote) => vote.userId === userId) ?? null;
  const closed = Boolean(poll.closedAt) || (poll.closesAt ? new Date(poll.closesAt) <= new Date() : false);
  const isAuthor = post.authorId === userId;
  const sees = closed || Boolean(mine) || isAuthor || poll.settings.showResults !== 'after_vote';
  return {
    canClose: !closed && (isAuthor || world.canDecide === true),
    canVote: !closed && world.canVotePolls !== false,
    closed,
    closedAt: poll.closedAt,
    closesAt: poll.closesAt,
    kind: poll.kind,
    myAnswer: mine?.answer ?? null,
    options: poll.options,
    question: poll.question,
    results: sees ? tally(poll, votes, !poll.settings.anonymous, nameOf) : null,
    resultsHidden: !sees,
    settings: poll.settings,
    voterCount: votes.length,
  };
}

/** PUT /posts/:id/poll/vote and POST /posts/:id/poll/close, or null for another route. */
export function pollRoute(world, { method, postId, action, body, userId, nameOf }) {
  const post = world.posts.find((entry) => entry.id === postId);
  if (!post?.poll) return { body: { details: { code: 'poll_not_found' }, error: 'That poll is not here.', ok: false }, status: 404 };
  if (action === 'vote' && method === 'PUT') {
    world.pollVotes = (world.pollVotes ?? []).filter((vote) => !(vote.postId === postId && vote.userId === userId));
    world.pollVotes.push({ answer: body.answer, postId, userId });
  } else if (action === 'close' && method === 'POST') {
    post.poll.closedAt = new Date().toISOString();
  } else {
    return null;
  }
  return { body: { channelId: post.targetId, ok: true, poll: presentPoll(world, post, userId, nameOf), postId }, status: 200 };
}
