/**
 * Rate limiting (`06` §3.14; `M3-T7`).
 *
 * | File | What |
 * |---|---|
 * | `bucket.ts` | One token bucket, refilling continuously from the injected `Clock` |
 * | `scheduler.ts` | The waiting order: priority, then round-robin across chats, then FIFO |
 * | `limiter.ts` | Atomic multi-key acquire, with no starvation of interactive work |
 *
 * The retry policy that pairs with this is `../retry.ts` (`06` §3.14's second half).
 */
export { type BucketSpec, bucketSpec, TokenBucket } from './bucket.js';
export {
  type BucketKey,
  bucketKeys,
  CHAT_KEY_PREFIX,
  RateLimiter,
  type RateLimiterDeps,
} from './limiter.js';
export { FairQueue, priorityRank, type Waiter } from './scheduler.js';
