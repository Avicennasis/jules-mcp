import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ScheduleEntry } from '../types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.local', 'share', 'jules-mcp');
const DATA_FILE = 'schedules.enc';
const ALGORITHM = 'aes-256-gcm';

// On-disk envelope version. v1 (implicit) was `iv:authTag:ciphertext` with the
// key derived from a FIXED string salt; v2 prefixes a per-file random salt so
// two stores sharing a passphrase no longer derive the same key. v1 files still
// decrypt (see decrypt()); the next write upgrades them.
const FORMAT_V2 = 'v2';
const LEGACY_SALT = 'jules-mcp-salt';

export class ScheduleStore {
    private readonly dir: string;
    private readonly filePath: string;
    private readonly passphrase: string | null;
    private readonly staticKey: Buffer | null;
    private entries: ScheduleEntry[] = [];
    private salt: Buffer | null = null;
    private loadError: string | null = null;

    constructor(encryptionKey?: string, dir?: string) {
        this.dir = dir ?? DEFAULT_DIR;
        this.filePath = path.join(this.dir, DATA_FILE);

        if (encryptionKey) {
            // Derive a 32-byte key from the provided passphrase. The SALT is
            // per-file (see keyFor/encrypt) rather than the fixed
            // 'jules-mcp-salt' v1 used, so a leaked file cannot be attacked
            // with a rainbow table shared across every install (#50437).
            this.passphrase = encryptionKey;
            this.staticKey = null;
        } else {
            this.passphrase = null;
            // Auto-generate and persist a 32-byte key if none provided. The
            // key is raw entropy, not a passphrase, so key derivation does not
            // depend on the salt -- the salt is still written for format
            // uniformity.
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            const keyPath = path.join(this.dir, '.key');
            if (fs.existsSync(keyPath)) {
                // Re-tighten permissions on every load in case the file was
                // created by an older version or loosened externally (B1-117).
                try {
                    fs.chmodSync(keyPath, 0o600);
                } catch {
                    // Best-effort -- reading still works; the key file's
                    // exposure model is documented in README (Security).
                }
                this.staticKey = Buffer.from(
                    fs.readFileSync(keyPath, 'utf-8').trim(),
                    'hex',
                );
            } else {
                const generated = crypto.randomBytes(32);
                fs.writeFileSync(keyPath, generated.toString('hex'), {
                    mode: 0o600,
                });
                this.staticKey = generated;
            }
        }

        this.loadFromDisk();
    }

    /** A message describing the last unreadable schedule file, or null. */
    get lastLoadError(): string | null {
        return this.loadError;
    }

    /**
     * Derive the 32-byte key for a given salt. `salt` is used verbatim as the
     * scrypt salt: a per-file hex string for v2, the legacy constant for v1.
     * A generated raw key ignores it.
     */
    private keyFor(salt: string): Buffer | null {
        if (this.staticKey) return this.staticKey;
        if (this.passphrase)
            return crypto.scryptSync(this.passphrase, salt, 32);
        return null;
    }

    private encrypt(data: string): string {
        const salt = this.salt ?? (this.salt = crypto.randomBytes(16));
        const key = this.keyFor(salt.toString('hex'));
        // No key material -> plaintext (defensive; the constructor always sets
        // one of passphrase/staticKey).
        if (!key) return data;
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        let encrypted = cipher.update(data, 'utf-8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${FORMAT_V2}:${salt.toString('hex')}:${iv.toString('hex')}:${authTag}:${encrypted}`;
    }

    private decrypt(data: string): string {
        if (!this.passphrase && !this.staticKey) return data;

        const parts = data.split(':');
        let salt: string;
        let ivHex: string;
        let authTagHex: string;
        let encrypted: string;
        if (parts[0] === FORMAT_V2) {
            [, salt, ivHex, authTagHex] = parts;
            encrypted = parts.slice(4).join(':');
        } else {
            // v1: iv:authTag:ciphertext, key derived with the fixed salt.
            salt = LEGACY_SALT;
            [ivHex, authTagHex] = parts;
            encrypted = parts.slice(2).join(':');
        }

        const key = this.keyFor(salt);
        if (!key) return data;

        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);
        let decrypted: string;
        try {
            decrypted = decipher.update(encrypted, 'hex', 'utf-8');
            decrypted += decipher.final('utf-8');
        } catch {
            // GCM makes a wrong key and a tampered/truncated ciphertext
            // indistinguishable at this point -- both fail the auth tag. Name
            // both possibilities rather than one (#50437).
            throw new Error(
                'decryption failed: wrong encryption key, or the schedule file is corrupted',
            );
        }
        // Remember the salt so a rewrite reuses it (v2). A v1 file leaves this
        // null, so the next write mints a fresh per-file salt and upgrades it.
        if (parts[0] === FORMAT_V2) this.salt = Buffer.from(salt, 'hex');
        return decrypted;
    }

    private loadFromDisk(): void {
        if (!fs.existsSync(this.filePath)) return;
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const decrypted = this.decrypt(raw);
            this.entries = JSON.parse(decrypted);
        } catch (err) {
            this.handleUnreadable(err);
        }
    }

    /**
     * Preserve an unreadable schedule file before anything can overwrite it,
     * then start empty. Silently starting empty is how a truncated file loses
     * every schedule with no trace (#50437).
     */
    private handleUnreadable(err: unknown): void {
        this.entries = [];
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backup = `${this.filePath}.corrupt-${stamp}`;
        const detail = err instanceof Error ? err.message : String(err);
        try {
            fs.copyFileSync(this.filePath, backup);
            this.loadError =
                `could not read ${this.filePath} (${detail}); preserved a copy at ` +
                `${backup} and started with an empty schedule list`;
        } catch (copyErr) {
            const copyDetail =
                copyErr instanceof Error ? copyErr.message : String(copyErr);
            this.loadError =
                `could not read ${this.filePath} (${detail}) and could not back it up ` +
                `(${copyDetail}); started with an empty schedule list`;
        }
        console.error(`ScheduleStore: ${this.loadError}`);
    }

    private saveToDisk(): void {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const data = JSON.stringify(this.entries);
        const payload = this.encrypt(data);

        // Stage to a temp file and rename(2) over the target: a write that dies
        // partway leaves the previous file intact rather than truncating the
        // only copy of every schedule. Never redirect into the live file.
        const tmp = `${this.filePath}.tmp-${process.pid}-${crypto
            .randomBytes(6)
            .toString('hex')}`;
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
            fs.writeFileSync(fd, payload);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        try {
            fs.renameSync(tmp, this.filePath);
        } catch (err) {
            try {
                fs.unlinkSync(tmp);
            } catch {
                // The rename already failed; failing to clean the temp file is
                // not worth masking the original error.
            }
            throw err;
        }
        // fsync the directory so the rename itself is durable.
        try {
            const dfd = fs.openSync(this.dir, 'r');
            fs.fsyncSync(dfd);
            fs.closeSync(dfd);
        } catch {
            // Not every filesystem supports fsync on a directory.
        }
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
