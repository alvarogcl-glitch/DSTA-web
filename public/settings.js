'use strict';
// Settings gear (⚙) next to the bell / refresh / install buttons. Other scripts add sections with
// window.DstaSettings.addSection(title, element, order). Works in single-user and accounts mode.
(() => {
  const refreshButton = document.querySelector('#refresh');
  if (!refreshButton) return;
  const css = document.createElement('style');
  css.textContent = `
#dsta-settings-toggle{width:auto;min-width:42px}
#dsta-settings-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:6;width:min(440px,calc(100vw - 32px));max-height:min(78vh,760px);
  overflow:auto;background:#151b23;border:1px solid #3a4859;border-radius:12px;padding:16px;box-shadow:0 12px 32px rgba(0,0,0,.45);text-align:left}
#dsta-settings-panel h3{margin:0 0 10px;font-size:13px;letter-spacing:.06em;color:#68d391;text-transform:uppercase}
#dsta-settings-panel>section+section{border-top:1px solid #2b3745;margin-top:14px;padding-top:14px}
#dsta-settings-panel p{margin:0 0 10px;color:#c5d1dd;font-size:13px;line-height:1.4}
.dsta-settings-anchor{position:relative;display:inline-block}
@media (max-width:700px){#dsta-settings-panel{position:fixed;left:12px;right:12px;top:12px;width:auto;max-height:calc(100vh - 24px)}}
#dsta-settings-panel{overflow-x:hidden}#dsta-settings-panel *{box-sizing:border-box}
/* The dashboard sets input{min-width:240px;flex:1} for its toolbar: neutralise it here. */
#dsta-settings-panel input,#dsta-settings-panel select,dialog.dsta-section-dialog input,dialog.dsta-section-dialog select{min-width:0}
#dsta-settings-panel input[type=checkbox],dialog.dsta-section-dialog input[type=checkbox]{flex:0 0 auto;width:auto}`;
  document.head.append(css);
  const anchor = Object.assign(document.createElement('span'), { className: 'dsta-settings-anchor' });
  const gear = Object.assign(document.createElement('button'), { type: 'button', id: 'dsta-settings-toggle', textContent: '⚙', title: 'Configuración' });
  gear.setAttribute('aria-label', 'Configuración');
  gear.setAttribute('aria-expanded', 'false');
  gear.setAttribute('aria-controls', 'dsta-settings-panel');
  const panel = Object.assign(document.createElement('div'), { id: 'dsta-settings-panel', hidden: true });
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Configuración');
  anchor.append(gear, panel);
  const install = document.querySelector('#install-app');
  (install || refreshButton).after(anchor);

  function setOpen(open) {
    panel.hidden = !open;
    gear.setAttribute('aria-expanded', String(open));
    if (open) window.dispatchEvent(new Event('dsta-settings-open'));
  }
  gear.addEventListener('click', event => { event.stopPropagation(); setOpen(panel.hidden); });
  // composedPath() is fixed at dispatch time: a control re-rendered by its own click handler is no
  // longer in the DOM, but the click still came from inside the panel.
  document.addEventListener('click', event => {
    const path = event.composedPath();
    if (!path.includes(anchor) && !path.some(node => node instanceof HTMLDialogElement)) setOpen(false);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) { setOpen(false); gear.focus(); } });

  window.DstaSettings = {
    addSection(title, content, order = 50) {
      const section = document.createElement('section');
      section.dataset.order = String(order);
      section.append(Object.assign(document.createElement('h3'), { textContent: title }), content);
      const after = [...panel.children].find(child => Number(child.dataset.order) > order);
      panel.insertBefore(section, after || null);
      return section;
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
  window.dispatchEvent(new Event('dsta-settings-ready'));
})();
