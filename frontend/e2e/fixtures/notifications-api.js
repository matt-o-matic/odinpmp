// The bell's endpoints for browser specs (docs/odin-chat/plan.md, Delivery). Register after
// installSyntheticApi; anything else falls back to it. Each /api/me/events response carries the
// events queued since the last one, then ends, so the client reconnects about a second later,
// as it does when a real stream drops.

const API_ORIGIN = 'http://localhost:3001';

function json(route, body, status = 200) {
  return route.fulfill({ body: JSON.stringify(body), contentType: 'application/json', status });
}

export async function installNotificationsApi(page, { notifications = [] } = {}) {
  const state = { events: [], notifications: notifications.map((entry) => ({ ...entry })), reads: [] };
  const unread = () => state.notifications.filter((entry) => !entry.readAt).length;

  await page.route(`${API_ORIGIN}/api/me/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === 'GET' && path === '/api/me/events') {
      const queued = state.events.splice(0);
      const body = ['event: connected\ndata: {}\n\n', ...queued.map(({ data, type }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)].join('');
      return route.fulfill({ body, contentType: 'text/event-stream', status: 200 });
    }
    if (method === 'GET' && path === '/api/me/notifications') return json(route, { notifications: state.notifications, ok: true, unreadCount: unread() });
    if (method === 'POST' && path === '/api/me/notifications/read') {
      const input = request.postDataJSON();
      state.reads.push(input);
      const at = new Date().toISOString();
      for (const entry of state.notifications) if (!entry.readAt && (input.all || input.ids?.includes(entry.id))) entry.readAt = at;
      return json(route, { marked: [], ok: true, unreadCount: unread() });
    }
    return route.fallback();
  });

  return {
    state,
    /** A notification made elsewhere: it is listed, and the next stream says so. */
    add(notification) {
      state.notifications.unshift({ readAt: null, ...notification });
      state.events.push({ data: { id: notification.id }, type: 'notification.created' });
    },
  };
}

export function sampleNotification(overrides = {}) {
  const at = new Date().toISOString();
  return {
    channelId: 'channel-general',
    count: 1,
    createdAt: at,
    excerpt: '@Synthetic Demo can you check the SOW?',
    id: `notification-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'mention',
    path: '/projects',
    projectId: 'project-synthetic',
    projectName: 'Synthetic Project',
    readAt: null,
    title: 'Lena Lead mentioned you in #General',
    updatedAt: at,
    ...overrides,
  };
}
