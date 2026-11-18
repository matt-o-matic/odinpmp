// Polls on posts (docs/engagements/plan.md, Polls), for channels and direct messages alike. The
// channel and DM services own the post; this adds its poll, takes votes and closes it.
//
// Rights: anyone who can post where the poll is can vote, guests in their channels included.
// The author, or someone with decision rights on the project, can close it early. Voter ids are
// stored so each person votes once, but an anonymous poll never returns who voted, to anyone.
import { HttpError } from '../../lib/errors/http-error.js';
import { normalizeAnswer, normalizePollInput, pollIsClosed, tallyPoll } from './polls.js';

const isPrincipal = (ctx, type, id) => ctx.principal.type === type && ctx.principal.id === id;

/** A new poll checked for a post: polls start a conversation, so a reply can't be one. */
export function preparePoll(input, { now = new Date() } = {}) {
  if (!input.poll) return null;
  if (input.parentId) throw new HttpError(400, 'A poll starts its own thread. Post it as a new message.', { details: { code: 'poll_in_reply' } });
  return normalizePollInput(input.poll, { now });
}

/** The post's body when the person wrote nothing above the poll: its question. */
export function pollBody(body, poll) {
  const text = String(body ?? '').trim();
  return text || (poll ? poll.question : text);
}

export async function savePoll(deps, ctx, post, poll) {
  if (!poll) return null;
  return deps.projectRepository.createPoll({ poll: { ...poll, postId: post.id, tenantId: ctx.tenantId } });
}

/** The poll as one viewer sees it. `open` is false in an archived channel. */
export function presentPoll(poll, votes, ctx, { authorType, authorId, now = new Date(), open = true } = {}) {
  const closed = pollIsClosed(poll, now);
  const mine = votes.find((vote) => isPrincipal(ctx, vote.voterType, vote.voterId)) ?? null;
  const isAuthor = isPrincipal(ctx, authorType, authorId);
  const seesResults = closed || Boolean(mine) || isAuthor || poll.settings.showResults !== 'after_vote';
  return {
    canClose: open && !closed && ((isAuthor && ctx.canCollaborate) || Boolean(ctx.canDecide)),
    canVote: open && !closed && Boolean(ctx.canCollaborate),
    closed,
    closedAt: poll.closedAt ?? (closed ? poll.closesAt : null),
    closesAt: poll.closesAt ?? null,
    kind: poll.kind,
    myAnswer: mine?.answer ?? null,
    options: poll.options,
    question: poll.question,
    results: seesResults ? tallyPoll(poll, votes, { named: !poll.settings.anonymous }) : null,
    resultsHidden: !seesResults,
    settings: { anonymous: Boolean(poll.settings.anonymous), maxChoices: poll.settings.maxChoices ?? null, scaleMax: poll.settings.scaleMax ?? null, showResults: poll.settings.showResults ?? 'always' },
    voterCount: votes.length,
  };
}

/**
 * Each poll post's `poll`, merged into the extras presentPost spreads (the Odin fields stay).
 * Posts without a poll are left as they are.
 */
export async function withPolls(deps, ctx, posts, extras = new Map(), { open = true, now = new Date() } = {}) {
  if (!posts.length || !deps.projectRepository.listPolls) return extras;
  const postIds = posts.filter((post) => !post.deletedAt).map((post) => post.id);
  const polls = await deps.projectRepository.listPolls({ postIds, tenantId: ctx.tenantId });
  if (!polls.length) return extras;
  const votes = await deps.projectRepository.listPollVotes({ postIds: polls.map((poll) => poll.postId), tenantId: ctx.tenantId });
  const byPost = new Map(posts.map((post) => [post.id, post]));
  const merged = new Map(extras);
  for (const poll of polls) {
    const post = byPost.get(poll.postId);
    merged.set(poll.postId, { ...(merged.get(poll.postId) ?? {}), poll: presentPoll(poll, votes.filter((vote) => vote.postId === poll.postId), ctx, { authorId: post?.authorId, authorType: post?.authorType, now, open }) });
  }
  return merged;
}

async function requirePoll(deps, ctx, post) {
  const [poll] = post && !post.deletedAt ? await deps.projectRepository.listPolls({ postIds: [post.id], tenantId: ctx.tenantId }) : [];
  if (!poll) throw new HttpError(404, 'That poll is not here.', { details: { code: 'poll_not_found' } });
  return poll;
}

async function presentOne(deps, ctx, post, poll, open) {
  const votes = await deps.projectRepository.listPollVotes({ postIds: [post.id], tenantId: ctx.tenantId });
  return presentPoll(poll, votes, ctx, { authorId: post.authorId, authorType: post.authorType, open });
}

/** The poll on a post, as the viewer sees it. */
export async function readPoll(deps, ctx, post, { open = true } = {}) {
  return presentOne(deps, ctx, post, await requirePoll(deps, ctx, post), open);
}

/** Records the viewer's vote, replacing any earlier one, while the poll is open. */
export async function votePoll(deps, ctx, post, answer, { open = true } = {}) {
  const poll = await requirePoll(deps, ctx, post);
  if (!open) throw new HttpError(409, 'This conversation is archived.', { details: { code: 'channel_archived' } });
  if (!ctx.canCollaborate) throw new HttpError(403, 'You can read this poll, but not vote in it.', { details: { code: 'poll_read_only' } });
  if (pollIsClosed(poll)) throw new HttpError(409, 'This poll is closed.', { details: { code: 'poll_closed' } });
  await deps.projectRepository.setPollVote({
    answer: normalizeAnswer(poll, answer),
    postId: post.id,
    tenantId: ctx.tenantId,
    voterId: ctx.principal.id,
    voterName: ctx.principal.name ?? '',
    voterType: ctx.principal.type,
  });
  return presentOne(deps, ctx, post, poll, open);
}

/** Closes the poll early: its author, or someone with decision rights. */
export async function closePoll(deps, ctx, post, { open = true } = {}) {
  const poll = await requirePoll(deps, ctx, post);
  if (!open) throw new HttpError(409, 'This conversation is archived.', { details: { code: 'channel_archived' } });
  const isAuthor = isPrincipal(ctx, post.authorType, post.authorId);
  if (!((isAuthor && ctx.canCollaborate) || ctx.canDecide)) throw new HttpError(403, 'Only the person who made the poll, or a project admin or manager, can close it.', { details: { code: 'poll_close_forbidden' } });
  const saved = pollIsClosed(poll) ? poll : await deps.projectRepository.closePoll({ closedBy: `${ctx.principal.type}:${ctx.principal.id}`, postId: post.id, tenantId: ctx.tenantId });
  return presentOne(deps, ctx, post, saved, open);
}
