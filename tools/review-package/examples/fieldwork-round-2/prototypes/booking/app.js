// Example prototype for an Odin review package. It uses hash states that match
// the manifest's declared `states`, and tells the Odin bridge which state is showing.
// The bridge is injected by the review origin; outside Odin, window.OdinReview is undefined.
(function () {
  const STATES = ['choose-service', 'pick-time', 'confirm'];
  let service = 'Home refresh';

  function show(state) {
    const key = STATES.includes(state) ? state : STATES[0];
    document.querySelectorAll('[data-state]').forEach((section) => {
      section.hidden = section.dataset.state !== key;
    });
    document.querySelectorAll('[data-step]').forEach((step) => {
      const index = STATES.indexOf(step.dataset.step);
      step.className = index < STATES.indexOf(key) ? 'done' : index === STATES.indexOf(key) ? 'on' : '';
    });
    document.querySelectorAll('[data-bind="service"]').forEach((el) => { el.textContent = service; });
    if (window.OdinReview && typeof window.OdinReview.setState === 'function') window.OdinReview.setState(key);
  }

  document.addEventListener('click', (event) => {
    const choice = event.target.closest('[data-service]');
    if (choice) {
      service = choice.dataset.service;
      location.hash = 'pick-time';
      return;
    }
    const slot = event.target.closest('.fw-slot:not([disabled])');
    if (slot) {
      slot.parentElement.querySelectorAll('.fw-slot').forEach((s) => s.classList.remove('on'));
      slot.classList.add('on');
    }
  });

  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
})();
