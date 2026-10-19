// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.linkedin.com/in/jane-smith-1a2b/"}
// LinkedIn-like fixtures (hand-written). They exercise the reader's fallbacks; they do NOT
// prove compatibility with LinkedIn's live markup, which changes frequently.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readLinkedInProfile } from '../src/content/profile-reader';
import { identityFromSnapshot } from '../src/services/identity';

function load(file: string) {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', file), 'utf8');
  document.open(); document.write(html); document.close();
}

async function read(file: string) {
  load(file);
  const snap = await readLinkedInProfile(300);
  return { snap, id: identityFromSnapshot(snap) };
}

afterEach(() => { vi.useRealTimers(); });

describe('LinkedIn profile reader (fixtures)', () => {
  it('classic layout: aria-label current company, deduplicated screen-reader text', async () => {
    const { snap, id } = await read('linkedin-classic.html');
    expect(snap.isProfile).toBe(true);
    expect(snap.experience[0].lines.slice(0, 3)).toEqual(['Technical Recruiter', 'Example Technologies · Full-time', 'Jan 2023 - Present · 1 yr 10 mos']);
    expect(id.name.full).toBe('Jane Smith');
    expect(id.company).toBe('Example Technologies');
    expect(id.title).toBe('Technical Recruiter');
    expect(id.companyLinkedInUrl).toBe('https://www.linkedin.com/company/example-technologies/');
    expect(id.companyOptions).toContain('Old Co');
  });

  it('class-free layout: Experience found by heading, grouped roles, description bullets ignored', async () => {
    const { id } = await read('linkedin-semantic.html');
    expect(id.name).toMatchObject({ first: 'Carlos', last: 'García-López' });
    expect(id.company).toBe('Acme Robotics');
    expect(id.title).toBe('Senior Talent Partner');
    expect(id.companyOptions).toContain('Globex');
  });

  it('picks the current employer, not the first-listed previous one; skips self-employed', async () => {
    const { id } = await read('linkedin-previous-first.html');
    expect(id.company).toBe('Northwind Labs');
    expect(id.title).toBe('Talent Partner');
    expect(id.notes.join(' ')).toMatch(/self-employed/i);
    expect(id.companyOptions).toContain('Old Bank');
  });

  it('missing Experience: falls back to the headline and asks for confirmation', async () => {
    const { id } = await read('linkedin-minimal.html');
    expect(id).toMatchObject({ company: 'Example Technologies', title: 'Technical Recruiter' });
    expect(id.notes.join(' ')).toMatch(/headline; please confirm/);
  });

  it('no rendered name: uses page title and meta description, flagged for confirmation', async () => {
    const { snap, id } = await read('linkedin-noname.html');
    expect(snap.name).toBe('');
    expect(id.name.full).toBe('Jane Smith');
    expect(id.company).toBe('Example Technologies');
    expect(id.notes.join(' ')).toMatch(/page title/);
  });

  it('waits for content that renders after the popup opens', async () => {
    document.open(); document.write('<html><head><title>LinkedIn</title></head><body><main id="m"></main></body></html>'); document.close();
    setTimeout(() => { document.getElementById('m')!.innerHTML = '<section><div><h1>Dana Kowalski</h1><div class="text-body-medium">Head of Talent at Example Technologies</div></div></section>'; }, 150);
    setTimeout(() => {
      document.getElementById('m')!.insertAdjacentHTML('beforeend', '<section><h2>Experience</h2><ul><li><div><div>Head of Talent</div><div>Example Technologies</div><div>2022 - Present</div></div></li></ul></section>');
    }, 400);
    const snap = await readLinkedInProfile(2000);
    expect(snap.name).toBe('Dana Kowalski');
    expect(snap.experience).toHaveLength(1);
    expect(identityFromSnapshot(snap).company).toBe('Example Technologies');
  });

  it('gives up after the wait budget on an empty page', async () => {
    document.open(); document.write('<html><body><main></main></body></html>'); document.close();
    const t = Date.now();
    const snap = await readLinkedInProfile(400);
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);
    expect(snap.ready).toBe(false);
    expect(identityFromSnapshot(snap).notes.join(' ')).toMatch(/enter it manually/);
  });
});
