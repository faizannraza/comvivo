/**
 * Host-only enforcement (`01` §14 A14, `08` §5).
 *
 * This is a security boundary, not a preference. Group admins are members, and `01` §9 trust
 * boundary 2 says a member may be adversarial toward the others. These tests assert both halves:
 * the keys that must be protected are, and the keys a group legitimately owns are not — because a
 * list that over-protects would push admins toward editing YAML by hand, which is worse.
 */
import { describe, expect, it } from 'vitest';
import { HOST_ONLY_PATHS, hostOnlyPathsIn, isHostOnly } from './host-only.js';
import { configLeaves } from './paths.js';

describe('keys that must be host-only', () => {
  it.each([
    // Who we talk to, and with whose money.
    ['models.preset', 'an admin could redirect every message to a provider they control'],
    ['models.routes', 'same, per route'],
    ['embeddings.provider', 'embeddings of private memories would leave the host'],
    ['transcription.provider', 'voice notes would leave the host'],
    // Where bytes may go.
    ['network.egress.allowPrivate', 'this is the allowlist that makes invariant I5 real'],
    ['network.egress.allowHttpHosts', 'downgrading to plaintext is a host decision'],
    ['outbound.allowedLinkDomains', 'a link allowlist is an exfiltration channel if widened'],
    // What runs in our process.
    ['plugins.runner', 'running plugins in-process versus a container is a host decision'],
    ['plugins.requireApproval', 'an admin must not be able to stop approving code'],
    ['mcp.server.http.enabled', 'opening an API surface is a host decision'],
    // Keys and encryption.
    ['security.keys.store', 'where the master key lives'],
    ['security.keys.keyfilePath', 'the path to the master key'],
    ['privacy.encryptAtRest', 'turning off encryption must never be a session away'],
    ['privacy.localOnly', 'whether anything may leave the machine at all'],
    ['privacy.sensitiveRoutesLocal', 'whether sensitive routes stay on a local model'],
    // How the instance is exposed.
    ['dashboard.bind', 'binding beyond loopback changes who can reach the UI'],
    ['dashboard.allowedHosts', 'Host-header validation'],
    ['dashboard.trustProxy', 'trusting forwarded headers is how auth gets spoofed'],
    ['dashboard.allowInsecureLan', 'serving credentials over plaintext on a LAN'],
    ['dashboard.auth.magicLinks', 'magic links over the network is an explicit opt-in (A9)'],
    ['dashboard.tls.certFile', 'TLS material'],
    ['dashboard.ingress.enabled', 'the Home Assistant ingress port'],
    ['ics.port', 'a second listener'],
    // Ceilings a group may not raise for itself.
    [
      'privacy.maxMessageRetentionDays',
      'a group may shorten retention, never lengthen the ceiling',
    ],
    ['privacy.logRetentionDays', 'host-owned log retention'],
    ['traces.retentionDays', 'trace retention ceiling'],
    ['traces.captureModelIO', 'capturing model input and output is opt-in by the host only'],
    // Content debug logging and phoning home.
    ['logging.debugContent', 'this logs message and memory content'],
    ['updates.check', 'ADR-017 is zero telemetry; the update check is opt-in'],
  ])('protects %s — %s', (path) => {
    expect(isHostOnly(path)).toBe(true);
  });

  it('protects a subtree root as firmly as its leaves', () => {
    // Setting `models` wholesale must be refused as firmly as setting one route inside it.
    expect(isHostOnly('models')).toBe(true);
    expect(isHostOnly('network')).toBe(true);
    expect(isHostOnly('plugins')).toBe(true);
  });

  it('protects paths deeper than any we have written yet', () => {
    // Subtrees are protected prospectively, so a key added in M9 is covered on the day it lands
    // rather than on the day someone remembers to add it here.
    expect(isHostOnly('models.routes.chat.provider.apiKeyRef')).toBe(true);
    expect(isHostOnly('network.egress.someFutureKnob')).toBe(true);
  });
});

describe('keys a group legitimately owns', () => {
  it.each([
    ['instance.name', 'the group names itself'],
    ['privacy.messageRetentionDays', 'a constitution may shorten retention (up to the ceiling)'],
    ['logging.level', 'verbosity is not a security boundary'],
    ['logging.format', 'pretty or json'],
    ['dashboard.sessions.idleHours', 'session length is an admin preference'],
    ['dashboard.auth.pairingCodes', 'whether to use pairing codes'],
    ['dashboard.auth.pairingCodeTtlMinutes', 'how long a pairing code lives'],
    ['outbound.linkPreviews', 'whether to show link previews at all'],
    ['outbound.maxMentionsPerMessage', 'an anti-spam preference'],
    ['budgets.monthlyUsd', 'a group may cap its own spend'],
    ['backups.keep', 'how many backups to retain'],
    ['channels.telegram.enabled', 'which channels are on'],
  ])('leaves %s editable — %s', (path) => {
    expect(isHostOnly(path)).toBe(false);
  });

  it('does not protect a path merely because it shares a prefix with a protected one', () => {
    // `privacy.maxMessageRetentionDays` is protected; `privacy.messageRetentionDays` is not. A
    // prefix match done carelessly would protect both and silently stop constitutions working.
    expect(isHostOnly('privacy.maxMessageRetentionDays')).toBe(true);
    expect(isHostOnly('privacy.messageRetentionDays')).toBe(false);
  });

  it('does not protect an unrelated key that merely starts with the same letters', () => {
    expect(isHostOnly('modelsomething')).toBe(false);
    expect(isHostOnly('networkish')).toBe(false);
  });
});

describe('hostOnlyPathsIn', () => {
  it('reports exactly the protected paths, sorted, for the 403 response', () => {
    expect(
      hostOnlyPathsIn(['instance.name', 'network.egress.allowPrivate', 'logging.debugContent']),
    ).toEqual(['logging.debugContent', 'network.egress.allowPrivate']);
  });

  it('returns nothing for a legitimate settings patch', () => {
    expect(hostOnlyPathsIn(['instance.name', 'logging.level'])).toEqual([]);
  });
});

describe('the list and the schema agree', () => {
  it('protects at least one real leaf for every pattern, so no pattern is dead', () => {
    const paths = configLeaves().map((leaf) => leaf.path);
    // `mcp.*`, `security.*` and so on must each match something that exists; a pattern that
    // matches nothing is a protection someone believes they have and does not.
    const dead = HOST_ONLY_PATHS.filter((pattern) => {
      const prefix = pattern.endsWith('.*') ? `${pattern.slice(0, -2)}.` : undefined;
      return prefix === undefined
        ? !paths.includes(pattern)
        : !paths.some((path) => path.startsWith(prefix));
    });
    expect(dead, 'these host-only patterns match no key in the schema').toEqual([]);
  });
});
