if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // The app still works as a normal web page if registration is unavailable.
    });
  });
}

function setExpanded(card, expanded) {
  card.classList.toggle('is-collapsed', !expanded);
  const button = card.querySelector('[data-expand]');
  if (button) {
    button.textContent = expanded ? 'Collapse' : 'Read more';
    button.setAttribute('aria-expanded', String(expanded));
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-expand]');
  if (button) {
    const card = button.closest('.card');
    if (card) setExpanded(card, card.classList.contains('is-collapsed'));
    return;
  }

  const card = event.target.closest('.card');
  if (!card) return;
  if (event.target.closest('a, video, form, input, label, summary')) return;
  setExpanded(card, card.classList.contains('is-collapsed'));
});

document.addEventListener('click', event => {
  const fold = event.target.closest('[data-fold]');
  if (!fold) return;
  const box = fold.closest('.topic-overview');
  if (!box) return;
  const folded = box.classList.toggle('is-folded');
  fold.textContent = folded ? 'Read the full synthesis' : 'Show less';
});

let swipeStart = null;

document.addEventListener(
  'touchstart',
  event => {
    if (event.touches.length !== 1) {
      swipeStart = null;
      return;
    }
    if (event.target.closest('video, input, textarea')) {
      swipeStart = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = { x: touch.clientX, y: touch.clientY };
  },
  { passive: true },
);

document.addEventListener(
  'touchend',
  event => {
    if (!swipeStart) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - swipeStart.x;
    const dy = touch.clientY - swipeStart.y;
    swipeStart = null;

    if (Math.abs(dx) < 70 || Math.abs(dy) > 50) return;

    const tabs = [...document.querySelectorAll('.topic-tabs .topic-tab')];
    if (tabs.length < 2) return;

    const current = tabs.findIndex(tab => tab.classList.contains('active'));
    if (current === -1) return;

    const next = dx < 0 ? current + 1 : current - 1;
    if (next < 0 || next >= tabs.length) return;

    window.location.href = tabs[next].href;
  },
  { passive: true },
);
