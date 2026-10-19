// USD per 1M tokens. Override per model in Settings ("Custom pricing") when
// your provider's prices differ or you use a model not listed here.
export const PRICING = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export function llmCost(model, usage, custom = {}) {
  const p = custom[model] || PRICING[model];
  if (!p || !usage) return null;
  // Web search is billed per search ($10 per 1,000) on top of tokens.
  return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1e6 + (usage.web_searches || 0) * 0.01;
}
