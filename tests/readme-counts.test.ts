/**
 * README count-drift guards (Redmine #50462).
 *
 * The README advertised "89 unit tests" in three places while the suite had
 * long since grown past it. The test count is the headline evidence for the
 * "Typed & tested" claim, so understating it is self-harm -- and a stale
 * number in the most-read file is a signal the other counts may lag too.
 *
 * What these assert, precisely: that the hand-maintained numbers in README
 * agree WITH EACH OTHER and with the tool count derived from source. That
 * catches the drift-apart half cheaply and in CI.
 *
 * What they deliberately do NOT assert: that the test number equals the live
 * suite total. A test cannot count its own suite without either recursing or
 * hardcoding the answer it is checking -- so this guard would be lying about
 * its own strength if it claimed to. Resyncing that number stays a release-time
 * step; see the ticket's third acceptance criterion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROMPT_CATALOG } from '../src/prompts/catalog.js';

const ROOT = join(import.meta.dirname, '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

describe('README counts', () => {
    it('states the same test count everywhere it is mentioned', () => {
        const counts = [
            ...README.matchAll(/([0-9]+)\s+unit tests/g),
            ...README.matchAll(/vitest run \(([0-9]+) tests\)/g),
        ].map((m) => Number(m[1]));

        // Guard the guard: if the phrasing changes and these regexes stop
        // matching, an empty set would pass vacuously.
        expect(counts.length).toBeGreaterThanOrEqual(3);
        expect(new Set(counts).size).toBe(1);
    });

    it('tool count matches the tools actually registered in src/tools/', () => {
        const toolsDir = join(ROOT, 'src', 'tools');
        const names = new Set<string>();
        for (const file of readdirSync(toolsDir)) {
            if (!file.endsWith('.ts')) continue;
            const src = readFileSync(join(toolsDir, file), 'utf8');
            for (const m of src.matchAll(/'(jules_[a-z_]+)'/g)) {
                names.add(m[1]);
            }
        }
        expect(names.size).toBeGreaterThan(0);

        const claimed = [...README.matchAll(/\*\*([0-9]+) tools\*\*/g)].map(
            (m) => Number(m[1]),
        );
        expect(claimed.length).toBeGreaterThanOrEqual(1);
        for (const c of claimed) {
            expect(c).toBe(names.size);
        }
    });

    it('prompt count matches the catalog actually registered', () => {
        const claimed = [...README.matchAll(/\*\*([0-9]+) prompts\*\*/g)].map(
            (m) => Number(m[1]),
        );
        expect(claimed.length).toBeGreaterThanOrEqual(1);
        for (const c of claimed) {
            expect(c).toBe(PROMPT_CATALOG.length);
        }
    });

    it('documents every prompt in the catalog by name', () => {
        for (const template of PROMPT_CATALOG) {
            expect(README).toContain(template.name);
        }
    });

    it('counts no prompt as a tool', () => {
        // The tool count above scans src/tools/ for 'jules_*' literals. Prompts
        // live in src/prompts/ and are named in kebab-case, so neither
        // direction of that count can pick them up -- assert it rather than
        // trusting the directory split to survive a future move.
        const toolsDir = join(ROOT, 'src', 'tools');
        const toolSources = readdirSync(toolsDir)
            .filter((f) => f.endsWith('.ts'))
            .map((f) => readFileSync(join(toolsDir, f), 'utf8'))
            .join('\n');
        for (const template of PROMPT_CATALOG) {
            expect(toolSources).not.toContain(template.name);
            expect(template.name).not.toMatch(/^jules_/);
        }
    });
});
