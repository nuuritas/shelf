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

async function swapLibrary(href, push) {
  const library = document.querySelector('#library');
  if (!library) {
    window.location.href = href;
    return;
  }

  library.classList.add('is-loading');

  try {
    const response = await fetch(href, {
      credentials: 'same-origin',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const next = doc.querySelector('#library');
    if (!next) throw new Error('No library in response');

    library.innerHTML = next.innerHTML;
    document.title = doc.title;
    if (push) history.pushState({ library: href }, '', href);
  } catch {
    window.location.href = href;
  } finally {
    library.classList.remove('is-loading');
  }
}

document.addEventListener('click', event => {
  const tab = event.target.closest('.topic-tab');
  if (!tab) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = tab.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  swapLibrary(href, true);
});

window.addEventListener('popstate', () => {
  if (location.pathname === '/' || location.pathname.startsWith('/t/')) {
    swapLibrary(`${location.pathname}${location.search}`, false);
  }
});
