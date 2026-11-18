import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BEHIND_BELOW_DONE_SHARE,
  BEHIND_FROM_ELAPSED,
  HEALTH_KINDS,
  PERSON_OVERDUE_ITEMS_BEHIND,
  PROJECT_MILESTONE_LOOKAHEAD_DAYS,
  evaluatePersonHealth,
  evaluateProjectHealth,
  evaluateSprintHealth,
  evaluateSprintPeople,
  isBehindPace,
  mostSpecificSignal,
  sprintTimeElapsed,
  summarizeHealth,
  workingDaysBefore,
} from '../src/lib/projects/health-signals.js';

// Monday 2026-10-05 to Friday 2026-10-16: ten working days. Monday 2026-10-12 is halfway.
const sprint = { endDate: '2026-10-16', id: 'sprint-14', name: 'Sprint 14', startDate: '2026-10-05', status: 'active' };
const items = (donePoints, totalPoints = 20) => [
  { done: true, points: donePoints },
  { done: false, points: totalPoints - donePoints },
];

test('the behind start point and threshold are named constants', () => {
  assert.equal(BEHIND_FROM_ELAPSED, 0.5);
  assert.equal(BEHIND_BELOW_DONE_SHARE, 0.5);
  assert.equal(PERSON_OVERDUE_ITEMS_BEHIND, 2);
  assert.equal(PROJECT_MILESTONE_LOOKAHEAD_DAYS, 30);
});

test('working days before a day skip weekends and holidays', () => {
  assert.equal(workingDaysBefore('2026-10-05', '2026-10-05'), 0);
  assert.equal(workingDaysBefore('2026-10-05', '2026-10-12'), 5);
  assert.equal(workingDaysBefore('2026-10-05', '2026-10-12', { holidays: ['2026-10-07'] }), 4);
});

test('elapsed counts working days gone with the calendar, else Monday to Friday', () => {
  assert.deepEqual(sprintTimeElapsed({ sprint, today: '2026-10-12' }), { daysGone: 5, elapsed: 0.5, sprintDays: 10, started: true });
  // A holiday shortens the sprint to nine working days, four of them gone.
  assert.equal(sprintTimeElapsed({ calendar: { holidays: ['2026-10-07'] }, sprint, today: '2026-10-12' }).elapsed, 4 / 9);
  // A six-day week counts Saturday.
  assert.equal(sprintTimeElapsed({ calendar: { workingDays: [1, 2, 3, 4, 5, 6] }, sprint, today: '2026-10-12' }).daysGone, 6);
  assert.deepEqual(sprintTimeElapsed({ sprint, today: '2026-10-01' }), { daysGone: 0, elapsed: 0, sprintDays: 10, started: false });
  assert.equal(sprintTimeElapsed({ sprint, today: '2026-10-20' }).elapsed, 1);
  assert.equal(sprintTimeElapsed({ sprint: { id: 'x' }, today: '2026-10-12' }), null);
});

test('from halfway, closing less than half of the assigned points is behind', () => {
  // 30 points assigned, 7 closed at the halfway point: the line is 15.
  assert.equal(isBehindPace({ assigned: 30, closed: 7, elapsed: 0.5 }), true);
  // 50 points assigned: the line is 25.
  assert.equal(isBehindPace({ assigned: 50, closed: 24, elapsed: 0.5 }), true);
  assert.equal(isBehindPace({ assigned: 50, closed: 25, elapsed: 0.5 }), false);
  // Exactly half is not behind.
  assert.equal(isBehindPace({ assigned: 30, closed: 15, elapsed: 0.9 }), false);
  // Before halfway nobody is behind, even with nothing closed.
  assert.equal(isBehindPace({ assigned: 30, closed: 0, elapsed: 0.4 }), false);
  // Nothing assigned is never behind.
  assert.equal(isBehindPace({ assigned: 0, closed: 0, elapsed: 1 }), false);
});

