import { onBeforeUnmount, onMounted, ref } from 'vue';

/** The rendered width of `target`, kept current with a ResizeObserver. */
export function useElementWidth(target, fallback = 560) {
  const width = ref(fallback);
  let observer = null;

  onMounted(() => {
    const element = target.value;
    if (!element) return;
    const measured = Math.round(element.clientWidth);
    if (measured > 0) width.value = measured;
    if (typeof ResizeObserver !== 'function') return;
    observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect?.width ?? 0);
      if (next > 0 && next !== width.value) width.value = next;
    });
    observer.observe(element);
  });
  onBeforeUnmount(() => observer?.disconnect());

  return width;
}

/**
 * Crosshair state for a chart whose marks sit at `positions()` (pixel x per index): pointer
 * movement picks the nearest index, and Left/Right/Home/End move it from the keyboard.
 */
export function useChartHover(positions) {
  const activeIndex = ref(-1);

  function nearest(x) {
    const xs = positions();
    let best = -1;
    for (let index = 0; index < xs.length; index += 1) {
      if (best < 0 || Math.abs(xs[index] - x) < Math.abs(xs[best] - x)) best = index;
    }
    return best;
  }

  function onPointerMove(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    activeIndex.value = nearest(event.clientX - bounds.left);
  }

  function onPointerLeave() {
    activeIndex.value = -1;
  }

  function onKeydown(event) {
    const count = positions().length;
    if (count === 0) return;
    const current = activeIndex.value < 0 ? count - 1 : activeIndex.value;
    const moves = { ArrowLeft: current - 1, ArrowRight: current + 1, End: count - 1, Home: 0 };
    if (!(event.key in moves)) return;
    event.preventDefault();
    activeIndex.value = Math.max(0, Math.min(count - 1, moves[event.key]));
  }

  function onBlur() {
    activeIndex.value = -1;
  }

  return { activeIndex, onBlur, onKeydown, onPointerLeave, onPointerMove };
}
