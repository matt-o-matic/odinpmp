// One guided review, two audiences. The adapter hides whether the review talks to the team
// API (a signed-in member, /requirements/rounds/:roundId/review) or the client portal
// (/api/public/requirements/:token/rounds/:roundId), and where its live updates come from
// (the shared project stream, or the link's own stream).

import { withWorkingMode } from '../api/client.js';
import { REVIEW_EVENT_TYPES, createReviewLiveFeed } from './review-live.js';

export function reviewScope({ portalToken = '', projectId = '', roundId }) {
  return portalToken ? { portalToken: String(portalToken), roundId: String(roundId) } : { projectId: String(projectId), roundId: String(roundId) };
}

/**
 * `getToken()` returns the session token for team requests (ignored for the portal).
 * `liveFeed` is a feed from createReviewLiveFeed; the adapter only listens to it.
 */
export function createReviewAdapter({ apiClient, getToken = () => undefined, liveFeed = null, scope }) {
  const audience = scope.portalToken ? 'portal' : 'team';
  // Autosave and refetches run in the background: no "Working…" banner for each keystroke.
  const quiet = () => withWorkingMode(apiClient, 'passive');
  const token = () => (audience === 'team' ? getToken() : undefined);

  return {
    audience,
    scope,
    load({ passive = false } = {}) {
      return (passive ? quiet() : apiClient).getRequirementsReview(scope, token());
    },
    savePosition(position) {
      return quiet().saveRequirementsReviewPosition(scope, position, token());
    },
    saveDirection(directionId, payload) {
      return quiet().saveRequirementsReviewDirection(scope, directionId, payload, token());
    },
    clearDirection(directionId) {
      return quiet().clearRequirementsReviewDirection(scope, directionId, token());
    },
    saveVerdict(screenId, payload) {
      return quiet().saveRequirementsReviewVerdict(scope, screenId, payload, token());
    },
    clearVerdict(screenId) {
      return quiet().clearRequirementsReviewVerdict(scope, screenId, token());
    },
    saveAnswer(questionId, value) {
      return quiet().saveRequirementsReviewAnswer(scope, questionId, { value }, token());
    },
    clearAnswer(questionId) {
      return quiet().clearRequirementsReviewAnswer(scope, questionId, token());
    },
    saveAnnotation(annotationId, payload) {
      return quiet().saveRequirementsReviewAnnotation(scope, annotationId, payload, token());
    },
    deleteAnnotation(annotationId) {
      return quiet().deleteRequirementsReviewAnnotation(scope, annotationId, token());
    },
    setAnnotationStatus(annotationId, status) {
      return quiet().setRequirementsReviewAnnotationStatus(scope, annotationId, { status }, token());
    },
    carryAnnotation(annotationId) {
      return quiet().carryRequirementsReviewAnnotation(scope, annotationId, token());
    },
    closeAnnotation(annotationId) {
      return quiet().closeRequirementsReviewAnnotation(scope, annotationId, token());
    },
    /** People this reviewer may tag in an annotation's thread. */
    async mentionables(annotationId) {
      const result = await quiet().listRequirementsReviewAnnotationMentionables(scope, annotationId, token());
      return result.people ?? [];
    },
    addComment(annotationId, { body, parentCommentId = '' }) {
      return quiet().commentRequirementsReviewAnnotation(scope, annotationId, { body, parentCommentId }, token());
    },
    editComment(annotationId, commentId, { body }) {
      return quiet().updateRequirementsReviewAnnotationComment(scope, annotationId, commentId, { body }, token());
    },
    deleteComment(annotationId, commentId) {
      return quiet().deleteRequirementsReviewAnnotationComment(scope, annotationId, commentId, token());
    },
    uploadSnapshot(blob, { screenId, stateKey }) {
      return quiet().uploadRequirementsReviewSnapshot(scope, blob, { screenId, stateKey: stateKey ?? '' }, token());
    },
    /** Resolves to a Blob of a stored snapshot. */
    async loadSnapshot(path) {
      const result = await quiet().getRequirementsReviewSnapshot(path, token());
      return result.blob;
    },
    submit() {
      return apiClient.submitRequirementsReview(scope, token());
    },
    /** Live batches for this round; returns a stop function. */
    listen(listener) {
      return liveFeed ? liveFeed.listen(listener) : () => {};
    },
  };
}

const ROUND_TYPES = new Set([REVIEW_EVENT_TYPES.review, REVIEW_EVENT_TYPES.rounds]);

/** The team's live feed: the shared project stream, round events only. */
export function createTeamReviewFeed({ apiClient, getToken, projectId, timers }) {
  return createReviewLiveFeed({
    open: (handlers) => apiClient.subscribeToProjectEvents(projectId, getToken(), handlers),
    relevant: (type) => ROUND_TYPES.has(type),
    timers,
  });
}

/** The portal's live feed: the link's own stream, every requirements event. */
export function createPortalFeed({ apiClient, portalToken, timers }) {
  return createReviewLiveFeed({
    open: (handlers) => apiClient.subscribeToRequirementsPortalEvents(portalToken, handlers),
    timers,
  });
}
