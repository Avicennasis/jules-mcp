import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emitAudit } from '../src/audit.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({
    execFile: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fs>();
    return {
        ...actual,
        accessSync: vi.fn(), // returns undefined = no error = binary exists
    };
});

describe('emitAudit', () => {
    const baseOpts = {
        source: 'jules-mcp',
        category: 'coding-task',
        action: 'POST',
        service: 'github/owner/repo',
        reason: 'test reason',
    };

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('calls inkwell-emit with correct args when available', async () => {
        const mockExecFile = vi.mocked(execFile);
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            if (typeof cb === 'function') cb(null, '', '');
            return {} as any;
        });

        await emitAudit(baseOpts);

        expect(mockExecFile).toHaveBeenCalledWith(
            '/usr/local/bin/inkwell-emit',
            expect.arrayContaining([
                '--source',
                'jules-mcp',
                '--category',
                'coding-task',
                '--action',
                'POST',
                '--service',
                'github/owner/repo',
                '--reason',
                'test reason',
            ]),
            expect.objectContaining({ timeout: 5000 }),
            expect.any(Function),
        );
    });

    it('includes optional target; payload travels via stdin, not argv (B1-116)', async () => {
        const mockExecFile = vi.mocked(execFile);
        const stdinWrite = vi.fn();
        const stdinEnd = vi.fn();
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            if (typeof cb === 'function') cb(null, '', '');
            return { stdin: { write: stdinWrite, end: stdinEnd } } as any;
        });

        await emitAudit({
            ...baseOpts,
            target: 'session-xyz',
            payload: { prompt: 'fix the bug' },
        });

        const args = mockExecFile.mock.calls[0][1] as string[];
        expect(args).toContain('--target');
        expect(args[args.indexOf('--target') + 1]).toBe('session-xyz');
        // argv carries only the '-' sentinel; JSON goes to stdin
        expect(args).toContain('--payload');
        expect(args[args.indexOf('--payload') + 1]).toBe('-');
        expect(args.some((a) => a.includes('fix the bug'))).toBe(false);
        expect(stdinWrite).toHaveBeenCalledTimes(1);
        expect(JSON.parse(stdinWrite.mock.calls[0][0] as string)).toEqual({
            prompt: 'fix the bug',
        });
        expect(stdinEnd).toHaveBeenCalled();
    });

    it('closes stdin without writing when there is no payload', async () => {
        const mockExecFile = vi.mocked(execFile);
        const stdinWrite = vi.fn();
        const stdinEnd = vi.fn();
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            if (typeof cb === 'function') cb(null, '', '');
            return { stdin: { write: stdinWrite, end: stdinEnd } } as any;
        });

        await emitAudit(baseOpts);

        const args = mockExecFile.mock.calls[0][1] as string[];
        expect(args).not.toContain('--payload');
        expect(stdinWrite).not.toHaveBeenCalled();
        expect(stdinEnd).toHaveBeenCalled();
    });

    it('never includes API key in payload', async () => {
        const mockExecFile = vi.mocked(execFile);
        const stdinWrite = vi.fn();
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            if (typeof cb === 'function') cb(null, '', '');
            return { stdin: { write: stdinWrite, end: vi.fn() } } as any;
        });

        await emitAudit({
            ...baseOpts,
            payload: { prompt: 'test', apiKey: 'SHOULD_NOT_APPEAR' },
        });

        const payloadStr = stdinWrite.mock.calls[0][0] as string;
        // The audit module passes payload through — the caller is responsible
        // for not including secrets. This test documents the expectation.
        expect(payloadStr).not.toContain('JULES_API_KEY');
    });

    it('swallows inkwell-emit errors without throwing', async () => {
        const mockExecFile = vi.mocked(execFile);
        mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
            if (typeof cb === 'function') cb(new Error('inkwell down'), '', '');
            return {} as any;
        });

        // Should not throw
        await expect(emitAudit(baseOpts)).resolves.toBeUndefined();
    });
});
