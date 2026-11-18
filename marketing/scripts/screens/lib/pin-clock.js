// The requirements fixtures stamp comments, rounds and due dates relative to "now", so each
// run would show different dates and odd hours. This shifts the worker's clock to a fixed
// demo evening (Monday Oct 12, 2026, 9:30 PM Eastern) so every regeneration matches.
//
// Time still moves (only the offset is fixed), so timers and timeouts behave as usual.
// Import this before anything else in the capture spec: the portal fixture reads the time
// when it loads.

export const DEMO_NOW = Date.parse('2026-10-13T01:30:00.000Z');

const RealDate = globalThis.Date;
const offset = DEMO_NOW - RealDate.now();

class DemoDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offset);
    else super(...args);
  }

  static now() {
    return RealDate.now() + offset;
  }
}

globalThis.Date = DemoDate;

/** The shifted current time, for the browser clock. */
export function demoNow() {
  return new Date(Date.now());
}
