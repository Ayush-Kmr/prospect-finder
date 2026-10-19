export const DEFAULTS = {
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  apolloKey: '',
  pdlKey: '',
  hunterKey: '',
  verifyGuesses: true,
  revealPersonalEmails: false,
  customPricing: {},
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  await chrome.storage.local.set({ settings: { ...current, ...patch } });
}