test('each person in a sprint is judged on the points assigned to them now', () => {
  const sprintItems = [
    { assigneeId: 'user-sam', done: true, points: 7 },
    { assigneeId: 'user-sam', done: false, points: 23 },
    { assigneeId: 'user-dana', done: true, points: 30 },
    { assigneeId: 'user-dana', done: false, points: 20 },
    { assigneeId: null, done: false, points: 5 },
  ];
  const halfway = evaluateSprintPeople({ items: sprintItems, sprint, today: '2026-10-12' });
  assert.equal(halfway.elapsed, 0.5);
  assert.equal(halfway.unit, 'points');
  assert.deepEqual(halfway.people, [
    { assigned: 30, behind: true, closed: 7, id: 'user-sam', threshold: 15 },
    { assigned: 50, behind: false, closed: 30, id: 'user-dana', threshold: 25 },
  ]);
  // The sprint total includes unassigned work: 37 of 85 closed, under the 42.5 line.
  assert.deepEqual(halfway.total, { assigned: 85, behind: true, closed: 37, threshold: 42.5 });

  // The day before halfway (four of ten days gone) nobody is behind.
  const early = evaluateSprintPeople({ items: sprintItems, sprint, today: '2026-10-09' });
  assert.equal(early.elapsed, 0.4);
  assert.equal(early.people.some((person) => person.behind), false);
  assert.equal(early.total.behind, false);

  // Moving 17 of Sam's open points out of the sprint brings his line down to 6.5.
  const lighter = evaluateSprintPeople({ items: [sprintItems[0], { ...sprintItems[1], points: 6 }], sprint, today: '2026-10-12' });
  assert.deepEqual(lighter.people[0], { assigned: 13, behind: false, closed: 7, id: 'user-sam', threshold: 6.5 });
});

test('a sprint is behind from halfway when less than half of its points are done', () => {
  // Day 7: six of ten working days gone (60%); 8 of 20 points done (40%).
  const signal = evaluateSprintHealth({ items: items(8), projectId: 'project-1', sprint, today: '2026-10-13' });
  assert.equal(signal.kind, HEALTH_KINDS.BEHIND);
  assert.equal(signal.scope, 'sprint');
  assert.deepEqual(signal.subject, { id: 'sprint-14', name: 'Sprint 14' });
  assert.equal(signal.metrics.elapsed, 0.6);
  assert.equal(signal.metrics.doneShare, 0.4);
  assert.equal(signal.metrics.dayOfSprint, 7);
  // Projected = done ÷ elapsed = 13.3; will not finish = 20 − 13.3.
  assert.equal(signal.metrics.projected, 13.3);
  assert.equal(signal.metrics.willNotFinish, 6.7);
  assert.equal(signal.headline, 'Sprint 14 is behind: about 6.7 points may not finish');
  assert.equal(signal.evidence[0].rule, 'sprint.elapsed_vs_done');
  assert.deepEqual(signal.evidence[0].link, { id: 'sprint-14', projectId: 'project-1', type: 'sprint' });
  assert.deepEqual(signal.evidence[0].values, { behindBelowDoneShare: 0.5, behindFromElapsed: 0.5, doneShare: 0.4, elapsed: 0.6 });
  assert.match(signal.evidence[0].label, /6 working days of 10 gone \(60%\); 8 points of 20 done \(40%\)/);
});

test('half or more done is on track, and there is no watch state', () => {
  assert.equal(evaluateSprintHealth({ items: items(10), sprint, today: '2026-10-13' }).kind, HEALTH_KINDS.ON_TRACK);
  assert.equal(evaluateSprintHealth({ items: items(9), sprint, today: '2026-10-13' }).kind, HEALTH_KINDS.BEHIND);
  for (const done of [0, 5, 9, 10, 20]) {
    assert.notEqual(evaluateSprintHealth({ items: items(done), sprint, today: '2026-10-13' }).kind, HEALTH_KINDS.WATCH);
  }
});

test('before halfway nothing done is still on track', () => {
  // Four of ten days gone (40%), nothing done.
  const signal = evaluateSprintHealth({ items: items(0), sprint, today: '2026-10-09' });
  assert.equal(signal.metrics.elapsed, 0.4);
  assert.equal(signal.kind, HEALTH_KINDS.ON_TRACK);
  // Five of ten days gone reaches halfway.
  assert.equal(evaluateSprintHealth({ items: items(0), sprint, today: '2026-10-12' }).kind, HEALTH_KINDS.BEHIND);
});

