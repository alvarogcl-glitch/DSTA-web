'use strict';
(() => {
  const button = document.getElementById('install-app');
  const status = document.getElementById('install-status');
  let installPrompt = null;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches;
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    button.hidden = standalone();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    button.hidden = true;
    status.textContent = 'DSTA instalada';
  });
  button.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    button.hidden = true;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      status.textContent = choice.outcome === 'accepted' ? 'Instalando DSTA…' : '';
    } catch {
      status.textContent = 'Puedes instalar DSTA desde el menú de Chrome.';
    }
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(error => console.warn('No se pudo activar la instalación de DSTA:', error));
    });
  }
})();
