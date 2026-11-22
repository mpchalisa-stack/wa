import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Register Service Worker for PWA offline caching & Add to Home Screen installability
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        void reg.update().catch(() => {});
      })
      .catch(() => {
        // Service worker registration silently skipped in restricted preview contexts
      });
  });
}

createRoot(document.getElementById('root')!).render(<App />);
