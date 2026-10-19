// Injected into the active LinkedIn tab with chrome.scripting.executeScript, only
// when the user opens the popup (activeTab). Reads what is visible on that one
// page; makes no network requests. Must be self-contained (no imports): Chrome
// serializes the function source.
//
// Extraction is semantic rather than class-based: the name is the page's <h1>,
// the Experience section is found by its heading text, and entries are read as
// text lines. Interpretation (current vs previous employer) happens in
// identity.ts, where it is unit-tested.

export interface ExperienceEntry {
  lines: string[];      // text lines of the entry (without nested roles)
  sub: string[][];      // nested roles when one company lists several positions
  companyHref: string;  // linkedin.com/company/... link if present
}

export interface ProfileSnapshot {
  url: string;
  isProfile: boolean;
  ready: boolean;                // main content was present when we stopped waiting
  name: string;
  headline: string;
  pageTitle: string;             // document.title, e.g. "(3) Jane Smith | LinkedIn"
  metaDescription: string;
  currentCompanyLabel: string;   // explicit "Current company: X" in the top card
  companyLinkedInUrl: string;
  topCardLines: string[];
  experience: ExperienceEntry[];
}

export async function readLinkedInProfile(maxWaitMs = 4000): Promise<ProfileSnapshot> {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

  // Screen-reader-only copies (LinkedIn renders most strings twice) are skipped.
  const hidden = (e: Element) => e.classList.contains('visually-hidden') || e.classList.contains('sr-only') || e.hasAttribute('hidden');
  const textOf = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1 || hidden(node as Element)) return '';
    return Array.from(node.childNodes).map(textOf).join(' ');
  };
  const INLINE = /^(B|I|EM|STRONG|SPAN|A|SMALL|SUP|SUB|TIME)$/;

  // Text lines of an element: one line per block-level leaf.
  const linesOf = (el: Element | null, skip?: (e: Element) => boolean): string[] => {
    if (!el) return [];
    const out: string[] = [];
    const visit = (node: Element) => {
      if (hidden(node) || skip?.(node)) return;
      const kids = Array.from(node.children).filter((k) => !hidden(k));
      const isLeafBlock = kids.every((k) => INLINE.test(k.tagName) && Array.from(k.children).every((g) => INLINE.test(g.tagName)));
      if (isLeafBlock) {
        const t = clean(textOf(node));
        if (t) out.push(t);
        return;
      }
      for (const k of kids) visit(k);
    };
    visit(el);
    return out.filter((l, i) => l !== out[i - 1]);
  };

  const collect = (): ProfileSnapshot => {
    const url = location.href;
    const isProfile = /linkedin\.com\/(in|talent\/.*profile|sales\/(lead|people))\//i.test(url);
    const main = document.querySelector('main') ?? document.body;
    const h1 = main.querySelector('h1');
    const name = clean(h1?.textContent);

    // Top card = the nearest ancestor of the h1 that contains a reasonable amount of text.
    let top: Element | null = h1;
    while (top && top !== main && clean(top.textContent).length < 120) top = top.parentElement;
    const topCardLines = linesOf(top).slice(0, 40);

    let headline = clean(main.querySelector('.text-body-medium')?.textContent);
    if (!headline && name) {
      const i = topCardLines.indexOf(name);
      headline = topCardLines.slice(i + 1).find((l) => l.length > 8 && !/^(\(.+\)|·?\s*\d(st|nd|rd|th)|he\/him|she\/her|they\/them|contact info)/i.test(l)) ?? '';
    }

    let currentCompanyLabel = '';
    for (const el of Array.from(main.querySelectorAll('[aria-label]'))) {
      const m = (el.getAttribute('aria-label') ?? '').match(/^Current company:\s*(.+?)(?:\.\s*Click.*)?$/i);
      if (m) { currentCompanyLabel = m[1].trim(); break; }
    }

    // Experience section located by its heading text, not by ids or classes.
    const section = Array.from(main.querySelectorAll('section')).find((s) => {
      const h = clean(s.querySelector('h2, h3, [role="heading"]')?.textContent);
      return /^experience(\s+experience)?$/i.test(h);
    }) ?? document.getElementById('experience')?.closest('section') ?? null;

    const experience: ExperienceEntry[] = [];
    if (section) {
      const items = Array.from(section.querySelectorAll('li')).filter((li) => {
        const parentLi = li.parentElement?.closest('li');
        return !parentLi || !section.contains(parentLi);
      });
      for (const li of items.slice(0, 6)) {
        const nested = Array.from(li.querySelectorAll('li')).filter((n) => n.parentElement?.closest('li') === li);
        const lines = linesOf(li, (e) => e.tagName === 'UL' && e.querySelector('li') !== null && e !== li);
        const sub = nested.map((n) => linesOf(n)).filter((l) => l.length);
        const href = (li.querySelector('a[href*="/company/"]') as HTMLAnchorElement | null)?.href ?? '';
        if (lines.length) experience.push({ lines: lines.slice(0, 8), sub: sub.slice(0, 5), companyHref: href.split('?')[0] });
      }
    }

    const companyLink = (top?.querySelector('a[href*="/company/"]') ?? main.querySelector('a[href*="/company/"]')) as HTMLAnchorElement | null;
    return {
      url, isProfile, ready: !!name, name, headline,
      pageTitle: document.title,
      metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
      currentCompanyLabel,
      companyLinkedInUrl: (companyLink?.href ?? '').split('?')[0],
      topCardLines,
      experience,
    };
  };

  // LinkedIn renders progressively: wait for the name, then briefly for Experience.
  const start = Date.now();
  let snap = collect();
  while (Date.now() - start < maxWaitMs) {
    if (snap.name && (snap.experience.length || Date.now() - start > maxWaitMs / 2)) break;
    await new Promise((r) => setTimeout(r, 200));
    snap = collect();
  }
  return snap;
}
