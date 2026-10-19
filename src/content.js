// Runs on linkedin.com. Adds a "Find contact" button on profile pages and
// reads ONLY the profile currently on screen, when the user clicks. No crawling,
// no background requests to LinkedIn.

(() => {
  const PROFILE_RE = /linkedin\.com\/(in\/[^/]+|talent\/.*profile|sales\/(lead|people)\/)/i;
  const MAX_CHARS = 15000;
  let lastUrl = '';

  // Sections about other people, which would confuse who the profile belongs to.
  const OTHER_PEOPLE = /^(people (also viewed|you may know|similar to)|more profiles for you|others named|suggested for you|you might like|pages for you|explore premium profiles|people also follow|analytics|resources)/i;

  // The main column's text minus asides and sections listing other people.
  function profileText(main) {
    let text = main.innerText;
    const drop = [...main.querySelectorAll('aside, [role="complementary"]')];
    main.querySelectorAll('section').forEach((s) => {
      if (OTHER_PEOPLE.test(s.querySelector('h2, h3')?.textContent.trim() || '')) drop.push(s);
    });
    for (const n of drop) {
      const t = n.innerText.trim();
      if (t) text = text.replace(t, '');
    }
    return text;
  }

  function readProfile() {
    const main = document.querySelector('main') || document.body;
    const heading = (main.querySelector('h1')?.innerText || document.title || '').trim();
    const text = profileText(main)
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .slice(0, MAX_CHARS);
    // LinkedIn navigates in-page, so the canonical tag can still name the previous
    // profile; the address bar is authoritative when it's a profile URL.
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    const url = PROFILE_RE.test(location.href) || !canonical || !PROFILE_RE.test(canonical) ? location.href : canonical;
    return { url, heading, text };
  }

  function ensureButton() {
    const onProfile = PROFILE_RE.test(location.href);
    let btn = document.getElementById('pf-find-btn');
    if (!onProfile) { btn?.remove(); return; }
    if (btn) return;
    btn = document.createElement('button');
    btn.id = 'pf-find-btn';
    btn.type = 'button';
    btn.textContent = 'Find contact';
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Looking up…';
      chrome.runtime.sendMessage({ type: 'lookup', profile: readProfile() }, () => {
        setTimeout(() => { btn.disabled = false; btn.textContent = 'Find contact'; }, 1500);
      });
    });
    document.body.appendChild(btn);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'getProfile') {
      sendResponse(PROFILE_RE.test(location.href) ? readProfile() : null);
    }
  });

  // LinkedIn is a single-page app; watch for in-app navigation.
  setInterval(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; ensureButton(); }
  }, 800);
  ensureButton();
})();
