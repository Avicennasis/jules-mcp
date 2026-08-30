/**
 * serverInfo.version drift guard (Redmine #50713).
 *
 * The version reported in the MCP `initialize` response was a literal in
 * src/index.ts. It sat at 0.4.0 while package.json moved to 0.7.0 -- three
 * releases of clients being told a wrong number that looked authoritative.
 *
 * The obvious test for this -- "VERSION equals package.json's version" -- is
 * ALMOST WORTHLESS on its own, because VERSION is read from that same file:
 * the two can never disagree, so the assertion can never go red. It is kept
 * below as the literal acceptance criterion, but the guard that actually has
 * teeth is `reads the version out of a real file`, which points the reader at
 * a fixture package.json and demands the fixture's value back. Replace the
 * body of readPackageVersion with `return '0.7.0'` and that one fails while
 * the agreement test still passes -- which is the whole difference.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPackageVersion, VERSION } from '../src/version.js';

const ROOT = join(import.meta.dirname, '..');

/** Build a throwaway package root and return the URL of a module inside it. */
function fixture(pkg: unknown): URL {
    const root = mkdtempSync(join(tmpdir(), 'jules-mcp-version-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg), 'utf8');
    const dist = join(root, 'dist');
    mkdirSync(dist);
    return pathToFileURL(join(dist, 'version.js'));
}

describe('serverInfo version', () => {
    it('reads the version out of a real file, not a literal', () => {
        // The discriminating case: a version string that appears nowhere in
        // this repo. Only an implementation that genuinely opens and parses
        // package.json can return it.
        const sentinel = '9.8.7-fixture';
        expect(
            readPackageVersion(fixture({ name: 'x', version: sentinel })),
        ).toBe(sentinel);

        // Twice, with a different value, so a cached first read cannot pass.
        expect(
            readPackageVersion(fixture({ name: 'x', version: '1.2.3-other' })),
        ).toBe('1.2.3-other');
    });

    it('refuses to invent a version when package.json has none', () => {
        expect(() => readPackageVersion(fixture({ name: 'x' }))).toThrow(
            /no usable "version"/,
        );
        expect(() =>
            readPackageVersion(fixture({ name: 'x', version: '' })),
        ).toThrow(/no usable "version"/);
        expect(() =>
            readPackageVersion(fixture({ name: 'x', version: 7 })),
        ).toThrow(/no usable "version"/);
    });

    it('agrees with package.json', () => {
        const pkg = JSON.parse(
            readFileSync(join(ROOT, 'package.json'), 'utf8'),
        );
        expect(pkg.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
        expect(VERSION).toBe(pkg.version);
    });

    it('is the value index.ts hands to McpServer, with no literal beside it', () => {
        // Closes the gap between "the module is correct" and "the server uses
        // it". A source-level assertion, not a live handshake: it cannot prove
        // the built server reports VERSION, only that nothing re-hardcodes the
        // number on its way there. That is the failure #50713 was.
        const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8');

        expect(index).toMatch(/version:\s*VERSION\b/);
        expect(index).toMatch(/from '\.\/version\.js'/);

        // Guard the guard: strip comments first, so the ticket's own narration
        // about the old 0.4.0 literal cannot trip this.
        const code = index
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(code).not.toMatch(/version:\s*['"`]/);
    });
});
