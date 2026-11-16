/**
 * Interactions: the token, its action kinds, and answering without buttons (`06` §3.7; `M3-T6`).
 *
 * Four files, in the order a click travels:
 *
 * | File | What |
 * |---|---|
 * | `token.ts` | The opaque 25-byte token, its hash, and its constant-time comparison |
 * | `registry.ts` | Which `action.kind`s this build knows, and the shape of each one's params |
 * | `buttons.ts` | `06` §3.7's per-message limits and label truncation |
 * | `fallback.ts` | The same choice as reactions or numbered text, where there are no buttons |
 * | `choice-parser.ts` | Reading an answer that arrived as a reaction or as typed text |
 */
export {
  LABEL_ELLIPSIS,
  type LayoutOptions,
  layoutActionRows,
  PRODUCT_BUTTON_LIMITS,
  truncateButtonLabel,
} from './buttons.js';
export {
  AFFIRMATIVE_KEYS,
  type ChoiceInput,
  type ChoiceLexicon,
  type ChoiceReply,
  EN_CHOICE_LEXICON,
  NEGATIVE_KEYS,
  type ParseChoiceOptions,
  parseChoiceReply,
} from './choice-parser.js';
export {
  type ChoiceFallback,
  type ChoiceFallbackOptions,
  type ChoiceOption,
  MAX_REACTION_CHOICES,
  renderChoiceFallback,
} from './fallback.js';
export {
  ACTION_KIND_MAX_CHARS,
  ACTION_KIND_PATTERN,
  type ActionKind,
  ActionKindRegistry,
  type ActionResolution,
  actionKind,
  type StoredAction,
} from './registry.js';
export {
  type ClickAttempt,
  type ClickDecision,
  clickReply,
  decideClick,
  type InteractionTokenRecordLike,
  isAllowed,
} from './resolve.js';
export {
  DEFAULT_INTERACTION_TOKEN_TTL_DAYS,
  defaultInteractionTokenExpiry,
  INTERACTION_TOKEN_BYTES,
  INTERACTION_TOKEN_ENTROPY_BYTES,
  INTERACTION_TOKEN_PATTERN,
  INTERACTION_TOKEN_VERSION,
  interactionTokenHash,
  interactionTokenMatches,
  isInteractionToken,
  mintInteractionToken,
  tokenFitsButtonLimits,
} from './token.js';
