import { describe, expect, it } from 'vitest';
import { classifyTarget, formatTargetVerdict } from '../../e2e/target-classifier.js';

/**
 * aperture-odyxd — regressions for the exact-host E2E target classifier.
 *
 * The classifier this replaces was an unanchored substring regex tested
 * against the whole URL. The five "deceptive" cases below are the ACTUAL
 * misclassifications measured against that old implementation — every one of
 * them read as LOCAL. They are the reason this module exists, so each gets a
 * named assertion rather than being folded into a loop.
 *
 * Safety asymmetry under test: local-read-as-remote merely blocks a run;
 * remote-read-as-local can move real money, because eunenem staging carries
 * live payment credentials. Ambiguity must therefore resolve to REMOTE.
 */
describe('classifyTarget — genuine local targets are allowed', () => {
  it('bare localhost with port → LOCAL', () => {
    const v = classifyTarget('http://localhost:3002');
    expect(v.isLocal).toBe(true);
    expect(v.hostname).toBe('localhost');
    expect(v.reason).toBe('exact-local-host');
  });

  it('127.0.0.1 → LOCAL', () => {
    expect(classifyTarget('http://127.0.0.1:3002').isLocal).toBe(true);
  });

  it('IPv6 loopback ::1 → LOCAL, brackets stripped from hostname', () => {
    const v = classifyTarget('http://[::1]:3002');
    expect(v.isLocal).toBe(true);
    expect(v.hostname).toBe('::1');
  });

  it('trailing-dot FQDN form "localhost." → LOCAL (same host)', () => {
    expect(classifyTarget('http://localhost.:3002').isLocal).toBe(true);
  });

  it('uppercase host → LOCAL (normalised)', () => {
    expect(classifyTarget('http://LOCALHOST:3002').isLocal).toBe(true);
  });

  it('unset → LOCAL, flagged as the documented default (suite spawns its own server)', () => {
    const v = classifyTarget(undefined);
    expect(v.isLocal).toBe(true);
    expect(v.provided).toBe(false);
    expect(v.reason).toBe('unset-default-local');
  });

  it('empty and whitespace-only are treated as unset → LOCAL', () => {
    expect(classifyTarget('').reason).toBe('unset-default-local');
    expect(classifyTarget('   ').reason).toBe('unset-default-local');
  });
});

describe('classifyTarget — real remote targets are blocked', () => {
  it('eunenem staging → REMOTE', () => {
    const v = classifyTarget('https://eunenem.test.pocketsoftware.com.br');
    expect(v.isLocal).toBe(false);
    expect(v.reason).toBe('remote-host');
  });

  it('staging.eunenem.com → REMOTE', () => {
    expect(classifyTarget('https://staging.eunenem.com').isLocal).toBe(false);
  });

  it('production → REMOTE', () => {
    expect(classifyTarget('https://eunenem.pocketsoftware.com.br').isLocal).toBe(false);
  });
});

describe('classifyTarget — the five cases the old substring regex got WRONG', () => {
  it('localhost in a query param does not make staging local', () => {
    const v = classifyTarget('https://staging.eunenem.com/?redirect=localhost');
    expect(v.isLocal).toBe(false);
    expect(v.hostname).toBe('staging.eunenem.com');
  });

  it('localhost as a subdomain of an attacker domain is REMOTE', () => {
    const v = classifyTarget('https://localhost.attacker.example');
    expect(v.isLocal).toBe(false);
    expect(v.hostname).toBe('localhost.attacker.example');
  });

  it('localhost in the URL fragment does not make staging local', () => {
    // This is the cheapest bypass of the old regex: append "#localhost".
    const v = classifyTarget('https://eunenem.test.pocketsoftware.com.br#localhost');
    expect(v.isLocal).toBe(false);
    expect(v.hostname).toBe('eunenem.test.pocketsoftware.com.br');
  });

  it('127.0.0.1 as a subdomain prefix is REMOTE', () => {
    expect(classifyTarget('https://127.0.0.1.evil.example').isLocal).toBe(false);
  });

  it('a deceptive localhost-LOOKING hostname is REMOTE', () => {
    const v = classifyTarget('https://my-localhost-staging.eunenem.com');
    expect(v.isLocal).toBe(false);
    expect(v.hostname).toBe('my-localhost-staging.eunenem.com');
  });

  it('the old regex would have accepted all five — this pins the fix', () => {
    const oldRegexSaysLocal = (u: string) => /localhost|127\.0\.0\.1/.test(u);
    const deceptive = [
      'https://staging.eunenem.com/?redirect=localhost',
      'https://localhost.attacker.example',
      'https://eunenem.test.pocketsoftware.com.br#localhost',
      'https://127.0.0.1.evil.example',
      'https://my-localhost-staging.eunenem.com',
    ];
    for (const url of deceptive) {
      expect(oldRegexSaysLocal(url)).toBe(true); // old: LOCAL (the bug)
      expect(classifyTarget(url).isLocal).toBe(false); // new: REMOTE (fixed)
    }
  });
});

describe('classifyTarget — malformed input FAILS CLOSED (remote)', () => {
  it('unparseable garbage → REMOTE', () => {
    const v = classifyTarget('not a url at all');
    expect(v.isLocal).toBe(false);
    expect(v.reason).toBe('malformed-fail-closed');
    expect(v.hostname).toBeNull();
  });

  it('scheme-less "localhost:3002" → REMOTE (no host component)', () => {
    // Parses as protocol "localhost:", yielding an empty hostname. We cannot
    // prove it is local, so it is remote. Supply a full URL with a scheme.
    const v = classifyTarget('localhost:3002');
    expect(v.isLocal).toBe(false);
    expect(v.reason).toBe('malformed-fail-closed');
  });

  it('other loopback addresses are REMOTE by design (narrow allowlist)', () => {
    expect(classifyTarget('http://127.0.0.2:3002').isLocal).toBe(false);
  });
});

describe('formatTargetVerdict — privacy contract', () => {
  it('logs hostname and verdict, and NEVER the query, fragment, or credentials', () => {
    const line = formatTargetVerdict(
      classifyTarget('https://user:sekret@staging.eunenem.com/path?token=abc123#localhost'),
    );
    expect(line).toContain('staging.eunenem.com');
    expect(line).toContain('REMOTE');
    // The exact leak vectors that must never reach a CI log:
    expect(line).not.toContain('sekret');
    expect(line).not.toContain('token');
    expect(line).not.toContain('abc123');
    expect(line).not.toContain('#localhost');
    expect(line).not.toContain('/path');
  });

  it('a local verdict renders as LOCAL', () => {
    expect(formatTargetVerdict(classifyTarget('http://localhost:3002'))).toContain('LOCAL');
  });

  it('a malformed target logs no host, only the fail-closed reason', () => {
    const line = formatTargetVerdict(classifyTarget('not a url'));
    expect(line).toContain('<unparseable>');
    expect(line).toContain('REMOTE');
    expect(line).toContain('malformed-fail-closed');
  });
});
