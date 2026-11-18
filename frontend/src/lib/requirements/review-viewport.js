// Phone layout switch for the guided review (sh-mobile.png): threads below the canvas, the
// verdict in a bottom sheet, and a reduced tool set.

import { onBeforeUnmount, onMounted, ref } from 'vue';

export const PHONE_QUERY = '(max-width: 767.98px)';

// Tools on a phone: select, pin, box, arrow, pen. Text and highlight need more precision.
export const PHONE_TOOLS = Object.freeze(['select', 'pin', 'box', 'arrow', 'pen']);

export function useMediaQuery(query = PHONE_QUERY) {
  const matches = ref(typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  let list = null;
  const update = (event) => {
    matches.value = event.matches;
  };
  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    list = window.matchMedia(query);
    matches.value = list.matches;
    list.addEventListener('change', update);
  });
  onBeforeUnmount(() => list?.removeEventListener('change', update));
  return matches;
}
