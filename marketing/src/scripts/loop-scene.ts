// The hero: a ring of real Odin screens standing around the loop, with the gold gem
// travelling from station to station. Plain three.js, no post-processing.
import {
	AdditiveBlending,
	AmbientLight,
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	DirectionalLight,
	DoubleSide,
	Group,
	LinearMipmapLinearFilter,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	NormalBlending,
	OctahedronGeometry,
	PerspectiveCamera,
	PlaneGeometry,
	PointLight,
	Points,
	Quaternion,
	RingGeometry,
	Scene,
	ShaderMaterial,
	SphereGeometry,
	SRGBColorSpace,
	Texture,
	TextureLoader,
	TorusGeometry,
	Vector3,
	WebGLRenderer,
} from 'three';

type Theme = 'light' | 'dark';

export interface LoopStation {
	key: string;
	label: string;
	screen: string;
}

interface Options {
	canvas: HTMLCanvasElement;
	labels: HTMLElement[];
	stations: LoopStation[];
	onStation?: (index: number) => void;
	reducedMotion: boolean;
}

const RADIUS = 4.0;
// Wide enough that neighbouring screens nearly touch when they stand side by side.
const PANEL_W = 3.5;
const PANEL_H = PANEL_W / 1.6;
const LIFT = 0.42 + PANEL_H / 2;
const TAU = Math.PI * 2;
// The lit screen stands this much higher than the others until the gem crosses the next station.
const RAISE = 1.1;
// The swap takes this long: the old screen sinks and dims while the new one rises, turning once on the way up.
const SWAP = 1.1;

const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const palette = {
	dark: { ring: '#8db8ff', dust: '#9cc2ff', glow: '#5b8def', base: '#101d37', page: '#08101f', border: '#2a3e66', gold: '#f2b636' },
	light: { ring: '#2457c5', dust: '#2c4f9e', glow: '#5b8def', base: '#ffffff', page: '#eef2f8', border: '#b6c2d6', gold: '#e3a21a' },
};

const panelVertex = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;

const panelFragment = /* glsl */ `
	uniform sampler2D uMap;
	uniform float uHasMap;
	uniform float uActive;
	uniform float uFade;
	uniform float uReveal;
	uniform vec3 uBase;
	uniform vec3 uPage;
	uniform vec3 uBorder;
	uniform vec3 uGold;
	uniform vec2 uSize;
	varying vec2 vUv;

	float roundBox(vec2 p, vec2 b, float r) {
		vec2 q = abs(p) - b + r;
		return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
	}

	void main() {
		vec2 p = (vUv - 0.5) * uSize;
		float d = roundBox(p, uSize * 0.5, 0.09);
		float aa = fwidth(d) * 1.2;
		float shape = 1.0 - smoothstep(-aa, aa, d);
		if (shape < 0.01) discard;

		vec3 screen = uHasMap > 0.5 ? texture2D(uMap, vUv).rgb : uBase;
		// Wipe the screenshot in from the top once it has loaded.
		float wipe = smoothstep(uReveal - 0.08, uReveal, 1.0 - vUv.y);
		screen = mix(screen, uBase, wipe);
		// The back of the card, seen only mid-spin.
		if (!gl_FrontFacing) screen = mix(uBase, uGold, 0.08);

		// Unlit and distant panels recede into the page color. The lit one is solid and at full strength.
		float light = mix(0.42 * uFade, 1.0, uActive);
		vec3 color = mix(uPage, screen, light);
		// A diagonal sheen, strong on the lit panel.
		float sheen = smoothstep(0.35, 0.0, abs(vUv.x - vUv.y * 0.6 - 0.15)) * (0.03 + 0.1 * uActive);
		color += sheen;

		float width = mix(0.01, 0.026, uActive);
		float edge = 1.0 - smoothstep(0.0, aa * 2.0, abs(d + width + 0.002) - width);
		color = mix(color, mix(uBorder, uGold, uActive), edge);

		gl_FragColor = vec4(color, shape * mix(0.78 * uFade, 1.0, uActive));
		#include <colorspace_fragment>
	}
`;

