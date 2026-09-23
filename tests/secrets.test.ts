import { describe, it, expect } from 'vitest';
import { findSecret, scanPrompt } from '../src/secrets.js';

describe('findSecret — pattern classes', () => {
    it('detects an AWS access key id', () => {
        expect(findSecret('key AKIAIOSFODNN7EXAMPLE here')?.patternClass).toBe(
            'aws-access-key-id',
        );
    });

    it('detects a GitHub token', () => {
        expect(findSecret(`token ghp_${'a'.repeat(36)}`)?.patternClass).toBe(
            'github-token',
        );
    });

    it('detects a fine-grained GitHub PAT', () => {
        expect(
            findSecret(`github_pat_${'A1b2'.repeat(15)}`)?.patternClass,
        ).toBe('github-pat');
    });

    it('detects a Google API key', () => {
        expect(findSecret(`AIza${'a'.repeat(35)}`)?.patternClass).toBe(
            'google-api-key',
        );
    });

    it('detects a Slack token', () => {
        expect(findSecret('xoxb-1234567890-abcdefgh')?.patternClass).toBe(
            'slack-token',
        );
    });

    it('detects a PEM private-key header', () => {
        expect(
            findSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')
                ?.patternClass,
        ).toBe('private-key');
    });

    it('detects a bearer token', () => {
        expect(
            findSecret('Authorization: Bearer abcdef0123456789ABCDEF')
                ?.patternClass,
        ).toBe('bearer-token');
    });

    it('detects a high-entropy assignment', () => {
        expect(
            findSecret('api_key = "aB3xY9kLmN2pQ7rS8tU0vW"')?.patternClass,
        ).toBe('high-entropy-assignment');
    });
});

describe('findSecret — false-positive corpus', () => {
    const benign = [
        'The token is refreshed nightly by the auth service.',
        'api_key: <your-key-here>',
        'password = correct horse battery staple',
        'secret: see-the-docs-for-this-value',
        'token=short',
        'api_key: placeholder-value-here',
        'The API key format is AIza followed by 35 characters.',
        'curl https://example.com/?token=abc',
        'Use the secret manager; never paste a password into a prompt.',
        'version: 1.2.3-alpha',
    ];
    for (const text of benign) {
        it(`does not flag: ${text}`, () => {
            expect(findSecret(text)).toBeNull();
        });
    }
});

describe('scanPrompt', () => {
    it('passes a clean prompt through unchanged', () => {
        const r = scanPrompt('Refactor the parser and add tests.', {
            allowSecret: false,
            reason: 'automation',
        });
        expect(r.allowed).toBe(true);
        expect(r.hit).toBeNull();
        expect(r.auditPrompt).toBe('Refactor the parser and add tests.');
    });

    it('blocks a prompt containing a credential and names the class only', () => {
        const secret = `ghp_${'a'.repeat(36)}`;
        const r = scanPrompt(`please use ${secret}`, {
            allowSecret: false,
            reason: 'automation',
        });
        expect(r.allowed).toBe(false);
        expect(r.error?.pattern_class).toBe('github-token');
        // The value must not appear in the message or the audit prompt.
        expect(r.error?.message).not.toContain(secret);
        expect(r.auditPrompt).not.toContain(secret);
    });

    it('overrides with allow_secret AND a reason', () => {
        const r = scanPrompt(`use AIza${'a'.repeat(35)}`, {
            allowSecret: true,
            reason: 'deliberate test fixture',
        });
        expect(r.allowed).toBe(true);
        expect(r.auditPrompt).toContain('[redacted');
        expect(r.auditPrompt).not.toContain('AIza');
    });

    it('rejects allow_secret with an empty reason', () => {
        const r = scanPrompt(`use AIza${'a'.repeat(35)}`, {
            allowSecret: true,
            reason: '   ',
        });
        expect(r.allowed).toBe(false);
        expect(r.error?.message).toContain('non-empty reason');
    });
});
