// "Report a bug on this page": a working miniature of Bug Reporter's widget.
// It records this visit's page trail and console, lets the visitor draw on the page,
// then shows where a real report would go. Nothing is sent anywhere.

type Tool = 'arrow' | 'box' | 'pen';
interface Shape {
	tool: Tool;
	points: { x: number; y: number }[];
}
interface Entry {
	text: string;
	at: number;
	level?: string;
}

const INK = '#ff4f6d';
const started = Date.now();
const trail: Entry[] = [];
const consoleLog: Entry[] = [];

function clock(at: number) {
	const s = Math.max(0, Math.round((at - started) / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function captureConsole() {
	for (const level of ['log', 'info', 'warn', 'error'] as const) {
		const original = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			consoleLog.push({ level, text: args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 300), at: Date.now() });
			if (consoleLog.length > 5000) consoleLog.shift();
			renderLists();
			original(...args);
		};
	}
	window.addEventListener('error', (event) => {
		consoleLog.push({ level: 'error', text: event.message, at: Date.now() });
		renderLists();
	});
}

function safeJson(value: unknown) {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function trackTrail() {
	const sections = [...document.querySelectorAll<HTMLElement>('main section')];
	const name = (section: HTMLElement) => {
		const heading = section.querySelector('h1, h2');
		const text = heading?.getAttribute('aria-label') || heading?.textContent || section.id || 'Section';
		return text.replace(/\s+/g, ' ').trim();
	};
	let last = '';
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const section = entry.target as HTMLElement;
				const path = `${location.pathname}${section.id ? `#${section.id}` : ''}`;
				const text = `${path}  ${name(section)}`;
				if (text === last) continue;
				last = text;
				trail.push({ text, at: Date.now() });
				if (trail.length > 200) trail.shift();
				renderLists();
			}
		},
		{ rootMargin: '-40% 0px -55% 0px' },
	);
	sections.forEach((section) => observer.observe(section));
}

const lists: { el: HTMLElement; source: Entry[]; limit: number }[] = [];
let activeTab: 'trail' | 'console' = 'trail';
let panelList: HTMLElement | null = null;

function fill(el: HTMLElement, entries: Entry[], limit: number, empty: string) {
	const shown = entries.slice(-limit).reverse();
	el.replaceChildren(
		...(shown.length
			? shown.map((entry) => {
					const li = document.createElement('li');
					const text = document.createElement('span');
					text.textContent = entry.level ? `${entry.level}  ${entry.text}` : entry.text;
					const time = document.createElement('time');
					time.textContent = clock(entry.at);
					li.append(text, time);
					return li;
				})
			: [Object.assign(document.createElement('li'), { textContent: empty })]),
	);
}

function renderLists() {
	document.querySelectorAll<HTMLElement>('[data-trail-count]').forEach((el) => (el.textContent = String(trail.length)));
	document.querySelectorAll<HTMLElement>('[data-console-count]').forEach((el) => (el.textContent = String(consoleLog.length)));
	for (const { el, source, limit } of lists) fill(el, source, limit, source === trail ? 'No sections visited yet.' : 'Nothing logged yet.');
	if (panelList) fill(panelList, activeTab === 'trail' ? trail : consoleLog, 200, activeTab === 'trail' ? 'No sections visited yet.' : 'Nothing logged yet.');
}

