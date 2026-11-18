// Where a guest's tasks come from (docs/engagements/plan.md, Pursuit board; qna.md Q-06).
//
// The pursuit board decides which tasks an outside person sees: the tasks assigned to them, or
// every pursuit task when the engagement's `guests_see_board` setting is on; they change only
// their own. It supplies that rule as a task source (pursuit/pursuit-guest-tasks.js), which the
// app passes to the guest routes as `guestTaskSource`:
//
//   {
//     available: true,
//     // Tasks the guest sees on the project. stakeholderIds are the guest's stakeholder records
//     // there; accessLinkId and email are their workspace identity.
//     async listTasksForGuest({ accessLinkId, email, projectId, stakeholderIds, tenantId })
//       -> { tasks: [{ id, name, status, dueDate, priority, assigneeName, assignedToMe,
//                      canUpdate, canComment, canAttach }], statuses, wholeBoard },
//     // A task the guest sees; with `change` ('status', 'comment' or 'attachment') one of their
//     // own. Throws 404 for a task they don't see and 403 `not_your_task` for one they don't own.
//     async requireTaskForGuest({ change, projectId, stakeholderIds, taskId, tenantId }) -> { task },
//     // `actor` is { stakeholderId, name }: the guest writes as their stakeholder.
//     async updateTaskForGuest({ actor, input: { status }, projectId, stakeholderIds, taskId, tenantId }) -> { task },
//     async listTaskCommentsForGuest({ actor, projectId, stakeholderIds, taskId, tenantId }) -> { canComment, comments },
//     async addTaskCommentForGuest({ actor, input: { text }, projectId, stakeholderIds, taskId, tenantId }) -> { comment },
//   }
//
// The guest routes check that the guest is in a channel of the project before asking, and
// guests.service.js reads and adds a task's files through requireTaskForGuest. Without a source
// (NO_GUEST_TASKS), guests see no tasks and the guest view shows none.

export const NO_GUEST_TASKS = Object.freeze({
  available: false,
  async listTasksForGuest() {
    return { tasks: [], wholeBoard: false };
  },
});
