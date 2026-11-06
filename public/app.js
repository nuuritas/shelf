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
