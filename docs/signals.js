(() => {
  // The GoatCounter site code. Every hit goes to https://<siteCode>.goatcounter.com/count.
  const siteCode = 'nitpost';
  // A versioned count.js never changes, so the hash pins exactly what runs.
  const counter = {
    src: 'https://gc.zgo.at/count.v5.js',
    integrity: 'sha384-atnOLvQb9t+jTSipvd75X2yginT4PjVbqDdlJAmxMm+wYElFmeR6EmLP5bYeoRVQ',
  };
  const versionPattern = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[a-z]{1,12}\.\d{1,4})?$/;
  const titles = {
    'copy-install-command': 'Copy install command',
    'copy-skill-command': 'Copy skill command',
    'open-releases': 'Open releases',
    'open-github': 'Open GitHub',
    'open-privacy': 'Open privacy policy',
    'uninstall-reason-helper-install': 'Uninstall reason: could not install the helper',
    'uninstall-reason-no-conversation': 'Uninstall reason: did not find my conversation',
    'uninstall-reason-send-failed': 'Uninstall reason: sending did not work',
    'uninstall-reason-missing-feature': 'Uninstall reason: missing something I need',
    'uninstall-reason-just-trying': 'Uninstall reason: just trying it out',
    'uninstall-reason-other': 'Uninstall reason: something else',
  };
  const local = location.protocol === 'file:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const uninstalled = document.currentScript.dataset.page === 'uninstalled';
  let version = '';
  let path = location.pathname;

  if (uninstalled) {
    const claimed = new URLSearchParams(location.search).get('v') ?? '';
    version = versionPattern.test(claimed) ? claimed : '';
    // count.js sends location.search with every hit, so nothing but a valid version may stay.
    const search = version ? '?v=' + version : '';
    if (location.search !== search) {
      history.replaceState(null, '', location.pathname + search + location.hash);
    }
    path = location.pathname.replace(/\.html$/, '') + (version ? '/' + version : '');
  }

  function count(name, referrer = '') {
    if (!Object.hasOwn(titles, name)) return;
    try {
      window.goatcounter?.count?.({ path: name, title: titles[name], referrer, event: true });
    } catch {
      // The counter is optional. A blocked or failing one must not affect the page.
    }
  }

  function countLink(event) {
    if (event.type === 'auxclick' && event.button !== 1) return;
    const link = event.target.closest?.('a[data-signal]');
    if (link) count(link.dataset.signal);
  }

  window.nitpostSignals = {
    count,
    countReason: reason => count('uninstall-reason-' + reason, version ? 'v' + version : ''),
  };
  document.addEventListener('click', countLink);
  document.addEventListener('auxclick', countLink);

  if (local) return;
  // The path is set here so a query string never becomes part of a counted page.
  window.goatcounter = { endpoint: 'https://' + siteCode + '.goatcounter.com/count', path };
  const script = document.createElement('script');
  script.async = true;
  script.src = counter.src;
  script.integrity = counter.integrity;
  script.crossOrigin = 'anonymous';
  document.head.append(script);
})();