const dustVertex = /* glsl */ `
	attribute float aAngle;
	attribute float aRadius;
	attribute float aHeight;
	attribute float aSpeed;
	attribute float aSize;
	uniform float uTime;
	uniform float uPixelRatio;
	varying float vAlpha;
	void main() {
		float a = aAngle + uTime * aSpeed;
		vec3 pos = vec3(cos(a) * aRadius, aHeight + sin(uTime * 0.6 + aAngle * 7.0) * 0.03, sin(a) * aRadius);
		vec4 mv = modelViewMatrix * vec4(pos, 1.0);
		gl_Position = projectionMatrix * mv;
		gl_PointSize = aSize * uPixelRatio * (14.0 / -mv.z);
		vAlpha = smoothstep(26.0, 8.0, -mv.z);
	}
`;

const dustFragment = /* glsl */ `
	uniform vec3 uColor;
	uniform float uOpacity;
	varying float vAlpha;
	void main() {
		float d = length(gl_PointCoord - 0.5);
		float a = smoothstep(0.5, 0.0, d);
		gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
		#include <colorspace_fragment>
	}
`;

const trailVertex = /* glsl */ `
	attribute float aOffset;
	uniform float uHead;
	uniform float uPixelRatio;
	varying float vAlpha;
	void main() {
		float a = uHead - aOffset;
		vec3 pos = vec3(cos(a) * ${RADIUS.toFixed(2)}, 0.0, sin(a) * ${RADIUS.toFixed(2)});
		vec4 mv = modelViewMatrix * vec4(pos, 1.0);
		gl_Position = projectionMatrix * mv;
		float t = 1.0 - aOffset / 1.6;
		gl_PointSize = (2.0 + 7.0 * t * t) * uPixelRatio * (14.0 / -mv.z);
		vAlpha = t * t;
	}
`;

const glowFragment = /* glsl */ `
	uniform vec3 uColor;
	uniform float uOpacity;
	varying float vAlpha;
	void main() {
		float d = length(gl_PointCoord - 0.5);
		float a = smoothstep(0.5, 0.05, d);
		gl_FragColor = vec4(uColor, a * vAlpha * uOpacity);
		#include <colorspace_fragment>
	}
`;

// A soft gold glow around the lit screen.
const haloFragment = /* glsl */ `
	uniform vec3 uColor;
	uniform float uStrength;
	uniform vec2 uSize;
	uniform vec2 uInner;
	varying vec2 vUv;
	float roundBox(vec2 p, vec2 b, float r) {
		vec2 q = abs(p) - b + r;
		return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
	}
	void main() {
		float d = roundBox((vUv - 0.5) * uSize, uInner * 0.5, 0.12);
		float a = exp(-max(d, 0.0) * 4.5) * smoothstep(-0.2, 0.0, d);
		gl_FragColor = vec4(uColor, a * uStrength);
		#include <colorspace_fragment>
	}
`;

function placeholderTexture(theme: Theme): CanvasTexture {
	const c = document.createElement('canvas');
	c.width = 320;
	c.height = 200;
	const g = c.getContext('2d')!;
	const p = palette[theme];
	g.fillStyle = p.base;
	g.fillRect(0, 0, 320, 200);
	g.fillStyle = theme === 'dark' ? '#16294a' : '#e9eef5';
	g.fillRect(0, 0, 320, 18);
	for (let i = 0; i < 7; i += 1) {
		g.fillRect(16, 34 + i * 22, 80 + ((i * 37) % 90), 8);
		g.fillRect(200, 34 + i * 22, 100, 8);
	}
	const t = new CanvasTexture(c);
	t.colorSpace = SRGBColorSpace;
	return t;
}

function glowSprite(color: string): CanvasTexture {
	const c = document.createElement('canvas');
	c.width = c.height = 128;
	const g = c.getContext('2d')!;
	const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
	grad.addColorStop(0, color);
	grad.addColorStop(0.25, color + '88');
	grad.addColorStop(1, color + '00');
	g.fillStyle = grad;
	g.fillRect(0, 0, 128, 128);
	return new CanvasTexture(c);
}

