-- A **new migration** rather than a line added to `0002`, where `.unique()` should have been from
-- the start. `02` §3.12.3's forward-only rule has no "but it is not released yet" clause, and
-- `ddl.int.test.ts` pins `0002`'s bytes precisely so a correction cannot be smuggled into an
-- applied migration: a host who has run `0002` will never run it again, so an edit there is a
-- schema that exists only on machines installed afterwards.
--
-- The constraint itself came out of writing `redeemClaimCode`, whose statement matches
-- `code_hash = ? OR link_token_hash = ?` (`06` §3.20.1: "Either redeems the code once"). Two rows
-- sharing a link token would be two codes spent by one 22-character token.
CREATE UNIQUE INDEX `claim_codes_link_token_hash_unique` ON `claim_codes` (`link_token_hash`);