test('sprints that have not started, are unplanned, or have no dates are not judged as behind', () => {
  const upcoming = evaluateSprintHealth({ items: items(0), sprint, today: '2026-10-01' });
  assert.equal(upcoming.kind, HEALTH_KINDS.ON_TRACK);
  assert.equal(upcoming.headline, 'Sprint 14 starts Oct 5');
  assert.equal(evaluateSprintHealth({ items: [], sprint, today: '2026-10-13' }), null);
  assert.equal(evaluateSprintHealth({ items: items(1), sprint: { id: 'x', name: 'X' }, today: '2026-10-13' }), null);
});

test('without points the sprint rule counts items', () => {
  const signal = evaluateSprintHealth({ items: [{ done: true }, { done: false }, { done: false }, { done: false }], sprint, today: '2026-10-13' });
  assert.equal(signal.metrics.unit, 'items');
  assert.equal(signal.metrics.committed, 4);
  assert.equal(signal.kind, HEALTH_KINDS.BEHIND);
});

test('after the sprint ends all of its time is gone', () => {
  const signal = evaluateSprintHealth({ items: items(20), sprint, today: '2026-10-20' });
  assert.equal(signal.metrics.elapsed, 1);
  assert.equal(signal.kind, HEALTH_KINDS.ON_TRACK);
  assert.equal(signal.metrics.willNotFinish, 0);
});

test('a person is behind with overdue critical-path or blocking work, two overdue items, or too little capacity', () => {
  const base = { person: { id: 'user-1', name: 'Ada' }, projectId: 'project-1', today: '2026-10-13' };
  const late = { done: false, id: 'task-late', name: 'Wire payments', targetEndDate: '2026-10-09' };
  const onTime = { done: false, id: 'task-ok', name: 'Docs', targetEndDate: '2026-10-20' };

  const critical = evaluatePersonHealth({ ...base, criticalPathIds: new Set(['task-late']), items: [late, onTime] });
  assert.equal(critical.kind, HEALTH_KINDS.BEHIND);
  assert.equal(critical.scope, 'person');
  assert.equal(critical.evidence[0].rule, 'person.overdue_blocking');
  assert.deepEqual(critical.evidence[0].link, { id: 'task-late', projectId: 'project-1', type: 'item' });
  assert.match(critical.evidence[0].label, /Wire payments is overdue \(due Oct 9\) and on the critical path/);

  const blocking = evaluatePersonHealth({ ...base, blockingItemIds: new Set(['task-late']), items: [late] });
  assert.equal(blocking.kind, HEALTH_KINDS.BEHIND);
  assert.match(blocking.evidence[0].label, /blocks other people/);

  const single = evaluatePersonHealth({ ...base, items: [late, onTime] });
  assert.equal(single.kind, HEALTH_KINDS.WATCH);
  assert.equal(single.headline, 'Ada has 1 overdue item');

  const two = evaluatePersonHealth({ ...base, items: [late, { ...late, id: 'task-late-2', name: 'Refunds' }] });
  assert.equal(two.kind, HEALTH_KINDS.BEHIND);
  assert.equal(two.headline, 'Ada has 2 overdue items');

  const yours = evaluatePersonHealth({ ...base, person: { id: 'user-1', name: 'You', self: true }, items: [late, onTime] });
  assert.equal(yours.headline, 'You have 1 overdue item');
  assert.equal(evaluatePersonHealth({ ...base, person: { id: 'user-1', self: true }, items: [onTime] }).headline, 'You are on track');

  // 3 points at 8h each is 24h left against 16h of capacity.
  const stretched = evaluatePersonHealth({ ...base, items: [{ ...onTime, inActiveSprint: true, points: 3 }], remainingCapacityHours: 16 });
  assert.equal(stretched.kind, HEALTH_KINDS.BEHIND);
  assert.equal(stretched.evidence[0].rule, 'person.over_capacity');
  assert.deepEqual(stretched.evidence[0].values, { remainingCapacityHours: 16, remainingHours: 24 });

  const fine = evaluatePersonHealth({ ...base, items: [{ ...onTime, inActiveSprint: true, points: 1 }, { ...late, done: true }], remainingCapacityHours: 16 });
  assert.equal(fine.kind, HEALTH_KINDS.ON_TRACK);
  assert.deepEqual(fine.evidence, []);
});

