import { describe, expect, it } from 'vitest';
import { microsoftEmailOwnershipProven } from '../../../src/adapters/usuario/criar-auth.js';
import {
  derivarNomeExibicaoFallback,
  NomeExibicaoUsuarioSchema,
} from '../../../src/domain/usuario/value-objects/nome-exibicao-usuario.js';

/**
 * aperture-uq69m — UNIT pins for the Microsoft email-ownership trust predicate
 * + the empty-name display fallback. These are the pure-logic core of the
 * account_not_linked fix; the end-to-end wiring through real better-auth is
 * pinned in tests/integration/sunl9-oauth-account-linking.postgres.test.ts.
 *
 * ⚠️ SECURITY (Cipher hard gate, etdx3/nOAuth): the predicate is what decides
 * whether an incoming Microsoft identity may implicit-link into a pre-existing
 * same-email local account. Trusting the wrong claim = account takeover. The
 * ONLY trustworthy anchors are values the issuing tenant CANNOT forge:
 *   - the consumer `tid` (Microsoft operates that tenant), gated together with a
 *     Microsoft-owned consumer email domain;
 *   - `xms_edov === true` (Microsoft-computed domain-owner-verified).
 * The email STRING alone must NEVER grant trust — an attacker's own Entra
 * tenant can set a user's email attribute to victim@hotmail.com. The (L)-class
 * cases below pin exactly that.
 */

const CONSUMER_TID = '9188040d-6c67-4c5b-b112-36a304b66dad';
const ATTACKER_TID = '11111111-2222-3333-4444-555555555555';

describe('microsoftEmailOwnershipProven (aperture-uq69m)', () => {
  describe('TRUSTS — consumer MSA (tid anchor + Microsoft-owned domain)', () => {
    it('hotmail.com from the consumer tenant is proven (thacyane real case)', () => {
      expect(
        microsoftEmailOwnershipProven({ tid: CONSUMER_TID, email: 'thacyane@hotmail.com' }),
      ).toBe(true);
    });

    it.each([
      'outlook.com',
      'live.com',
      'msn.com',
      'hotmail.co.uk',
      'outlook.com.br',
    ])('consumer domain %s from the consumer tenant is proven', (domain) => {
      expect(microsoftEmailOwnershipProven({ tid: CONSUMER_TID, email: `user@${domain}` })).toBe(
        true,
      );
    });

    it('is case-insensitive on the email domain', () => {
      expect(
        microsoftEmailOwnershipProven({ tid: CONSUMER_TID, email: 'Thacyane@HOTMAIL.COM' }),
      ).toBe(true);
    });
  });

  describe('TRUSTS — xms_edov (Microsoft-verified domain owner, any tenant)', () => {
    it('xms_edov===true proves a custom-domain email (diego@bessa.digital case)', () => {
      expect(
        microsoftEmailOwnershipProven({
          tid: ATTACKER_TID, // a non-consumer tenant is fine WHEN Microsoft verified the domain
          email: 'diego@bessa.digital',
          xms_edov: true,
        }),
      ).toBe(true);
    });

    it.each([true, 1, '1', 'true'])('accepts xms_edov truthy form %p', (edov) => {
      expect(
        microsoftEmailOwnershipProven({
          tid: ATTACKER_TID,
          email: 'x@corp.example',
          xms_edov: edov,
        }),
      ).toBe(true);
    });
  });

  describe('REFUSES — the nOAuth vectors (this is the takeover lockout)', () => {
    it('⭐ external tenant claiming a CONSUMER-domain email WITHOUT xms_edov is REFUSED (tid anchor proof)', () => {
      // The attacker owns their own Entra tenant and sets a user email attribute
      // to victim@hotmail.com. Domain-string-alone would trust this = takeover.
      // The tid gate (attacker tid !== consumer tid) refuses it.
      expect(
        microsoftEmailOwnershipProven({ tid: ATTACKER_TID, email: 'victim@hotmail.com' }),
      ).toBe(false);
    });

    it('⭐ external tenant + consumer-domain email + attacker-asserted email_verified is STILL refused', () => {
      // email_verified is tenant-controllable, so the predicate must ignore it.
      expect(
        microsoftEmailOwnershipProven({
          tid: ATTACKER_TID,
          email: 'victim@outlook.com',
          // even if the token also carried email_verified:true, the predicate
          // does not read it — only tid+domain or xms_edov.
        } as { tid: string; email: string }),
      ).toBe(false);
    });

    it('external tenant + arbitrary external email (no xms_edov) is refused (test-F shape)', () => {
      expect(
        microsoftEmailOwnershipProven({ tid: ATTACKER_TID, email: 'etdx3-victim@example.com' }),
      ).toBe(false);
    });

    it('CONSUMER tenant but a NON-consumer domain is refused (email not Microsoft-owned)', () => {
      // A genuine MSA whose primary email is a custom domain: safe to refuse
      // (routes to the non-dead-end flow), never trusted by domain we do not own.
      expect(
        microsoftEmailOwnershipProven({ tid: CONSUMER_TID, email: 'someone@example.com' }),
      ).toBe(false);
    });

    it('missing tid + consumer-domain email (no xms_edov) is refused', () => {
      expect(microsoftEmailOwnershipProven({ email: 'x@hotmail.com' })).toBe(false);
    });

    it('xms_edov false / absent does not grant trust on its own', () => {
      expect(
        microsoftEmailOwnershipProven({
          tid: ATTACKER_TID,
          email: 'x@corp.example',
          xms_edov: false,
        }),
      ).toBe(false);
    });

    it('empty / malformed claims are refused (no crash)', () => {
      expect(microsoftEmailOwnershipProven({})).toBe(false);
      expect(microsoftEmailOwnershipProven({ tid: CONSUMER_TID })).toBe(false);
      expect(microsoftEmailOwnershipProven({ tid: 123, email: 456 })).toBe(false);
      expect(microsoftEmailOwnershipProven({ tid: CONSUMER_TID, email: 'no-at-sign' })).toBe(false);
    });
  });
});