export function mountLoop({ canvas, labels, stations, onStation, reducedMotion }: Options) {
	const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
	const small = window.matchMedia('(max-width: 760px)').matches;
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
	renderer.setClearColor(0x000000, 0);

	const scene = new Scene();
	const camera = new PerspectiveCamera(34, 1, 0.1, 100);
	const world = new Group();
	scene.add(world);

	let theme: Theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

	scene.add(new AmbientLight(0xffffff, 0.7));
	const key = new DirectionalLight(0xffffff, 1.6);
	key.position.set(4, 8, 6);
	scene.add(key);

	// The ring itself: a hairline tube plus a soft halo.
	const ringMaterial = new MeshBasicMaterial({ color: new Color(palette[theme].ring), transparent: true, opacity: 0.9 });
	const ring = new Mesh(new TorusGeometry(RADIUS, 0.011, 8, 360), ringMaterial);
	ring.rotation.x = Math.PI / 2;
	world.add(ring);
	const haloMaterial = new MeshBasicMaterial({ color: new Color(palette[theme].glow), transparent: true, opacity: 0.08, depthWrite: false });
	const halo = new Mesh(new TorusGeometry(RADIUS, 0.07, 8, 360), haloMaterial);
	halo.rotation.x = Math.PI / 2;
	world.add(halo);

	// Ground glow under the ring.
	const floorMaterial = new ShaderMaterial({
		transparent: true,
		depthWrite: false,
		uniforms: { uColor: { value: new Color(palette[theme].glow) }, uOpacity: { value: theme === 'dark' ? 0.16 : 0.1 } },
		vertexShader: panelVertex,
		fragmentShader: /* glsl */ `
			uniform vec3 uColor; uniform float uOpacity; varying vec2 vUv;
			void main() {
				float d = length(vUv - 0.5) * 2.0;
				float ring = smoothstep(0.25, 0.0, abs(d - 0.72)) * 0.7 + smoothstep(1.0, 0.0, d) * 0.35;
				gl_FragColor = vec4(uColor, ring * uOpacity);
				#include <colorspace_fragment>
			}
		`,
	});
	const floor = new Mesh(new PlaneGeometry(RADIUS * 2.9, RADIUS * 2.9), floorMaterial);
	floor.rotation.x = -Math.PI / 2;
	floor.position.y = -0.02;
	world.add(floor);

	// Dust drifting along the ring.
	const count = small ? 900 : 2200;
	const dustGeometry = new BufferGeometry();
	const zeros = new Float32Array(count * 3);
	const angle = new Float32Array(count);
	const radius = new Float32Array(count);
	const lift = new Float32Array(count);
	const speed = new Float32Array(count);
	const size = new Float32Array(count);
	for (let i = 0; i < count; i += 1) {
		const spread = Math.pow(Math.random(), 2.2);
		angle[i] = Math.random() * TAU;
		radius[i] = RADIUS + (Math.random() - 0.5) * (0.25 + spread * 3.2);
		lift[i] = (Math.random() - 0.5) * (0.12 + spread * 2.2);
		speed[i] = 0.02 + Math.random() * 0.07;
		size[i] = 0.6 + Math.random() * 2.2;
	}
	dustGeometry.setAttribute('position', new BufferAttribute(zeros, 3));
	dustGeometry.setAttribute('aAngle', new BufferAttribute(angle, 1));
	dustGeometry.setAttribute('aRadius', new BufferAttribute(radius, 1));
	dustGeometry.setAttribute('aHeight', new BufferAttribute(lift, 1));
	dustGeometry.setAttribute('aSpeed', new BufferAttribute(speed, 1));
	dustGeometry.setAttribute('aSize', new BufferAttribute(size, 1));
	const dustMaterial = new ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: theme === 'dark' ? AdditiveBlending : NormalBlending,
		uniforms: {
			uTime: { value: 0 },
			uPixelRatio: { value: renderer.getPixelRatio() },
			uColor: { value: new Color(palette[theme].dust) },
			uOpacity: { value: theme === 'dark' ? 0.75 : 0.45 },
		},
		vertexShader: dustVertex,
		fragmentShader: dustFragment,
	});
	const dust = new Points(dustGeometry, dustMaterial);
	dust.frustumCulled = false;
	world.add(dust);

	// The gem and its trail.
	const gemMaterial = new MeshStandardMaterial({ color: new Color(palette[theme].gold), metalness: 0.65, roughness: 0.22, emissive: new Color('#7a4a00'), emissiveIntensity: 0.6 });
	const gem = new Mesh(new OctahedronGeometry(0.2, 0), gemMaterial);
	gem.scale.set(1, 1.35, 1);
	world.add(gem);
	const gemLight = new PointLight(new Color('#f2b636'), 6, 4, 2);
	world.add(gemLight);
	const gemGlow = new Mesh(
		new PlaneGeometry(1.6, 1.6),
		new MeshBasicMaterial({ map: glowSprite('#f2b636'), transparent: true, depthWrite: false, blending: AdditiveBlending, opacity: 0.85 }),
	);
	world.add(gemGlow);

	const trailCount = 140;
	const trailGeometry = new BufferGeometry();
	const offsets = new Float32Array(trailCount);
	for (let i = 0; i < trailCount; i += 1) offsets[i] = (i / trailCount) * 1.6;
	trailGeometry.setAttribute('position', new BufferAttribute(new Float32Array(trailCount * 3), 3));
	trailGeometry.setAttribute('aOffset', new BufferAttribute(offsets, 1));
	const trailMaterial = new ShaderMaterial({
		transparent: true,
		depthWrite: false,
		blending: theme === 'dark' ? AdditiveBlending : NormalBlending,
		uniforms: { uHead: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uColor: { value: new Color(palette[theme].gold) }, uOpacity: { value: 0.9 } },
		vertexShader: trailVertex,
		fragmentShader: glowFragment,
	});
	const trail = new Points(trailGeometry, trailMaterial);
	trail.frustumCulled = false;
	world.add(trail);

	// Stations: a node on the ring, a post, and a panel showing the real screen.
	const loader = new TextureLoader();
	const textureCache = new Map<string, Promise<Texture>>();
	const panelGeometry = new PlaneGeometry(PANEL_W, PANEL_H);
	const nodeGeometry = new SphereGeometry(0.055, 16, 12);
	const postGeometry = new PlaneGeometry(0.008, 1);
	const haloGeometry = new PlaneGeometry(PANEL_W * 1.5, PANEL_H * 1.7);
	const waveGeometry = new RingGeometry(0.9, 1, 64);
	const panels = stations.map((station, index) => {
		const a = (index / stations.length) * TAU;
		const anchor = new Group();
		anchor.position.set(Math.cos(a) * RADIUS, 0, Math.sin(a) * RADIUS);
		world.add(anchor);

		const node = new Mesh(nodeGeometry, new MeshBasicMaterial({ color: new Color(palette[theme].ring) }));
		anchor.add(node);
		const post = new Mesh(postGeometry, new MeshBasicMaterial({ color: new Color(palette[theme].ring), transparent: true, opacity: 0.45 }));
		anchor.add(post);

		// A ring of light that spreads across the ground when the gem strikes.
		const wave = new Mesh(
			waveGeometry,
			new MeshBasicMaterial({ color: new Color(palette[theme].gold), transparent: true, opacity: 0, depthWrite: false, side: DoubleSide, blending: theme === 'dark' ? AdditiveBlending : NormalBlending }),
		);
		wave.rotation.x = -Math.PI / 2;
		wave.position.y = 0.01;
		anchor.add(wave);

		const material = new ShaderMaterial({
			transparent: true,
			side: DoubleSide,
			uniforms: {
				uMap: { value: placeholderTexture(theme) },
				uHasMap: { value: 1 },
				uActive: { value: 0 },
				uFade: { value: 1 },
				uReveal: { value: 0 },
				uBase: { value: new Color(palette[theme].base) },
				uPage: { value: new Color(palette[theme].page) },
				uBorder: { value: new Color(palette[theme].border) },
				uGold: { value: new Color(palette[theme].gold) },
				uSize: { value: [PANEL_W, PANEL_H] },
			},
			vertexShader: panelVertex,
			fragmentShader: panelFragment,
		});
		const panel = new Mesh(panelGeometry, material);
		panel.position.y = LIFT;
		anchor.add(panel);

		const haloMaterial = new ShaderMaterial({
			transparent: true,
			depthWrite: false,
			blending: theme === 'dark' ? AdditiveBlending : NormalBlending,
			uniforms: {
				uColor: { value: new Color(palette[theme].gold) },
				uStrength: { value: 0 },
				uSize: { value: [PANEL_W * 1.5, PANEL_H * 1.7] },
				uInner: { value: [PANEL_W, PANEL_H] },
			},
			vertexShader: panelVertex,
			fragmentShader: haloFragment,
		});
		const glow = new Mesh(haloGeometry, haloMaterial);
		glow.position.z = -0.03;
		panel.add(glow);

		return {
			station,
			angle: a,
			anchor,
			panel,
			post,
			node,
			wave,
			material,
			haloMaterial,
			// How lit and raised the screen is, 0 to 1, easing from `from` to `to` since `changedAt`.
			level: 0,
			from: 0,
			to: 0,
			changedAt: -Infinity,
			struckAt: -Infinity,
			lastDiff: 0,
			reveal: 0,
			loadedTheme: '' as string,
		};
	});

	function loadScreens() {
		for (const entry of panels) {
			const url = `/screens/thumb/${entry.station.screen}-${theme}.webp`;
			const wanted = theme;
			if (!textureCache.has(url)) {
				textureCache.set(
					url,
					loader.loadAsync(url).then((texture) => {
						texture.colorSpace = SRGBColorSpace;
						texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
						texture.minFilter = LinearMipmapLinearFilter;
						return texture;
					}),
				);
			}
			textureCache
				.get(url)!
				.then((texture) => {
					if (theme !== wanted) return;
					entry.material.uniforms.uMap.value = texture;
					entry.loadedTheme = wanted;
					entry.reveal = entry.reveal >= 1 ? 1 : 0;
					if (reducedMotion) {
						entry.reveal = 1;
						render();
					}
				})
				.catch(() => {});
		}
	}

	function applyTheme(next: Theme) {
		theme = next;
		const p = palette[theme];
		ringMaterial.color.set(p.ring);
		haloMaterial.color.set(p.glow);
		haloMaterial.opacity = theme === 'dark' ? 0.08 : 0.06;
		floorMaterial.uniforms.uColor.value.set(p.glow);
		floorMaterial.uniforms.uOpacity.value = theme === 'dark' ? 0.16 : 0.1;
		dustMaterial.uniforms.uColor.value.set(p.dust);
		dustMaterial.uniforms.uOpacity.value = theme === 'dark' ? 0.75 : 0.45;
		dustMaterial.blending = theme === 'dark' ? AdditiveBlending : NormalBlending;
		trailMaterial.blending = theme === 'dark' ? AdditiveBlending : NormalBlending;
		trailMaterial.uniforms.uColor.value.set(p.gold);
		gemMaterial.color.set(p.gold);
		for (const entry of panels) {
			entry.material.uniforms.uBase.value.set(p.base);
			entry.material.uniforms.uPage.value.set(p.page);
			entry.material.uniforms.uBorder.value.set(p.border);
			entry.material.uniforms.uGold.value.set(p.gold);
			(entry.node.material as MeshBasicMaterial).color.set(p.ring);
			(entry.post.material as MeshBasicMaterial).color.set(p.ring);
			const wave = entry.wave.material as MeshBasicMaterial;
			wave.color.set(p.gold);
			wave.blending = theme === 'dark' ? AdditiveBlending : NormalBlending;
			wave.needsUpdate = true;
			entry.haloMaterial.uniforms.uColor.value.set(p.gold);
			entry.haloMaterial.blending = theme === 'dark' ? AdditiveBlending : NormalBlending;
			entry.haloMaterial.needsUpdate = true;
		}
		dustMaterial.needsUpdate = true;
		trailMaterial.needsUpdate = true;
		loadScreens();
		render();
	}

	// Layout: the ring sits to the right of the headline on wide screens and above it on narrow ones.
	let width = 1;
	let height = 1;
	const base = { x: 0, y: 6.0, z: 21, lookX: 0, lookY: 1.0 };
	function resize() {
		const rect = canvas.parentElement!.getBoundingClientRect();
		width = Math.max(1, rect.width);
		height = Math.max(1, rect.height);
		renderer.setSize(width, height, false);
		camera.aspect = width / height;
		const wide = camera.aspect > 1.15;
		world.position.set(wide ? 5.7 : 0, wide ? -0.6 : -0.9, 0);
		camera.fov = wide ? 34 : 40;
		base.z = wide ? 22 : 18.5;
		base.lookX = wide ? 2.1 : 0;
		camera.updateProjectionMatrix();
		dustMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
		trailMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
		render();
	}

	const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
	const onPointer = (event: PointerEvent) => {
		pointer.tx = (event.clientX / window.innerWidth - 0.5) * 2;
		pointer.ty = (event.clientY / window.innerHeight - 0.5) * 2;
	};
	window.addEventListener('pointermove', onPointer, { passive: true });

	let scroll = 0;
	const onScroll = () => {
		scroll = Math.min(1, Math.max(0, window.scrollY / Math.max(1, height)));
	};
	window.addEventListener('scroll', onScroll, { passive: true });

	const projected = new Vector3();
	const parentTurn = new Quaternion();
	const worldPos = new Vector3();
	let activeIndex = -1;
	let gemAngle = reducedMotion ? 0.0001 : -0.6;
	let elapsed = 0;
	let gemHitAt = -Infinity;
	let last = performance.now();

	// The station the gem crossed last is lit. Lighting the next one swaps both in one motion.
	function setActive(index: number) {
		if (index === activeIndex) return;
		activeIndex = index;
		for (const [i, entry] of panels.entries()) {
			const to = i === index ? 1 : 0;
			if (entry.to === to) continue;
			entry.from = entry.level;
			entry.to = to;
			entry.changedAt = elapsed;
		}
		panels[index].struckAt = elapsed;
		gemHitAt = elapsed;
		onStation?.(index);
	}

	// The station the gem passed most recently, for the first frame.
	function lastPassed(angle: number) {
		let found = 0;
		let best = Infinity;
		panels.forEach((entry, index) => {
			const behind = (((angle - entry.angle) % TAU) + TAU) % TAU;
			if (behind < best) {
				best = behind;
				found = index;
			}
		});
		return found;
	}

	// Screen-space box of the lit screen. Other labels that would sit on it are hidden.
	const corner = new Vector3();
	function litBox() {
		const entry = panels[activeIndex];
		if (!entry) return null;
		let left = Infinity;
		let right = -Infinity;
		let top = Infinity;
		let bottom = -Infinity;
		for (const [cx, cy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			corner.set((cx * PANEL_W) / 2, (cy * PANEL_H) / 2, 0);
			entry.panel.localToWorld(corner).project(camera);
			const x = (corner.x * 0.5 + 0.5) * width;
			const y = (-corner.y * 0.5 + 0.5) * height;
			left = Math.min(left, x);
			right = Math.max(right, x);
			top = Math.min(top, y);
			bottom = Math.max(bottom, y);
		}
		return { left, right, top, bottom };
	}

	function updateLabels() {
		const box = litBox();
		panels.forEach((entry, index) => {
			const label = labels[index];
			if (!label) return;
			// Above the top centre of the screen, which stays put while it spins.
			worldPos.set(0, PANEL_H / 2 + 0.1, 0);
			entry.panel.localToWorld(worldPos);
			projected.copy(worldPos).project(camera);
			const x = (projected.x * 0.5 + 0.5) * width;
			const y = (-projected.y * 0.5 + 0.5) * height;
			const depth = camera.position.distanceTo(worldPos);
			const fade = Math.min(1, Math.max(0, (24 - depth) / 9));
			const hidden = box && index !== activeIndex && x > box.left - 40 && x < box.right + 40 && y > box.top && y < box.bottom + 30;
			label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
			label.style.opacity = hidden ? '0' : (Math.max(fade, entry.level) * (0.45 + entry.level * 0.55)).toFixed(3);
			label.classList.toggle('is-active', index === activeIndex);
		});
	}

	function frame(now: number, step: number) {
		elapsed += step;
		pointer.x += (pointer.tx - pointer.x) * Math.min(1, step * 3);
		pointer.y += (pointer.ty - pointer.y) * Math.min(1, step * 3);

		if (!reducedMotion) {
			world.rotation.y += step * 0.045;
			gemAngle += step * 0.42;
		}
		dustMaterial.uniforms.uTime.value = elapsed;

		camera.position.set(base.lookX + pointer.x * 0.9, base.y - pointer.y * 0.55 + scroll * 2.2, base.z + scroll * 3);
		camera.lookAt(base.lookX, base.lookY - scroll * 1.2, 0);
		world.rotation.x = scroll * 0.18;

		const ga = gemAngle % TAU;
		// The gem hops as it strikes a station.
		const hop = reducedMotion ? 0 : Math.sin(Math.PI * clamp01((elapsed - gemHitAt) / 0.45)) * 0.45;
		gem.position.set(Math.cos(ga) * RADIUS, 0.05 + Math.sin(elapsed * 2.2) * 0.04 + hop, Math.sin(ga) * RADIUS);
		gem.rotation.y = elapsed * 1.6;
		gemLight.position.copy(gem.position).y += 0.4;
		gemGlow.position.copy(gem.position);
		world.updateMatrixWorld();
		gemGlow.quaternion.copy(world.getWorldQuaternion(parentTurn).invert()).multiply(camera.quaternion);
		trailMaterial.uniforms.uHead.value = ga;

		// Light the station the gem has just crossed. Signed angle from each station to the gem, in (-PI, PI].
		if (activeIndex < 0) setActive(lastPassed(ga));
		for (const [index, entry] of panels.entries()) {
			const diff = ((((ga - entry.angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
			if (entry.lastDiff < 0 && diff >= 0 && diff < 0.5) setActive(index);
			entry.lastDiff = diff;
		}

		for (const entry of panels) {
			if (entry.loadedTheme === theme && entry.reveal < 1) entry.reveal = reducedMotion ? 1 : Math.min(1, entry.reveal + step * 1.4);

			// One motion per swap. The rising screen is thrown up and turns once, both easing out together;
			// the sinking one eases down without turning. With reduced motion it just switches.
			const p = reducedMotion ? 1 : clamp01((elapsed - entry.changedAt) / SWAP);
			const rising = entry.to > entry.from;
			const e = rising ? easeOutCubic(p) : easeInOutCubic(p);
			entry.level = entry.from + (entry.to - entry.from) * e;

			const s = 1 + entry.level * 0.12;
			entry.panel.scale.set(s, s, 1);
			entry.panel.position.y = LIFT + entry.level * RAISE;
			entry.panel.lookAt(camera.position.x, entry.panel.getWorldPosition(worldPos).y, camera.position.z);
			if (rising && p < 1) entry.panel.rotateY(TAU * e);

			// The post stretches from the ring to the bottom of the screen.
			const bottom = Math.max(0.05, entry.panel.position.y - (PANEL_H / 2) * s);
			entry.post.scale.y = bottom;
			entry.post.position.y = bottom / 2;

			// A ring of light spreads across the ground from the station as the gem crosses it.
			const t = reducedMotion ? -1 : elapsed - entry.struckAt;
			const w = clamp01(t / 0.8);
			(entry.wave.material as MeshBasicMaterial).opacity = t >= 0 && t <= 0.8 ? (1 - easeOutCubic(w)) * 0.9 : 0;
			const r = 0.25 + easeOutCubic(w) * 2.6;
			entry.wave.scale.set(r, r, r);

			entry.panel.getWorldPosition(worldPos);
			const depth = camera.position.distanceTo(worldPos);
			entry.material.uniforms.uFade.value = Math.min(1, Math.max(0.28, (25 - depth) / 9));
			entry.material.uniforms.uActive.value = entry.level;
			entry.material.uniforms.uReveal.value = entry.reveal;
			entry.haloMaterial.uniforms.uStrength.value = entry.level * (theme === 'dark' ? 0.6 : 0.45);
		}

		renderer.render(scene, camera);
		updateLabels();
		last = now;
	}

	function render() {
		frame(performance.now(), 0.0001);
	}

	let running = false;
	let raf = 0;
	function loop(now: number) {
		const step = Math.min(0.05, (now - last) / 1000);
		frame(now, step);
		raf = requestAnimationFrame(loop);
	}
	function start() {
		if (running || reducedMotion) return;
		running = true;
		last = performance.now();
		raf = requestAnimationFrame(loop);
	}
	function stop() {
		running = false;
		cancelAnimationFrame(raf);
	}

	const visibility = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()), { threshold: 0 });
	visibility.observe(canvas);
	document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
	new ResizeObserver(resize).observe(canvas.parentElement!);
	window.addEventListener('odin:theme', (event) => applyTheme((event as CustomEvent<Theme>).detail));

	resize();
	loadScreens();
	if (reducedMotion) {
		// One still frame with the first station lit.
		for (let i = 0; i < 3; i += 1) render();
	}

	return {
		goTo(index: number) {
			gemAngle = (index / stations.length) * TAU + 0.02;
			panels.forEach((entry) => (entry.lastDiff = 0));
			setActive(index);
			if (reducedMotion) render();
		},
	};
}