export function mountBugReporter() {
	captureConsole();
	console.info('Bug Reporter demo ready. Reports from this page stay in your browser.');

	const trailPreview = document.querySelector<HTMLElement>('[data-trail-preview]');
	const consolePreview = document.querySelector<HTMLElement>('[data-console-preview]');
	if (trailPreview) lists.push({ el: trailPreview, source: trail, limit: 6 });
	if (consolePreview) lists.push({ el: consolePreview, source: consoleLog, limit: 6 });
	trackTrail();
	renderLists();

	const root = document.querySelector<HTMLElement>('[data-reporter]')!;
	const canvas = root.querySelector<HTMLCanvasElement>('[data-ink]')!;
	const ctx = canvas.getContext('2d')!;
	const flash = root.querySelector<HTMLElement>('[data-flash]')!;
	const hint = root.querySelector<HTMLElement>('[data-hint]')!;
	const form = root.querySelector<HTMLElement>('[data-form]')!;
	const sent = root.querySelector<HTMLElement>('[data-sent]')!;
	const title = root.querySelector<HTMLInputElement>('[data-title]')!;
	const description = root.querySelector<HTMLTextAreaElement>('[data-description]')!;
	const thumb = root.querySelector<HTMLImageElement>('[data-thumb]')!;
	const thumbCaption = root.querySelector<HTMLElement>('[data-thumb-caption]')!;
	const fab = document.querySelector<HTMLElement>('.bug-fab');
	panelList = root.querySelector<HTMLElement>('[data-list]');
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	let tool: Tool = 'arrow';
	let shapes: Shape[] = [];
	let drawing: Shape | null = null;
	let opener: HTMLElement | null = null;
	let timers: number[] = [];
	let wireframe: { x: number; y: number; w: number; h: number; kind: string }[] = [];

	const onScroll = () => fab?.classList.toggle('is-shown', window.scrollY > window.innerHeight * 0.8 && root.hidden);
	window.addEventListener('scroll', onScroll, { passive: true });
	onScroll();

	function size() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.round(window.innerWidth * dpr);
		canvas.height = Math.round(window.innerHeight * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		redraw();
	}

	function drawShape(g: CanvasRenderingContext2D, shape: Shape, scale = 1) {
		const pts = shape.points;
		if (pts.length < 2) return;
		g.strokeStyle = INK;
		g.lineWidth = 4 * scale;
		g.lineCap = 'round';
		g.lineJoin = 'round';
		const a = pts[0];
		const b = pts[pts.length - 1];
		g.beginPath();
		if (shape.tool === 'pen') {
			g.moveTo(a.x * scale, a.y * scale);
			for (const p of pts) g.lineTo(p.x * scale, p.y * scale);
		} else if (shape.tool === 'box') {
			g.roundRect(Math.min(a.x, b.x) * scale, Math.min(a.y, b.y) * scale, Math.abs(b.x - a.x) * scale, Math.abs(b.y - a.y) * scale, 8 * scale);
		} else {
			const angle = Math.atan2(b.y - a.y, b.x - a.x);
			const head = 16 * scale;
			g.moveTo(a.x * scale, a.y * scale);
			g.lineTo(b.x * scale, b.y * scale);
			g.moveTo(b.x * scale - head * Math.cos(angle - 0.45), b.y * scale - head * Math.sin(angle - 0.45));
			g.lineTo(b.x * scale, b.y * scale);
			g.lineTo(b.x * scale - head * Math.cos(angle + 0.45), b.y * scale - head * Math.sin(angle + 0.45));
		}
		g.stroke();
	}

	function redraw() {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		for (const shape of shapes) drawShape(ctx, shape);
		if (drawing) drawShape(ctx, drawing);
	}

	canvas.addEventListener('pointerdown', (event) => {
		canvas.setPointerCapture(event.pointerId);
		drawing = { tool, points: [{ x: event.clientX, y: event.clientY }] };
		hint.classList.add('is-gone');
	});
	canvas.addEventListener('pointermove', (event) => {
		if (!drawing) return;
		const point = { x: event.clientX, y: event.clientY };
		if (drawing.tool === 'pen') drawing.points.push(point);
		else drawing.points[1] = point;
		redraw();
	});
	const finishStroke = () => {
		if (drawing && drawing.points.length > 1) shapes.push(drawing);
		drawing = null;
		redraw();
	};
	canvas.addEventListener('pointerup', finishStroke);
	canvas.addEventListener('pointercancel', finishStroke);

	root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) =>
		button.addEventListener('click', () => {
			tool = button.dataset.tool as Tool;
			root.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
		}),
	);
	root.querySelector('[data-undo]')!.addEventListener('click', () => {
		shapes.pop();
		redraw();
	});

	root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) =>
		button.addEventListener('click', () => {
			activeTab = button.dataset.tab as 'trail' | 'console';
			root.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b === button)));
			renderLists();
		}),
	);

	// A sketch of what was on screen, the way Bug Reporter re-renders a page when it can't capture the tab.
	function sketchViewport() {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		wireframe = [];
		document.querySelectorAll<HTMLElement>('main h1, main h2, main h3, main p, main .btn, main canvas, main .demo, main .frame, main .app, main img, main li').forEach((el) => {
			if (el.closest('[data-reporter]')) return;
			const r = el.getBoundingClientRect();
			if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width < 8 || r.height < 6) return;
			const kind = /^H[1-3]$/.test(el.tagName) ? 'heading' : el.matches('.btn') ? 'button' : el.matches('canvas, .demo, .frame, .app, img') ? 'block' : 'text';
			wireframe.push({ x: r.left, y: r.top, w: r.width, h: Math.min(r.height, kind === 'block' ? vh : 400), kind });
		});
	}

	function thumbnail() {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const scale = 640 / vw;
		const c = document.createElement('canvas');
		c.width = 640;
		c.height = Math.round(vh * scale);
		const g = c.getContext('2d')!;
		const style = getComputedStyle(document.documentElement);
		g.fillStyle = style.getPropertyValue('--bg').trim() || '#08101f';
		g.fillRect(0, 0, c.width, c.height);
		const line = style.getPropertyValue('--line-2').trim() || '#2a3e66';
		const ink = style.getPropertyValue('--muted').trim() || '#8194b5';
		for (const box of wireframe) {
			g.fillStyle = box.kind === 'block' ? line : box.kind === 'heading' || box.kind === 'button' ? ink : line;
			g.globalAlpha = box.kind === 'block' ? 0.35 : box.kind === 'text' ? 0.5 : 0.8;
			if (box.kind === 'text' || box.kind === 'heading') {
				const lh = box.kind === 'heading' ? 26 : 14;
				for (let y = box.y; y < box.y + box.h - lh * 0.4; y += lh * 1.35) {
					g.beginPath();
					g.roundRect(box.x * scale, y * scale, box.w * scale * (y + lh * 1.35 >= box.y + box.h ? 0.6 : 1), lh * 0.62 * scale, 3);
					g.fill();
				}
			} else {
				g.beginPath();
				g.roundRect(box.x * scale, box.y * scale, box.w * scale, box.h * scale, 6);
				g.fill();
			}
		}
		g.globalAlpha = 1;
		for (const shape of shapes) drawShape(g, shape, scale);
		return c.toDataURL('image/png');
	}

	function open(trigger: HTMLElement) {
		opener = trigger;
		sketchViewport();
		root.hidden = false;
		document.documentElement.style.overflow = 'hidden';
		fab?.classList.remove('is-shown');
		form.hidden = false;
		sent.hidden = true;
		shapes = [];
		hint.classList.remove('is-gone');
		size();
		renderLists();
		if (!reduced) {
			flash.classList.remove('is-on');
			void flash.offsetWidth;
			flash.classList.add('is-on');
		}
		console.log('Bug Reporter: capture started for', location.pathname);
		title.focus({ preventScroll: true });
	}

	function close() {
		timers.forEach((id) => window.clearTimeout(id));
		timers = [];
		root.hidden = true;
		document.documentElement.style.overflow = '';
		title.value = '';
		description.value = '';
		shapes = [];
		redraw();
		onScroll();
		opener?.focus({ preventScroll: true });
	}

	function send() {
		const shot = thumbnail();
		thumb.src = shot;
		const marks = shapes.length;
		thumbCaption.textContent = `${title.value.trim() || 'Untitled report'}. A sketch of the page with ${marks} mark${marks === 1 ? '' : 's'}. A real report has the full screenshot, plus ${trail.length} page trail entr${trail.length === 1 ? 'y' : 'ies'} and ${consoleLog.length} console record${consoleLog.length === 1 ? '' : 's'}.`;
		shapes = [];
		redraw();
		form.hidden = true;
		sent.hidden = false;
		root.querySelector<HTMLElement>('[data-sent-title]')!.focus({ preventScroll: true });
		const steps = [...root.querySelectorAll<HTMLElement>('[data-pipe]')];
		steps.forEach((step) => step.classList.remove('is-on'));
		steps.forEach((step, i) => {
			if (reduced) step.classList.add('is-on');
			else timers.push(window.setTimeout(() => step.classList.add('is-on'), 350 + i * 850));
		});
	}

	document.querySelectorAll<HTMLElement>('[data-bug-open]').forEach((button) => button.addEventListener('click', () => open(button)));
	root.querySelectorAll<HTMLElement>('[data-bug-close]').forEach((button) => button.addEventListener('click', close));
	root.querySelector('[data-send]')!.addEventListener('click', send);
	window.addEventListener('resize', () => {
		if (!root.hidden) size();
	});
	document.addEventListener('keydown', (event) => {
		if (root.hidden) return;
		if (event.key === 'Escape') close();
		if (event.key === 'Tab') {
			// Keep focus inside the reporter while it is open.
			const focusable = [...root.querySelectorAll<HTMLElement>('button, input, textarea, [tabindex="0"]')].filter((el) => el.offsetParent !== null);
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	});
}
