import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScheduleStore } from '../src/scheduler/persistence.js';
import { ScheduleManager } from '../src/scheduler/cron.js';
import type { ScheduleEntry } from '../src/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('ScheduleStore', () => {
    let tmpDir: string;
    let store: ScheduleStore;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-test-'));
        store = new ScheduleStore('test-encryption-key-32chars!!!!!', tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('starts with an empty list', () => {
        expect(store.list()).toEqual([]);
    });

    it('persists and loads entries', () => {
        const entry: ScheduleEntry = {
            id: 'sched-1',
            label: 'Weekly lint',
            cron: '0 9 * * 1',
            prompt: 'Run linting',
            source: 'sources/github/o/r',
            startingBranch: 'main',
            requirePlanApproval: true,
            createdAt: '2026-01-01T00:00:00Z',
        };
        store.add(entry);
        expect(store.list()).toHaveLength(1);

        // Create a new store reading from the same directory
        const store2 = new ScheduleStore(
            'test-encryption-key-32chars!!!!!',
            tmpDir,
        );
        expect(store2.list()).toHaveLength(1);
        expect(store2.list()[0].label).toBe('Weekly lint');
    });

    it('data on disk is encrypted (not plaintext)', () => {
        store.add({
            id: 'sched-2',
            label: 'Secret task',
            cron: '0 0 * * *',
            prompt: 'secret prompt text',
            source: 'sources/github/o/r',
            startingBranch: 'main',
            requirePlanApproval: true,
            createdAt: '2026-01-01T00:00:00Z',
        });
        const files = fs.readdirSync(tmpDir);
        const dataFile = files.find((f) => f.endsWith('.enc'));
        expect(dataFile).toBeDefined();
        const raw = fs.readFileSync(path.join(tmpDir, dataFile!), 'utf-8');
        expect(raw).not.toContain('secret prompt text');
    });

    it('removes entries by ID', () => {
        store.add({
            id: 'sched-3',
            label: 'To remove',
            cron: '0 0 * * *',
            prompt: 'p',
            source: 's',
            startingBranch: 'main',
            requirePlanApproval: true,
            createdAt: '2026-01-01T00:00:00Z',
        });
        expect(store.remove('sched-3')).toBe(true);
        expect(store.list()).toHaveLength(0);
        expect(store.remove('nonexistent')).toBe(false);
    });
});

describe('ScheduleManager', () => {
    it('adds a schedule and assigns an ID', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-test-'));
        const store = new ScheduleStore(
            'test-encryption-key-32chars!!!!!',
            tmpDir,
        );
        const mockClient = {} as any;
        const manager = new ScheduleManager(store, mockClient);

        const entry = manager.add({
            label: 'Daily check',
            cron: '0 8 * * *',
            prompt: 'check tests',
            source: 'sources/github/o/r',
            startingBranch: 'main',
            requirePlanApproval: true,
        });

        expect(entry.id).toBeDefined();
        expect(entry.id.length).toBeGreaterThan(0);
        expect(entry.createdAt).toBeDefined();
        expect(manager.list()).toHaveLength(1);

        manager.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe('ScheduleStore key file permissions (B1-117)', () => {
    it('re-tightens a loosened .key file to 0600 on load', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-test-'));
        try {
            // First construction auto-generates the key
            new ScheduleStore(undefined, tmpDir);
            const keyPath = path.join(tmpDir, '.key');
            expect(fs.existsSync(keyPath)).toBe(true);

            // Loosen it, then construct again — permissions must re-tighten
            fs.chmodSync(keyPath, 0o644);
            new ScheduleStore(undefined, tmpDir);
            const mode = fs.statSync(keyPath).mode & 0o777;
            expect(mode).toBe(0o600);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('auto-generated .key is created with 0600', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-test-'));
        try {
            new ScheduleStore(undefined, tmpDir);
            const mode = fs.statSync(path.join(tmpDir, '.key')).mode & 0o777;
            expect(mode).toBe(0o600);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