test('a project is behind on critical-path forecast, a late milestone due within 30 days, or baseline drift', () => {
  const project = { endDate: '2026-12-04', id: 'project-1', name: 'Atlas' };
  const today = '2026-10-13';
  const onTrack = evaluateProjectHealth({ analysis: { forecastFinish: '2026-12-03', forecastVarianceDays: -1, milestoneForecasts: [] }, project, today });
  assert.equal(onTrack.kind, HEALTH_KINDS.ON_TRACK);
  assert.equal(onTrack.headline, 'The schedule holds for the Dec 4 target');

  const late = evaluateProjectHealth({ analysis: { forecastFinish: '2026-12-08', forecastVarianceDays: 2 }, project, today });
  assert.equal(late.kind, HEALTH_KINDS.BEHIND);
  assert.equal(late.headline, 'Critical-path forecast Dec 8 is 2 working days after the Dec 4 target');
  assert.deepEqual(late.evidence[0].link, { id: 'project-1', projectId: 'project-1', type: 'schedule' });

  const milestones = [
    { forecastDate: '2026-10-23', id: 'm-soon', targetDate: '2026-10-20', title: 'Beta', varianceWorkingDays: 3 },
    { forecastDate: '2026-12-01', id: 'm-later', targetDate: '2026-11-30', title: 'GA', varianceWorkingDays: 1 },
    { forecastDate: '2026-10-29', id: 'm-done', targetDate: '2026-10-27', title: 'Pilot', varianceWorkingDays: 2 },
  ];
  const milestone = evaluateProjectHealth({
    analysis: { forecastVarianceDays: 0, milestoneForecasts: milestones },
    milestones: [{ id: 'm-done', status: 'achieved' }],
    project,
    today,
  });
  assert.equal(milestone.kind, HEALTH_KINDS.BEHIND);
  assert.deepEqual(milestone.evidence.map((entry) => entry.link.id), ['m-soon'], 'only open milestones due within 30 days count');
  assert.equal(milestone.evidence[0].rule, 'project.milestone_variance');

  const drift = evaluateProjectHealth({ analysis: { baselineVariance: { baselineId: 'b-1', baselineName: 'Plan v2', projectFinishVarianceWorkingDays: 4 } }, project, today });
  assert.equal(drift.kind, HEALTH_KINDS.BEHIND);
  assert.equal(drift.headline, 'The plan finishes 4 working days later than baseline "Plan v2"');
  assert.deepEqual(drift.evidence[0].link, { id: 'b-1', projectId: 'project-1', type: 'baseline' });

  const pace = evaluateProjectHealth({ analysis: { forecastVarianceDays: 0 }, project, throughputForecast: { date: '2026-12-07' }, today });
  assert.equal(pace.kind, HEALTH_KINDS.WATCH);
  assert.equal(pace.headline, 'Delivery pace points to Dec 7, after the Dec 4 target');
});

test('the summary leads with the worst kind and the broadest scope; Home takes the most specific', () => {
  const project = { evidence: [], headline: 'Critical-path forecast Dec 8 is 2 working days after the Dec 4 target', kind: 'behind', scope: 'project', subject: { id: 'p' } };
  const sprintSignal = { evidence: [], headline: 'Sprint 14 is behind: about 9 points may not finish', kind: 'behind', scope: 'sprint', subject: { id: 's' } };
  const person = { evidence: [], headline: 'You have 1 overdue item', kind: 'watch', scope: 'person', subject: { id: 'u' } };

  const summary = summarizeHealth([person, null, sprintSignal, project]);
  assert.equal(summary.kind, 'behind');
  assert.equal(summary.headline, 'At risk: Critical-path forecast Dec 8 is 2 working days after the Dec 4 target (and 1 other signal)');
  assert.deepEqual(summary.signals.map((entry) => entry.scope), ['project', 'sprint', 'person']);

  assert.equal(summarizeHealth([person]).headline, 'Watch: You have 1 overdue item');
  assert.equal(summarizeHealth([{ ...project, headline: 'The schedule holds', kind: 'on-track' }]).headline, 'On track: The schedule holds');
  assert.deepEqual(summarizeHealth([]), { headline: '', kind: 'on-track', signals: [] });

  assert.equal(mostSpecificSignal([project, sprintSignal, person]), person);
  assert.equal(mostSpecificSignal([project, sprintSignal]), sprintSignal);
  assert.equal(mostSpecificSignal([{ ...project, kind: 'on-track' }]), null);
});
