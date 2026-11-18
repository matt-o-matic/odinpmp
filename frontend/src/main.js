import { createApp } from 'vue';
import { DARK_MODE_KEY, readStoredDarkMode } from './lib/ui/theme.js';

// Apply dark class before Vue mounts to prevent flash.
(function () {
  if (readStoredDarkMode(localStorage)) {
    document.documentElement.classList.add('dark');
  }
})();

import App from './App.vue';
import { authSession } from './lib/auth/index.js';
import { listenForPushOpens } from './lib/notifications/open-from-push.js';
import { router } from './router/index.js';
import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
// Share the same Bootstrap module used by ProjectsView so delegated clicks run once.
import 'bootstrap';
import './assets/legacy/docs.css';
import './assets/legacy/header.css';
import './assets/legacy/view.css';
import './style.css';

async function bootstrap() {
  createApp(App).use(router).mount('#app');
  void authSession.restore().catch(() => null);
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    listenForPushOpens({ base: import.meta.env.BASE_URL, container: navigator.serviceWorker, origin: window.location.origin, router });
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => null);
    }, { once: true });
  }
}

bootstrap();
