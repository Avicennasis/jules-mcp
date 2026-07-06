import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ScheduleEntry } from '../types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.local', 'share', 'jules-mcp');
const DATA_FILE = 'schedules.enc';
const ALGORITHM = 'aes-256-gcm';

export class ScheduleStore {
    private readonly dir: string;
    private readonly filePath: string;
    private readonly key: Buffer | null;
    private entries: ScheduleEntry[] = [];

    constructor(encryptionKey?: string, dir?: string) {
        this.dir = dir ?? DEFAULT_DIR;
        this.filePath = path.join(this.dir, DATA_FILE);

        if (encryptionKey) {
            // Derive a 32-byte key from the provided string
            this.key = crypto.scryptSync(encryptionKey, 'jules-mcp-salt', 32);
        } else {
            // Auto-generate and persist a key if none provided
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            const keyPath = path.join(this.dir, '.key');
            if (fs.existsSync(keyPath)) {
                // Re-tighten permissions on every load in case the file was
                // created by an older version or loosened externally (B1-117).
                try {
                    fs.chmodSync(keyPath, 0o600);
                } catch {
                    // Best-effort — reading still works; the key file's
                    // exposure model is documented in README (Security).
                }
                this.key = Buffer.from(
                    fs.readFileSync(keyPath, 'utf-8').trim(),
                    'hex',
                );
            } else {
                const generated = crypto.randomBytes(32);
                fs.writeFileSync(keyPath, generated.toString('hex'), {
                    mode: 0o600,
                });
                this.key = generated;
            }
        }

        this.loadFromDisk();
    }

    private encrypt(data: string): string {
        if (!this.key) return data;
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
        let encrypted = cipher.update(data, 'utf-8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    }

    private decrypt(data: string): string {
        if (!this.key) return data;
        const [ivHex, authTagHex, encrypted] = data.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
        decrypted += decipher.final('utf-8');
        return decrypted;
    }

    private loadFromDisk(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                const decrypted = this.decrypt(raw);
                this.entries = JSON.parse(decrypted);
            }
        } catch {
            this.entries = [];
        }
    }

    private saveToDisk(): void {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const data = JSON.stringify(this.entries);
        const encrypted = this.encrypt(data);
        fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    }

    list(): ScheduleEntry[] {
        return [...this.entries];
    }

    add(entry: ScheduleEntry): void {
        this.entries.push(entry);
        this.saveToDisk();
    }

    remove(id: string): boolean {
        const before = this.entries.length;
        this.entries = this.entries.filter((e) => e.id !== id);
        if (this.entries.length < before) {
            this.saveToDisk();
            return true;
        }
        return false;
    }

    save(entries: ScheduleEntry[]): void {
        this.entries = entries;
        this.saveToDisk();
    }

    load(): ScheduleEntry[] {
        this.loadFromDisk();
        return this.list();
    }
}
