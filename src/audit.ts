import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const INKWELL_BIN = '/usr/local/bin/inkwell-emit';
const FALLBACK_DIR = path.join(os.homedir(), '.local', 'share', 'jules-mcp');
const FALLBACK_FILE = path.join(FALLBACK_DIR, 'audit.jsonl');

export interface AuditOptions {
    source: string;
    category: string;
    action: string;
    service: string;
    reason: string;
    target?: string;
    payload?: Record<string, unknown>;
}

function inkwellAvailable(): boolean {
    try {
        fs.accessSync(INKWELL_BIN, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function emitViaInkwell(opts: AuditOptions): Promise<void> {
    return new Promise((resolve) => {
        const args = [
            '--source',
            opts.source,
            '--category',
            opts.category,
            '--action',
            opts.action,
            '--service',
            opts.service,
            '--reason',
            opts.reason,
        ];

        if (opts.target) {
            args.push('--target', opts.target);
        }

        // Payload travels via stdin ('--payload -'), never argv: argv is
        // world-readable in /proc/PID/cmdline and payloads can carry
        // sensitive prompt text (B1-116). inkwell-emit supports the '-'
        // stdin convention.
        let stdinPayload: string | undefined;
        if (opts.payload) {
            args.push('--payload', '-');
            stdinPayload = JSON.stringify(opts.payload);
        }

        const child = execFile(
            INKWELL_BIN,
            args,
            { timeout: 5000 },
            (error) => {
                if (error) {
                    // Swallow — audit failures must never block mutations
                    console.error(
                        `[audit] inkwell-emit failed: ${error.message}`,
                    );
                }
                resolve();
            },
        );

        if (child.stdin) {
            if (stdinPayload !== undefined) {
                child.stdin.write(stdinPayload);
            }
            child.stdin.end();
        }
    });
}

function emitViaJsonl(opts: AuditOptions): void {
    try {
        fs.mkdirSync(FALLBACK_DIR, { recursive: true });
        const entry = {
            timestamp: new Date().toISOString(),
            ...opts,
        };
        fs.appendFileSync(FALLBACK_FILE, JSON.stringify(entry) + '\n');
    } catch (error) {
        // Swallow — audit failures must never block mutations
        console.error(
            `[audit] JSONL fallback failed: ${(error as Error).message}`,
        );
    }
}

export async function emitAudit(opts: AuditOptions): Promise<void> {
    if (inkwellAvailable()) {
        await emitViaInkwell(opts);
    } else {
        emitViaJsonl(opts);
    }
}
