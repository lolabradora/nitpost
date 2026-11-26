(() => {
  if (location.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    document.querySelectorAll('[data-checkout-command]').forEach(node => {
      node.textContent = node.dataset.checkoutCommand;
    });
    const hint = document.getElementById('checkout-hint');
    if (hint) hint.hidden = false;
  }
  for (const copy of document.querySelectorAll('.install-copy')) {
    const command = copy.previousElementSibling;
    const status = copy.parentElement.nextElementSibling;
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      // Counted before the outcome is known: selecting the command shows the same intent.
      window.nitpostSignals?.count(copy.dataset.signal);
      try {
        await navigator.clipboard.writeText(command.textContent);
        copy.textContent = 'Copied';
        copy.classList.add('is-done');
        status.textContent = 'Command copied.';
        setTimeout(() => {
          copy.textContent = 'Copy';
          copy.classList.remove('is-done');
        }, 1800);
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(command);
        selection.removeAllRanges();
        selection.addRange(range);
        status.textContent = 'Command selected. Use your device’s Copy action.';
      }
    });
  }

  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  typeHeroNote();
  loopDestinations();

  function typeHeroNote() {
    const note = document.querySelector('.hero-note-text');
    if (!note || !motion.matches) return;
    const text = note.textContent;
    note.style.minWidth = '0';
    note.textContent = '';
    [...text].forEach((character, index) => {
      setTimeout(() => { note.textContent += character; }, 1350 + index * 55);
    });
  }

  // Each cycle sends one parcel down the wire, then the chip names where it landed.
  function loopDestinations() {
    const lede = document.querySelector('.lede');
    const roller = lede?.querySelector('.roller');
    if (!roller) return;
    const reel = roller.querySelector('.roller-reel');
    const phrases = [...reel.children];
    reel.append(phrases[0].cloneNode(true));
    let widths = [];
    let index = 0;
    let onScreen = true;

    function show(next, animate) {
      index = next;
      reel.style.transition = animate ? '' : 'none';
      roller.style.transition = animate ? '' : 'none';
      reel.style.transform = 'translateY(' + -1.3 * next + 'em)';
      roller.style.inlineSize = widths[next % phrases.length] + 'em';
    }

    function advance() {
      if (document.hidden || !onScreen) return;
      lede.classList.remove('is-sending');
      void lede.offsetWidth;
      lede.classList.add('is-sending');
      setTimeout(() => show(index + 1, true), 650);
      if (index + 1 === phrases.length) setTimeout(() => show(0, false), 1500);
    }

    document.fonts.ready.then(() => {
      const size = parseFloat(getComputedStyle(roller).fontSize);
      widths = phrases.map(phrase => (Math.ceil(phrase.getBoundingClientRect().width) + 1) / size);
      show(0, false);
      if (!motion.matches) return;
      new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(lede);
      setTimeout(() => {
        advance();
        setInterval(advance, 3000);
      }, 2350);
    });
  }

  const stage = document.querySelector('.stage');
  if (stage) {
    new IntersectionObserver(([entry]) => {
      stage.classList.toggle('is-live', entry.isIntersecting);
    }).observe(stage);
  }

  const explain = document.querySelector('.explain');
  if (!explain) return;
  const rows = [...explain.querySelectorAll('.code-row')];
  const caption = explain.querySelector('.code-caption');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let touring = false;
  let timer = 0;

  function activate(field) {
    explain.dataset.active = field;
    for (const row of rows) {
      const active = row.dataset.field === field;
      row.setAttribute('aria-pressed', String(active));
      if (active) caption.textContent = row.dataset.caption;
    }
  }

  function stopTour() {
    touring = false;
    clearInterval(timer);
  }

  function takeOver(field) {
    stopTour();
    tourWatcher.disconnect();
    caption.setAttribute('aria-live', 'polite');
    activate(field);
  }

  for (const row of rows) {
    row.addEventListener('pointerenter', () => takeOver(row.dataset.field));
    row.addEventListener('focus', () => takeOver(row.dataset.field));
    row.addEventListener('click', () => takeOver(row.dataset.field));
  }
  for (const part of explain.querySelectorAll('[data-part]')) {
    part.addEventListener('pointerenter', event => {
      event.stopPropagation();
      takeOver(part.dataset.part);
    });
  }

  // Walk through the fields while the example is on screen, until the visitor takes over.
  const tourWatcher = new IntersectionObserver(([entry]) => {
    if (reduceMotion.matches) return;
    if (entry.isIntersecting && !touring) {
      touring = true;
      timer = setInterval(() => {
        const current = rows.findIndex(row => row.dataset.field === explain.dataset.active);
        activate(rows[(current + 1) % rows.length].dataset.field);
      }, 2400);
    } else if (!entry.isIntersecting) {
      stopTour();
    }
  }, { threshold: .4 });
  tourWatcher.observe(explain);
})();
