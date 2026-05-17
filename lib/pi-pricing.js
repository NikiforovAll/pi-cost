'use strict';

const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const TIERED_THRESHOLD = 200_000;
const PRICING_REFRESH_MS = 6 * 60 * 60 * 1000;

const PI_ROUTING_PROVIDERS = new Set(['dial', 'exa', 'github-copilot', 'github_copilot', 'auto']);

// Strip pi-side decoration so we can match LiteLLM canonical keys.
// Examples: claude-sonnet-4.6 -> claude-sonnet-4-5  (pi uses dotted minor)
function piIdNormalizations(modelId) {
  if (!modelId) return [];
  const lower = String(modelId).toLowerCase().trim();
  const out = new Set();
  out.add(lower);
  const dotToDash = lower.replace(/(\d)\.(\d)/g, '$1-$2');
  out.add(dotToDash);
  // claude-sonnet-4.6 -> claude-sonnet-4-5 (pi numbering, LiteLLM uses prior step)
  const stripMinor = lower.replace(/(claude-(?:sonnet|haiku|opus)-\d+)\.\d+/g, '$1');
  out.add(stripMinor);
  return [...out];
}

const OFFLINE_PRICING = {
  'anthropic/claude-sonnet-4-5': {
    input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5,
    cache_creation_input_token_cost: 3.75e-6, cache_read_input_token_cost: 3e-7,
    input_cost_per_token_above_200k_tokens: 6e-6, output_cost_per_token_above_200k_tokens: 2.25e-5,
    cache_creation_input_token_cost_above_200k_tokens: 7.5e-6, cache_read_input_token_cost_above_200k_tokens: 6e-7,
  },
  'anthropic/claude-haiku-4-5': {
    input_cost_per_token: 8e-7, output_cost_per_token: 4e-6,
    cache_creation_input_token_cost: 1e-6, cache_read_input_token_cost: 8e-8,
  },
  'anthropic/claude-opus-4-1': {
    input_cost_per_token: 1.5e-5, output_cost_per_token: 7.5e-5,
    cache_creation_input_token_cost: 1.875e-5, cache_read_input_token_cost: 1.5e-6,
  },
  'openai/gpt-5': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 2.5e-7 },
  'openai/gpt-5-mini': { input_cost_per_token: 2.5e-7, output_cost_per_token: 2e-6, cache_read_input_token_cost: 2.5e-8 },
  'openai/gpt-4': { input_cost_per_token: 3e-5, output_cost_per_token: 6e-5 },
  'openai/gpt-4o': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 },
  'openai/gpt-4o-mini': { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7 },
  'gemini/gemini-2.5-pro': { input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
};

let cachedPricing = null;
let pricingFetchedAt = 0;
let pricingSource = 'none';

