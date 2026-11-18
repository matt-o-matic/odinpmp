// Drives the hand-built demos. Markup declares what happens and when:
//   data-at="1200"        add .is-on at 1.2 s (CSS decides what that looks like)
//   data-off="3000"       remove .is-on again at 3 s
//   data-type             type the element's text out once it turns on (data-speed = ms per character)
//   data-count="34"       count up to the number once it turns on
//   data-path="0:20,30 900:60,40 1100:click"   move the fake cursor (percent of the demo) and click
// A demo replays a few seconds after it finishes, for as long as it stays active.

export interface Timeline {
	play(): void;
	stop(): void;
	finish(): void;
}

interface Typed {
	el: HTMLElement;
	text: string;
}

export function createTimeline(root: HTMLElement, { hold = 3800 } = {}): Timeline {
	const timed = [...root.querySelectorAll<HTMLElement>('[data-at]')];
	const typed: Typed[] = [...root.querySelectorAll<HTMLElement>('[data-type]')].map((el) => ({ el, text: el.textContent ?? '' }));
	const counters = [...root.querySelectorAll<HTMLElement>('[data-count]')];
	const cursors = [...root.querySelectorAll<HTMLElement>('[data-path]')];
	let timers: number[] = [];
	let frames: number[] = [];
	let playing = false;

	const end = Math.max(
		0,
		...timed.map((el) => Number(el.dataset.off ?? el.dataset.at ?? 0)),
		...typed.map(({ el, text }) => Number(el.dataset.at ?? 0) + text.length * Number(el.dataset.speed ?? 22)),
		...cursors.map((el) => Math.max(...parsePath(el.dataset.path ?? '').map((step) => step.at))),
	);

	function later(ms: number, fn: () => void) {
		timers.push(window.setTimeout(fn, ms));
	}

	function clear() {
		timers.forEach((id) => window.clearTimeout(id));
		frames.forEach((id) => cancelAnimationFrame(id));
		timers = [];
		frames = [];
	}

	function typeOut({ el, text }: Typed) {
		const speed = Number(el.dataset.speed ?? 22);
		const started = performance.now();
		el.textContent = '';
		el.classList.add('is-typing');
		const tick = (now: number) => {
			const shown = Math.min(text.length, Math.floor((now - started) / speed));
			el.textContent = text.slice(0, shown);
			if (shown < text.length) frames.push(requestAnimationFrame(tick));
			else el.classList.remove('is-typing');
		};
		frames.push(requestAnimationFrame(tick));
	}

	function countUp(el: HTMLElement) {
		const target = Number(el.dataset.count);
		const started = performance.now();
		const duration = Number(el.dataset.duration ?? 900);
		const tick = (now: number) => {
			const t = Math.min(1, (now - started) / duration);
			el.textContent = String(Math.round(target * (1 - Math.pow(1 - t, 3))));
			if (t < 1) frames.push(requestAnimationFrame(tick));
		};
		frames.push(requestAnimationFrame(tick));
	}

	function reset() {
		clear();
		timed.forEach((el) => el.classList.remove('is-on'));
		typed.forEach(({ el }) => {
			el.textContent = '';
			el.classList.remove('is-typing');
		});
		counters.forEach((el) => (el.textContent = '0'));
		cursors.forEach((el) => {
			const [first] = parsePath(el.dataset.path ?? '');
			el.classList.remove('is-click', 'is-on');
			el.style.transition = 'none';
			if (first?.x !== undefined) {
				el.style.left = `${first.x}%`;
				el.style.top = `${first.y}%`;
			}
			void el.offsetWidth;
			el.style.transition = '';
		});
	}

	function play() {
		reset();
		playing = true;
		root.classList.add('is-playing');
		for (const el of timed) {
			later(Number(el.dataset.at ?? 0), () => {
				el.classList.add('is-on');
				const entry = typed.find((item) => item.el === el);
				if (entry) typeOut(entry);
				if (el.dataset.count !== undefined) countUp(el);
			});
			if (el.dataset.off !== undefined) later(Number(el.dataset.off), () => el.classList.remove('is-on'));
		}
		for (const entry of typed) {
			if (entry.el.dataset.at === undefined) later(0, () => typeOut(entry));
		}
		for (const cursor of cursors) {
			later(0, () => cursor.classList.add('is-on'));
			for (const step of parsePath(cursor.dataset.path ?? '')) {
				later(step.at, () => {
					if (step.click) {
						cursor.classList.add('is-click');
						later(320, () => cursor.classList.remove('is-click'));
					} else {
						cursor.style.left = `${step.x}%`;
						cursor.style.top = `${step.y}%`;
					}
				});
			}
		}
		later(end + hold, () => {
			if (playing) play();
		});
	}

	function stop() {
		playing = false;
		root.classList.remove('is-playing');
		clear();
	}

	function finish() {
		stop();
		timed.forEach((el) => {
			if (el.dataset.off === undefined) el.classList.add('is-on');
			else el.classList.remove('is-on');
		});
		typed.forEach(({ el, text }) => (el.textContent = text));
		counters.forEach((el) => (el.textContent = el.dataset.count ?? '0'));
		cursors.forEach((el) => el.classList.remove('is-on'));
	}

	return { play, stop, finish };
}

interface PathStep {
	at: number;
	x?: number;
	y?: number;
	click?: boolean;
}

function parsePath(path: string): PathStep[] {
	return path
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((part) => {
			const [at, where] = part.split(':');
			if (where === 'click') return { at: Number(at), click: true };
			const [x, y] = where.split(',').map(Number);
			return { at: Number(at), x, y };
		});
}

// Plays each demo while it is on screen, and shows the finished state when motion is reduced.
export function autoplayDemos(selector = '[data-demo]') {
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const demos = [...document.querySelectorAll<HTMLElement>(selector)];
	const timelines = new Map(demos.map((demo) => [demo, createTimeline(demo)]));
	if (reduced) {
		timelines.forEach((timeline) => timeline.finish());
		return timelines;
	}
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const timeline = timelines.get(entry.target as HTMLElement)!;
				if (entry.isIntersecting) timeline.play();
				else timeline.stop();
			}
		},
		{ threshold: 0.45 },
	);
	demos.forEach((demo) => observer.observe(demo));
	return timelines;
}
