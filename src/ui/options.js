import { DEFAULTS, getSettings, saveSettings } from '../settings.js';

const TEXT = ['anthropicKey', 'apolloKey', 'pdlKey', 'hunterKey'];
const BOOL = ['verifyGuesses', 'revealPersonalEmails'];
const $ = (id) => document.getElementById(id);

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

function keyState(state, text) {
  const pill = $('anthropicState');
  pill.className = `pill ${state}`;
  pill.textContent = text;
}

const s = await getSettings();
TEXT.forEach((k) => { $(k).value = s[k] || ''; });
BOOL.forEach((k) => { $(k).checked = !!s[k]; });
$('customPricing').value = Object.keys(s.customPricing || {}).length ? JSON.stringify(s.customPricing, null, 2) : '';
const model = s.anthropicModel || DEFAULTS.anthropicModel;
// A model saved earlier that isn't one of the presets stays selectable as-is.
if (!document.querySelector(`input[name=model][value="${CSS.escape(model)}"]`)) {
  const opt = document.createElement('label');
  opt.className = 'model';
  opt.innerHTML = '<input type="radio" name="model"><span><b></b><small>Your saved model</small></span>';
  opt.querySelector('input').value = model;
  opt.querySelector('b').textContent = model;
  $('models').append(opt);
}
document.querySelector(`input[name=model][value="${CSS.escape(model)}"]`).checked = true;
keyState(s.anthropicKey ? '' : 'bad', s.anthropicKey ? 'Not checked' : 'Missing');

document.querySelectorAll('.reveal').forEach((b) => b.addEventListener('click', () => {
  const input = $(b.dataset.for);
  input.type = input.type === 'password' ? 'text' : 'password';
  b.textContent = input.type === 'password' ? 'Show' : 'Hide';
}));

// Listing models is free and proves the key works.
$('checkKey').addEventListener('click', async () => {
  const key = $('anthropicKey').value.trim();
  if (!key) return keyState('bad', 'Missing');
  keyState('', 'Checking…');
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    if (res.ok) keyState('good', 'Key works ✓');
    else if (res.status === 401) keyState('bad', 'Key rejected');
    else keyState('warn', `Error ${res.status}`);
  } catch {
    keyState('warn', 'Couldn’t connect');
  }
});

let dirty = false;
document.querySelectorAll('input, textarea').forEach((i) => i.addEventListener('input', () => {
  dirty = true;
  $('saved').textContent = 'Unsaved changes';
}));
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

$('save').addEventListener('click', async () => {
  let customPricing = {};
  const raw = $('customPricing').value.trim();
  if (raw) {
    try { customPricing = JSON.parse(raw); } catch { toast('Custom pricing is not valid JSON'); return; }
  }
  const patch = { customPricing, anthropicModel: document.querySelector('input[name=model]:checked').value };
  TEXT.forEach((k) => { patch[k] = $(k).value.trim(); });
  BOOL.forEach((k) => { patch[k] = $(k).checked; });
  await saveSettings(patch);
  dirty = false;
  $('saved').textContent = '';
  toast('✓ Settings saved');
});
