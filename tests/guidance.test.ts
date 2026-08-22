import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    DEFAULT_GUIDANCE,
    loadGuidance,
    applyGuidance,
} from '../src/guidance.js';

describe('DEFAULT_GUIDANCE', () => {
    // These assertions pin the substance, not the wording. They exist because
    // the guidance was written in response to a real incident (GrantLoft #310,
    // where an agent deleted the rationale for a race-condition mitigation
    // because a keyword-based detector called prose "commented-out code").
    it('distinguishes why-comments from what-comments', () => {
        expect(DEFAULT_GUIDANCE).toMatch(/\bWHY\b/);
        expect(DEFAULT_GUIDANCE).toMatch(/\bWHAT\b/);
    });

    it('tells the agent to decline a task whose premise is wrong', () => {
        expect(DEFAULT_GUIDANCE).toMatch(/decline/i);
    });

    it('names the commented-out-code false positive specifically', () => {
        expect(DEFAULT_GUIDANCE).toMatch(/commented-out code/i);
        expect(DEFAULT_GUIDANCE).toMatch(/false positive/i);
    });
});

describe('applyGuidance', () => {
    it('places the guidance ahead of the task prompt', () => {
        const out = applyGuidance('Refactor the invite form', DEFAULT_GUIDANCE);
        expect(out).toContain('Refactor the invite form');
        expect(out.indexOf('WHY')).toBeLessThan(
            out.indexOf('Refactor the invite form'),
        );
    });

    it('returns the prompt untouched when guidance is empty', () => {
        expect(applyGuidance('Just do the thing', '')).toBe('Just do the thing');
    });
});

describe('loadGuidance', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-guidance-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('falls back to the built-in default when no file exists', () => {
        expect(loadGuidance(dir)).toBe(DEFAULT_GUIDANCE);
    });

    it('prefers guidance.md from the config dir when present', () => {
        fs.writeFileSync(path.join(dir, 'guidance.md'), 'house rules go here');
        expect(loadGuidance(dir)).toBe('house rules go here');
    });

    it('falls back to the default when the file is empty or whitespace', () => {
        fs.writeFileSync(path.join(dir, 'guidance.md'), '   \n  \n');
        expect(loadGuidance(dir)).toBe(DEFAULT_GUIDANCE);
    });
});
