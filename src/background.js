import { runLookup } from './core/pipeline.js';
import { getSettings } from './settings.js';

const HISTORY_MAX = 500;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'deepen') {
    deepen();
    sendResponse({ ok: true });
    return;
  }
  if (msg?.type !== 'lookup') return;
  const tabId = msg.tabId ?? sender.tab?.id;
  // Must be called synchronously inside the user-gesture-triggered message.
  if (tabId != null) chrome.sidePanel.open({ tabId }).catch(() => {});
  lookup(msg.profile);
  sendResponse({ ok: true });
});

// Second, broader pass for the last lookup, reusing what the quick pass already found.
async function deepen() {
  const { last } = await chrome.storage.session.get('last');
  if (last) await lookup(last.profile, { prior: last.research, replaceId: last.resultId });
}

async function setCurrent(state) {
  await chrome.storage.session.set({ current: { ...state, updatedAt: Date.now() } });
}

async function lookup(profile, { prior = null, replaceId = null } = {}) {
  const startedAt = Date.now();
  const steps = [];
  const running = () => setCurrent({ status: 'running', deep: !!prior, steps: [...steps], startedAt, name: profile?.heading, profileUrl: profile?.url });
  await running();
  try {
    const settings = await getSettings();
    const { research, ...result } = await runLookup({ profile, prior }, settings, {
      deep: !!prior,
      onProgress: (step) => { steps.push(step); return running(); },
    });
    result.durationMs = Date.now() - startedAt;
    // Page text from the research stays in session memory only (too large for history).
    await chrome.storage.session.set({ last: { profile, research, resultId: result.id } });
    await setCurrent({ status: 'done', result });
    const { history = [] } = await chrome.storage.local.get('history');
    const kept = replaceId ? history.filter((h) => h.id !== replaceId) : history;
    kept.unshift(result);
    await chrome.storage.local.set({ history: kept.slice(0, HISTORY_MAX) });
  } catch (e) {
    await setCurrent({ status: 'error', error: e.message || String(e) });
  }
}
