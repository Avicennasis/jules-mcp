import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ScheduleStore } from '../src/scheduler/persistence.js';
import { ScheduleManager } from '../src/scheduler/cron.js';
import type { ScheduleEntry } from '../src/types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

// Wrap renameSync so the atomic-write failure path can be driven. Everything
// else passes through to the real fs, so the rest of this file is unaffected.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

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

// #50437 -- schedule-store hardening: atomic writes, a backup of an unreadable
// file, and a per-file key-derivation salt.
describe('ScheduleStore hardening (#50437)', () => {
    const PASS = 'test-encryption-key-32chars!!!!!';
    const ENTRY: ScheduleEntry = {
        id: 'sched-h',
        label: 'Hardened',
        cron: '0 9 * * 1',
        prompt: 'p',
        source: 'sources/github/o/r',
        startingBranch: 'main',
        requirePlanApproval: true,
        createdAt: '2026-01-01T00:00:00Z',
    };
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-hard-'));
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('a failed write leaves the previous file intact (atomic rename)', () => {
        const store = new ScheduleStore(PASS, tmpDir);
        store.add(ENTRY);

        // Simulate a write that dies before the rename lands.
        vi.mocked(fs.renameSync).mockImplementationOnce(() => {
            throw new Error('simulated interruption');
        });
        expect(() =>
            store.add({ ...ENTRY, id: 'sched-h2', label: 'Second' }),
        ).toThrow('simulated interruption');

        // The original file is unchanged, and no temp file is left behind.
        const reread = new ScheduleStore(PASS, tmpDir);
        expect(reread.list()).toHaveLength(1);
        expect(reread.list()[0].id).toBe('sched-h');
        expect(fs.readdirSync(tmpDir).some((f) => f.includes('.tmp-'))).toBe(
            false,
        );
    });

    it('backs up an unreadable file, surfaces an error, and starts empty', () => {
        const filePath = path.join(tmpDir, 'schedules.enc');
        fs.writeFileSync(filePath, 'not-a-valid-envelope');

        const store = new ScheduleStore(PASS, tmpDir);
        // Construction must not throw -- a corrupt file must not brick startup.
        expect(store.list()).toEqual([]);
        expect(store.lastLoadError).toMatch(/preserved a copy/);

        const backup = fs
            .readdirSync(tmpDir)
            .find((f) => f.startsWith('schedules.enc.corrupt-'));
        expect(backup).toBeDefined();
        // The backup holds the ORIGINAL bytes, not something rewritten.
        expect(fs.readFileSync(path.join(tmpDir, backup!), 'utf-8')).toBe(
            'not-a-valid-envelope',
        );

        // A subsequent write recovers cleanly and is readable again.
        store.add(ENTRY);
        const reread = new ScheduleStore(PASS, tmpDir);
        expect(reread.list()).toHaveLength(1);
    });

    it('names both wrong-key and corruption when decryption fails', () => {
        const store = new ScheduleStore(PASS, tmpDir);
        store.add(ENTRY);

        const other = new ScheduleStore(
            'a-different-passphrase-32chars!!!!',
            tmpDir,
        );
        expect(other.lastLoadError).toMatch(/wrong encryption key/);
        expect(other.lastLoadError).toMatch(/corrupted/);
    });

    it('uses a per-file salt, so two stores never share one', () => {
        const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-salt-a-'));
        const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'jules-salt-b-'));
        try {
            new ScheduleStore(PASS, dirA).add(ENTRY);
            new ScheduleStore(PASS, dirB).add(ENTRY);
            const readSalt = (dir: string) => {
                const raw = fs.readFileSync(
                    path.join(dir, 'schedules.enc'),
                    'utf-8',
                );
                expect(raw.startsWith('v2:')).toBe(true);
                return raw.split(':')[1];
            };
            expect(readSalt(dirA)).not.toBe(readSalt(dirB));
        } finally {
            fs.rmSync(dirA, { recursive: true, force: true });
            fs.rmSync(dirB, { recursive: true, force: true });
        }
    });

    it('still decrypts a legacy v1 file (fixed salt), then upgrades it', () => {
        const key = crypto.scryptSync(PASS, 'jules-mcp-salt', 32);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let ct = cipher.update(JSON.stringify([ENTRY]), 'utf-8', 'hex');
        ct += cipher.final('hex');
        const legacy = `${iv.toString('hex')}:${cipher
            .getAuthTag()
            .toString('hex')}:${ct}`;
        fs.writeFileSync(path.join(tmpDir, 'schedules.enc'), legacy);

        const store = new ScheduleStore(PASS, tmpDir);
        expect(store.lastLoadError).toBeNull();
        expect(store.list()).toHaveLength(1);

        // The next write upgrades the envelope to v2.
        store.add({ ...ENTRY, id: 'sched-h3' });
        const raw = fs.readFileSync(
            path.join(tmpDir, 'schedules.enc'),
            'utf-8',
        );
        expect(raw.startsWith('v2:')).toBe(true);
        expect(new ScheduleStore(PASS, tmpDir).list()).toHaveLength(2);
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