async function fetchPricing() {
  const now = Date.now();
  if (cachedPricing && (now - pricingFetchedAt) < PRICING_REFRESH_MS) return cachedPricing;
  try {
    const resp = await fetch(LITELLM_PRICING_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const pricing = new Map();
    for (const [name, info] of Object.entries(data)) {
      if (typeof info !== 'object' || info == null) continue;
      if (info.input_cost_per_token != null || info.output_cost_per_token != null) {
        pricing.set(name, info);
      }
    }
    cachedPricing = pricing;
    pricingFetchedAt = now;
    pricingSource = 'litellm';
    console.log(`[pi-cost pricing] loaded ${pricing.size} models from LiteLLM`);
    return pricing;
  } catch (err) {
    console.warn('[pi-cost pricing] fetch failed, using offline fallback:', err.message);
    if (!cachedPricing) {
      cachedPricing = new Map(Object.entries(OFFLINE_PRICING));
      pricingFetchedAt = now;
      pricingSource = 'offline';
    }
    return cachedPricing;
  }
}

function refresh() {
  cachedPricing = null;
  pricingFetchedAt = 0;
  pricingSource = 'none';
}

function getMeta() {
  return {
    fetchedAt: pricingFetchedAt ? new Date(pricingFetchedAt).toISOString() : null,
    source: pricingSource,
    modelCount: cachedPricing ? cachedPricing.size : 0,
  };
}

function lookupExact(pricing, key) {
  if (!key) return null;
  const direct = pricing.get(key);
  if (direct) return { key, info: direct };
  return null;
}

function resolveKey(pricing, provider, modelId) {
  if (!pricing || !modelId) return null;
  const candidates = piIdNormalizations(modelId);
  const providerLower = provider ? String(provider).toLowerCase() : null;
  const isRouting = providerLower ? PI_ROUTING_PROVIDERS.has(providerLower) : false;

  // 1. Exact match on every normalized id.
  for (const c of candidates) {
    const hit = lookupExact(pricing, c);
    if (hit) return hit;
  }

  // 2. provider/model when the provider is a real upstream (not a pi billing route).
  if (providerLower && !isRouting) {
    for (const c of candidates) {
      const hit = lookupExact(pricing, `${providerLower}/${c}`);
      if (hit) return hit;
    }
  }

  // 3. Anthropic / openai / gemini prefixes for unrouted pi model IDs.
  const knownPrefixes = ['anthropic/', 'openai/', 'gemini/', 'mistral/', 'groq/'];
  for (const c of candidates) {
    for (const p of knownPrefixes) {
      const hit = lookupExact(pricing, `${p}${c}`);
      if (hit) return hit;
    }
  }

  // 4. Fuzzy: longest LiteLLM key whose tail-segment matches any candidate.
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    for (const [key, info] of pricing) {
      const kLower = key.toLowerCase();
      const tail = kLower.split('/').pop();
      // exact tail match wins
      if (tail === c && c.length > bestScore) {
        best = { key, info }; bestScore = c.length + 10;
        continue;
      }
      if (tail && (tail.includes(c) || c.includes(tail))) {
        const score = Math.min(tail.length, c.length);
        if (score > bestScore) { best = { key, info }; bestScore = score; }
      }
    }
  }
  return best;
}

function calculateTieredCost(tokens, basePrice, tieredPrice, threshold = TIERED_THRESHOLD) {
  if (!tokens || tokens <= 0) return 0;
  if (tokens > threshold && tieredPrice != null) {
    const below = Math.min(tokens, threshold);
    const above = Math.max(0, tokens - threshold);
    let cost = above * tieredPrice;
    if (basePrice != null) cost += below * basePrice;
    return cost;
  }
  if (basePrice != null) return tokens * basePrice;
  return 0;
}

function computeCost(info, usage) {
  const input = calculateTieredCost(
    usage.input || 0, info.input_cost_per_token,
    info.input_cost_per_token_above_200k_tokens);
  const output = calculateTieredCost(
    usage.output || 0, info.output_cost_per_token,
    info.output_cost_per_token_above_200k_tokens);
  const cacheWrite = calculateTieredCost(
    usage.cacheWrite || 0, info.cache_creation_input_token_cost,
    info.cache_creation_input_token_cost_above_200k_tokens);
  const cacheRead = calculateTieredCost(
    usage.cacheRead || 0, info.cache_read_input_token_cost,
    info.cache_read_input_token_cost_above_200k_tokens);
  return input + output + cacheWrite + cacheRead;
}

// Pi-shaped usage: { input, output, cacheRead, cacheWrite, cost: { total } }
// Returns { cost, source, modelKey }
function estimate(pricing, provider, modelId, usage) {
  if (!usage) return { cost: 0, source: 'none', modelKey: null };
  const jsonlTotal = usage.cost && typeof usage.cost.total === 'number' ? usage.cost.total : 0;
  if (jsonlTotal > 0) {
    return { cost: jsonlTotal, source: 'jsonl', modelKey: null };
  }
  const match = resolveKey(pricing, provider, modelId);
  if (!match) return { cost: 0, source: 'none', modelKey: null };
  const cost = computeCost(match.info, usage);
  return { cost, source: 'pricing', modelKey: match.key };
}

module.exports = { fetchPricing, refresh, getMeta, estimate, resolveKey };
