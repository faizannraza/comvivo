/**
 * `@comvivo/channel-sdk`
 *
 * The channel adapter contract: the capability model, the inbound and outbound envelopes, the
 * error taxonomy, the per-platform capability profiles, and the zod schemas for the shapes that
 * cross a trust boundary. `01` §14 **A26** makes `06` §4.1 authoritative and this package is its
 * implementation.
 *
 * The RichText parser landed at `M3-T3`. Arriving later in M3, each with the task that can
 * implement it honestly: the renderers and measurement (`M3-T4`), the splitter (`M3-T5`),
 * interactions and the choice fallback (`M3-T6`), the rate limiter and retry helpers (`M3-T7`),
 * the typing manager (`M3-T8`), and the conformance kit and its `./testing` entry point
 * (`M3-T9`).
 *
 * ## What this package may import
 *
 * `@comvivo/core` and `@comvivo/shared` only, plus `zod` as a **peer** — because an adapter and
 * the engine must agree on one zod instance for a schema to be comparable. dependency-cruiser's
 * `PURE_PACKAGES` refuses a `node:*` import here, and `comvivo/channel-sdk-purity` in
 * `eslint.config.ts` bans `Date`, `process`, `fetch`, `Math.random` and the timers: every one has
 * a replacement on the `AdapterContext` an adapter is handed.
 */

import type { z } from 'zod';
import type { AdapterFactory, ChannelAdapter, ChannelId } from './contract.js';

export type {
  ActionButton,
  ActionRow,
  AdapterContext,
  AdapterFactory,
  AdapterHealth,
  AdapterStateStore,
  AttachmentKind,
  AttachmentRef,
  BindingView,
  ButtonLimits,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelEvent,
  ChannelId,
  ChannelMetrics,
  ChatProbe,
  CommandSpec,
  Diagnostic,
  HealthReporter,
  InboundAttachment,
  InboundEnvelope,
  InboundInteraction,
  IngestAck,
  LinkPreview,
  Markup,
  MemberListing,
  MentionTarget,
  OutboundAttachment,
  OutboundMessage,
  PlatformChatRef,
  PlatformMember,
  PlatformMessageRef,
  PlatformPollRef,
  PollFinalTally,
  PollLimits,
  PollSpec,
  Priority,
  RenderContext,
  RenderedPart,
  ResolvedMention,
  RichText,
  SelfInfo,
  SendProgressSink,
  SendReceipt,
  SentPart,
  WebhookRegistrar,
} from './contract.js';
export {
  CHANNEL_ERROR_KINDS,
  ChannelError,
  type ChannelErrorDetails,
  type ChannelErrorKind,
  isRetryableKind,
} from './errors.js';
export { PROFILE_NAMES, type ProfileName, profiles } from './profiles.js';
// --- RichText parsing (06 §3.5.1–§3.5.2; M3-T3) -----------------------------------------------
//
// The AST and `RichTextSchema` are **not** re-exported: they live in `@comvivo/core` (see that
// module's header), and a second name for one type is how two of them come to exist.
export {
  applyCustomSyntax,
  type CustomSyntaxOptions,
  canonicalMarks,
  type MentionResolution,
  type MentionResolver,
  textNode,
  UNRESOLVED_MENTION_TEXT,
} from './richtext/custom-syntax.js';
export {
  DEGRADE_REASONS,
  DEGRADE_TRUNCATION_NOTICE,
  type DegradeReason,
  degradeLinkToText,
  degradeToPlain,
  MAX_DEGRADED_PARAGRAPHS,
  tableToCodeBlock,
  truncateToJsonBytes,
  utf8Length,
} from './richtext/degrade.js';
export { type ParseOptions, type ParseResult, parseModelOutput } from './richtext/parse.js';
export { sketch, sketchBlock, sketchInline } from './richtext/sketch.js';
export {
  ActionButtonSchema,
  AttachmentRefSchema,
  ButtonLimitsSchema,
  ChannelCapabilitiesSchema,
  ChannelEventSchema,
  InboundAttachmentSchema,
  InboundEnvelopeSchema,
  InboundInteractionSchema,
  IngestAckSchema,
  LinkPreviewSchema,
  OutboundMessageSchema,
  PlatformChatRefSchema,
  PlatformMessageRefSchema,
  PlatformPollRefSchema,
  PollFinalTallySchema,
  PollLimitsSchema,
  PollSpecSchema,
  ResolvedMentionSchema,
  SentPartSchema,
} from './schemas.js';

/**
 * Declare an adapter and the config shape a host must satisfy (`06` §4.1).
 *
 * Thin on purpose: it returns the three fields it was given. The value is not the function but
 * the **shape it forces** — an adapter that reaches the composition root carries its own
 * `configSchema`, so `apps/server` validates a host's YAML against the adapter that will use it
 * rather than against a central list somebody has to remember to update. A host who misspells a
 * Telegram setting learns it at boot, from the adapter that cares.
 *
 * `create` is not called here. Construction happens after validation, which is what lets an
 * adapter's constructor assume its config is already the right shape.
 */
export function defineAdapter<C>(def: {
  readonly id: ChannelId;
  readonly configSchema: z.ZodType<C>;
  create(config: C): ChannelAdapter;
}): AdapterFactory<C> {
  return {
    id: def.id,
    configSchema: def.configSchema,
    // Wrapped rather than passed as `create: def.create`, which would detach the method from
    // `def` and lose `this`. An adapter author who writes `create()` as a method on an object
    // literal and reaches for `this.something` would get `undefined` at construction time — a
    // crash at boot, in third-party code, caused by this line. `typescript-eslint`'s
    // `unbound-method` names exactly that.
    create: (config: C) => def.create(config),
  };
}