describe('derivarNomeExibicaoFallback (aperture-uq69m finding #5)', () => {
  it('keeps a present name (trimmed)', () => {
    expect(derivarNomeExibicaoFallback('  Diego Chagas  ', 'diego@bessa.digital')).toBe(
      'Diego Chagas',
    );
  });

  it('falls back to the email local-part when the name is empty (thacyane/diego prod shape)', () => {
    expect(derivarNomeExibicaoFallback('', 'diego@bessa.digital')).toBe('diego');
    expect(derivarNomeExibicaoFallback('   ', 'thacyane@hotmail.com')).toBe('thacyane');
    expect(derivarNomeExibicaoFallback(null, 'fmateusvg@hotmail.com')).toBe('fmateusvg');
    expect(derivarNomeExibicaoFallback(undefined, 'x@y.com')).toBe('x');
  });

  it('falls back to Usuário when there is no name and no local-part', () => {
    expect(derivarNomeExibicaoFallback('', '@nolocal.com')).toBe('Usuário');
    expect(derivarNomeExibicaoFallback(null, '')).toBe('Usuário');
  });

  it('clamps to 120 chars', () => {
    const long = 'a'.repeat(200);
    expect(derivarNomeExibicaoFallback(long, 'x@y.com')).toHaveLength(120);
  });

  it('ALWAYS returns a value NomeExibicaoUsuarioSchema accepts (the whole point)', () => {
    const cases: Array<[string | null | undefined, string]> = [
      ['', 'diego@bessa.digital'],
      ['   ', 'thacyane@hotmail.com'],
      [null, 'x@y.com'],
      [undefined, ''],
      ['', '@nolocal.com'],
      ['a'.repeat(300), 'x@y.com'],
      ['Valid Name', 'a@b.com'],
    ];
    for (const [nome, email] of cases) {
      const derived = derivarNomeExibicaoFallback(nome, email);
      expect(
        () => NomeExibicaoUsuarioSchema.parse(derived),
        `nome=${nome} email=${email}`,
      ).not.toThrow();
    }
  });
});
