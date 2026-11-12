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
  if (event.target.closest('a, video, form, input, label, summary, button')) return;
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

document.addEventListener('click', async event => {
  const chip = event.target.closest('[data-copy]');
  if (!chip) return;
  event.stopPropagation();

  const value = chip.getAttribute('data-copy') || '';
  if (!value) return;

  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const field = document.createElement('input');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    try {
      document.execCommand('copy');
    } catch {
      // Nothing else to try; the id is still visible to select by hand.
    }
    field.remove();
  }

  const label = chip.dataset.label || chip.textContent;
  chip.dataset.label = label;
  chip.textContent = 'copied';
  chip.classList.add('is-copied');
  window.setTimeout(() => {
    chip.textContent = label;
    chip.classList.remove('is-copied');
  }, 1200);
});

// Settings: keep the prompt character count honest while typing. The server
// still enforces the limit; this is only feedback.
(() => {
  const source = document.querySelector('[data-prompt-source]');
  const counter = document.querySelector('[data-prompt-count]');
  if (!source || !counter) return;
  const update = () => {
    counter.textContent = source.value.length.toLocaleString('en-US');
  };
  source.addEventListener('input', update);
  update();
})();
