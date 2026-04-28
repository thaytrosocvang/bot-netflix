/**
 * Application Emoji helper for Discord.js v14
 *
 * Usage:
 *   import { initAppEmojis, e, btnEmoji } from './utils/emoji.js';
 *
 *   // Fetch emojis once when bot is ready
 *   await initAppEmojis(client);
 *
 *   // In embeds / messages
 *   .setTitle(`${e('netflix')} Netflix của Tún Kịt`)
 *
 *   // In buttons (ButtonBuilder)
 *   new ButtonBuilder().setEmoji(btnEmoji('phone'))
 *
 * To add your own custom emojis:
 *   1. Go to https://discord.com/developers/applications
 *   2. Select your bot → "Emoji" tab
 *   3. Upload images (PNG/JPG/GIF) and name them EXACTLY as the keys below
 *      e.g. "netflix", "premium", "phone", "country_us", "country_vn" …
 *   4. Restart the bot. It will auto-fetch the IDs.
 */

const EMOJI_REGISTRY = new Map();

/** Fallback Unicode map when application emoji is missing */
const FALLBACKS = {
  netflix: '🎬',
  premium: '💎',
  standard: '⭐',
  basic: '🔵',
  mobile: '📱',
  phone: '📱',
  pc: '🖥️',
  guide: '📖',
  country: '🌍',
  email: '📧',
  cookie: '🍪',
  trash: '🗑️',
  success: '✅',
  error: '❌',
  warning: '⚠️',
  loading: '⏳',
  party: '🎉',
  ticket: '🎟️',
  film: '🎞️',
  star: '⭐',
  fire: '🔥',
  crown: '👑',
  info: 'ℹ️',
  files: '🗂️',
  inbox: '📭',
};

/**
 * Fetch all application emojis and cache them.
 * Call this once inside client.on(Events.ClientReady, …).
 */
export async function initAppEmojis(client) {
  try {
    const emojis = await client.application.emojis.fetch();
    EMOJI_REGISTRY.clear();
    for (const emoji of emojis.values()) {
      EMOJI_REGISTRY.set(emoji.name, emoji);
    }
    console.log(`[Emoji] Loaded ${EMOJI_REGISTRY.size} application emojis.`);
  } catch (err) {
    console.error('[Emoji] Failed to load application emojis:', err.message);
  }
}

/**
 * Return a formatted emoji string for use in messages / embeds.
 * @param {string} name - The application emoji name (must match upload name).
 * @returns {string} `<:name:id>` if found, otherwise fallback Unicode.
 */
export function e(name) {
  const emoji = EMOJI_REGISTRY.get(name);
  if (emoji) {
    return emoji.animated
      ? `<a:${emoji.name}:${emoji.id}>`
      : `<:${emoji.name}:${emoji.id}>`;
  }
  return FALLBACKS[name] || '';
}

/**
 * Return an emoji object for ButtonBuilder.setEmoji().
 * @param {string} name - The application emoji name.
 * @returns {{id: string, name: string}|null}
 */
export function btnEmoji(name) {
  const emoji = EMOJI_REGISTRY.get(name);
  if (emoji) {
    return { id: emoji.id, name: emoji.name };
  }
  return null;
}

/**
 * Return a country-flag emoji.
 * Priority:
 *   1. Application emoji named "country_xx" (custom flag image you uploaded).
 *   2. Auto-generated Unicode regional-indicator flag (🇺🇸 🇻🇳 🇯🇵 …).
 *   3. Fallback 🌍 if code is invalid.
 *
 * @param {string} countryCode - 2-letter ISO code, e.g. "US", "VN", "JP"
 * @returns {string} emoji string
 */
export function flag(countryCode) {
  const code = (countryCode || '').trim().toUpperCase();

  // 1. Try custom application emoji first (e.g. country_us)
  const custom = e(`country_${code.toLowerCase()}`);
  if (custom) return custom;

  // 2. Auto-generate Unicode regional-indicator flag
  //    A = 0x1F1E6, B = 0x1F1E7, … Z = 0x1F1FF
  if (code.length === 2 && /^[A-Z]{2}$/.test(code)) {
    const regionalIndicatorOffset = 0x1F1E6; // 🇦
    const charA = code.charCodeAt(0) - 65 + regionalIndicatorOffset;
    const charB = code.charCodeAt(1) - 65 + regionalIndicatorOffset;
    return String.fromCodePoint(charA, charB);
  }

  return '🌍';
}

/**
 * Get a dynamic plan emoji by plan string.
 * Looks for app emoji named after the plan, falls back to static mapping.
 */
export function planEmoji(plan = '') {
  const p = plan.toLowerCase().replace(/\s+/g, '_');
  // Try exact match first (e.g. "premium", "standard_with_ads")
  if (EMOJI_REGISTRY.has(p)) return e(p);
  // Fallback heuristics
  if (p.includes('premium')) return e('premium') || '💎';
  if (p.includes('standard')) return e('standard') || '⭐';
  if (p.includes('basic')) return e('basic') || '🔵';
  if (p.includes('mobile')) return e('mobile') || '📱';
  return e('netflix') || '🎬';
}

