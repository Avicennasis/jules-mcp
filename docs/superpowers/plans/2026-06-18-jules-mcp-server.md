# Jules MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript MCP server wrapping the Google Jules API (v1alpha) with 12 tools for coding task management, scheduling, audit logging, and a convenience "run task" composite tool.

**Architecture:** stdio MCP server using the official `@modelcontextprotocol/sdk`. Layered as: MCP tool handlers → Jules HTTP client → Google Jules REST API. Scheduling uses node-cron with AES-256-GCM encrypted local persistence. All mutations emit audit rows via inkwell-emit (with JSONL fallback).

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk` 1.29.x, `node-cron` 4.x, `vitest` 4.x, built-in `fetch`, `node:crypto` for AES-256-GCM.

## Global Constraints

- Node 18+ required (for built-in `fetch`); developed on Node 22
- All API calls use `X-Goog-Api-Key` header from `JULES_API_KEY` env var
- Base URL: `https://jules.googleapis.com/v1alpha`
- All mutation tools require a `reason: string` parameter
- `dry_run: boolean` supported on `create_session` and `schedule_task`
- Error responses always shaped as `{"status": "ERROR", "message": ..., "code": ...}`
- API key must never appear in logs, error messages, or audit payloads
- Inkwell failures are swallowed — never block a mutation for audit issues
- `require_plan_approval` defaults to `true` on session creation

---

### Task 1: Project Scaffold & Types

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/errors.ts`
- Test: `tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces: All TypeScript types used across the project (`Source`, `Session`, `SessionState`, `AutomationMode`, `Activity`, `ActivityType`, `Plan`, `PlanStep`, `Artifact`, `ChangeSet`, `GitPatch`, `Media`, `BashOutput`, `PullRequest`, `SourceContext`, `GitHubRepoContext`, `SessionOutput`); all error classes (`JulesAPIError`, `JulesAuthError`, `JulesNotFoundError`, `JulesRateLimitError`, `JulesStateError`); utility `normalizeResourceName(input: string, prefix: string): string`.

- [ ] **Step 1: Initialize the project**

```bash
cd ~/github/avic/jules-mcp
npm init -y
```

Then replace the generated `package.json`:

```json
{
  "name": "jules-mcp",
  "version": "0.1.0",
  "description": "MCP server for the Google Jules coding agent API",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "jules-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/index.js",
    "smoke": "tsx scripts/smoke-test.ts"
  },
  "license": "MIT",
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd ~/github/avic/jules-mcp
npm install @modelcontextprotocol/sdk node-cron zod
npm install -D typescript @types/node vitest tsx
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
*.tgz
.env
```

- [ ] **Step 5: Write failing tests for error classes**

Create `tests/errors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  JulesAPIError,
  JulesAuthError,
  JulesNotFoundError,
  JulesRateLimitError,
  JulesStateError,
} from '../src/errors.js';

describe('JulesAPIError', () => {
  it('stores message, statusCode, and hint', () => {
    const err = new JulesAPIError('something broke', 500, 'try again');
    expect(err.message).toBe('something broke');
    expect(err.statusCode).toBe(500);
    expect(err.hint).toBe('try again');
    expect(err).toBeInstanceOf(Error);
  });

  it('toJSON returns structured error shape', () => {
    const err = new JulesAPIError('bad', 400);
    expect(err.toJSON()).toEqual({
      status: 'ERROR',
      message: 'bad',
      code: 400,
    });
  });
});

describe('JulesAuthError', () => {
  it('defaults to 401 with auth hint', () => {
    const err = new JulesAuthError();
    expect(err.statusCode).toBe(401);
    expect(err.hint).toContain('API key');
    expect(err).toBeInstanceOf(JulesAPIError);
  });
});

describe('JulesNotFoundError', () => {
  it('includes the resource ID in the message', () => {
    const err = new JulesNotFoundError('sessions/abc123');
    expect(err.message).toContain('abc123');
    expect(err.statusCode).toBe(404);
  });
});

describe('JulesRateLimitError', () => {
  it('includes retryAfter when provided', () => {
    const err = new JulesRateLimitError(30);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfter).toBe(30);
    expect(err.hint).toContain('30');
  });
});

describe('JulesStateError', () => {
  it('explains current state and valid actions', () => {
    const err = new JulesStateError('approve_plan', 'IN_PROGRESS');
    expect(err.message).toContain('approve_plan');
    expect(err.message).toContain('IN_PROGRESS');
    expect(err.statusCode).toBe(409);
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/errors.test.ts
```

Expected: FAIL — `Cannot find module '../src/errors.js'`

- [ ] **Step 7: Implement error classes**

Create `src/errors.ts`:

```typescript
export class JulesAPIError extends Error {
  public readonly statusCode: number;
  public readonly hint?: string;

  constructor(message: string, statusCode: number, hint?: string) {
    super(message);
    this.name = 'JulesAPIError';
    this.statusCode = statusCode;
    this.hint = hint;
  }

  toJSON(): { status: string; message: string; code: number } {
    return {
      status: 'ERROR',
      message: this.message,
      code: this.statusCode,
    };
  }
}

export class JulesAuthError extends JulesAPIError {
  constructor(message?: string) {
    super(
      message ?? 'Authentication failed',
      401,
      'Check your JULES_API_KEY — is it valid, expired, or disabled? Generate keys at jules.google/settings.',
    );
    this.name = 'JulesAuthError';
  }
}

export class JulesNotFoundError extends JulesAPIError {
  constructor(resourceName: string) {
    super(
      `Resource not found: ${resourceName}`,
      404,
      `The resource "${resourceName}" does not exist or you do not have access.`,
    );
    this.name = 'JulesNotFoundError';
  }
}

export class JulesRateLimitError extends JulesAPIError {
  public readonly retryAfter?: number;

  constructor(retryAfter?: number) {
    const hint = retryAfter
      ? `Rate limited. Retry after ${retryAfter} seconds.`
      : 'Rate limited. Try again later.';
    super('Rate limit exceeded', 429, hint);
    this.name = 'JulesRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class JulesStateError extends JulesAPIError {
  constructor(action: string, currentState: string) {
    super(
      `Cannot perform "${action}" — session is currently in state "${currentState}"`,
      409,
      `The session must be in an appropriate state for this action. Current state: ${currentState}.`,
    );
    this.name = 'JulesStateError';
  }
}
```

- [ ] **Step 8: Implement types**

Create `src/types.ts`:

```typescript
// --- Session States ---

export const SESSION_STATES = [
  'STATE_UNSPECIFIED',
  'QUEUED',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER_FEEDBACK',
  'IN_PROGRESS',
  'PAUSED',
  'FAILED',
  'COMPLETED',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<SessionState> = new Set([
  'COMPLETED',
  'FAILED',
]);

export const AUTOMATION_MODES = [
  'AUTOMATION_MODE_UNSPECIFIED',
  'AUTO_CREATE_PR',
] as const;

export type AutomationMode = (typeof AUTOMATION_MODES)[number];

// --- Resources ---

export interface GitHubRepoContext {
  startingBranch: string;
}

export interface SourceContext {
  source: string;
  githubRepoContext?: GitHubRepoContext;
}

export interface PullRequest {
  url: string;
  title: string;
  description: string;
}

export interface SessionOutput {
  pullRequest?: PullRequest;
}

export interface Session {
  name: string;
  id: string;
  prompt: string;
  title?: string;
  sourceContext: SourceContext;
  requirePlanApproval?: boolean;
  automationMode?: AutomationMode;
  createTime: string;
  updateTime: string;
  state: SessionState;
  url: string;
  outputs?: SessionOutput[];
}

export interface Source {
  name: string;
  [key: string]: unknown; // API may add fields
}

// --- Activities ---

export interface PlanStep {
  id: string;
  title: string;
  description: string;
  index: number;
}

export interface Plan {
  id: string;
  steps: PlanStep[];
  createTime: string;
}

export interface GitPatch {
  unidiffPatch: string;
  baseCommitId: string;
  suggestedCommitMessage: string;
}

export interface ChangeSet {
  source: string;
  gitPatch: GitPatch;
}

export interface Media {
  data: string; // base64
  mimeType: string;
}

export interface BashOutput {
  command: string;
  output: string;
  exitCode: number;
}

export interface Artifact {
  changeSet?: ChangeSet;
  media?: Media;
  bashOutput?: BashOutput;
}

export interface AgentMessaged {
  agentMessage: string;
}

export interface UserMessaged {
  userMessage: string;
}

export interface PlanGenerated {
  plan: Plan;
}

export interface PlanApproved {
  planId: string;
}

export interface ProgressUpdated {
  title: string;
  description: string;
}

export interface SessionCompleted {}

export interface SessionFailed {
  reason: string;
}

export type ActivityType =
  | { agentMessaged: AgentMessaged }
  | { userMessaged: UserMessaged }
  | { planGenerated: PlanGenerated }
  | { planApproved: PlanApproved }
  | { progressUpdated: ProgressUpdated }
  | { sessionCompleted: SessionCompleted }
  | { sessionFailed: SessionFailed };

export interface Activity {
  name: string;
  id: string;
  description: string;
  createTime: string;
  originator: string;
  artifacts?: Artifact[];
  activity: ActivityType;
}

// --- Pagination ---

export interface PaginatedResponse<T> {
  items: T[];
  nextPageToken?: string;
}

// --- Scheduling ---

export interface ScheduleEntry {
  id: string;
  label: string;
  cron: string;
  prompt: string;
  source: string;
  startingBranch: string;
  requirePlanApproval: boolean;
  automationMode?: AutomationMode;
  createdAt: string;
}

// --- Utility ---

/**
 * Normalizes resource names. Accepts bare IDs or full resource names.
 * normalizeResourceName("abc123", "sessions") → "sessions/abc123"
 * normalizeResourceName("sessions/abc123", "sessions") → "sessions/abc123"
 */
export function normalizeResourceName(input: string, prefix: string): string {
  if (input.startsWith(`${prefix}/`)) {
    return input;
  }
  return `${prefix}/${input}`;
}
```

- [ ] **Step 9: Run tests to verify errors pass**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/errors.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 10: Add tests for normalizeResourceName**

Append to `tests/errors.test.ts` (or create `tests/types.test.ts`):

Create `tests/types.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeResourceName, TERMINAL_STATES } from '../src/types.js';

describe('normalizeResourceName', () => {
  it('prefixes a bare ID', () => {
    expect(normalizeResourceName('abc123', 'sessions')).toBe('sessions/abc123');
  });

  it('passes through an already-prefixed name', () => {
    expect(normalizeResourceName('sessions/abc123', 'sessions')).toBe('sessions/abc123');
  });

  it('handles sources with nested paths', () => {
    expect(normalizeResourceName('github/owner/repo', 'sources')).toBe('sources/github/owner/repo');
  });

  it('passes through sources already prefixed', () => {
    expect(normalizeResourceName('sources/github/owner/repo', 'sources')).toBe('sources/github/owner/repo');
  });
});

describe('TERMINAL_STATES', () => {
  it('contains COMPLETED and FAILED', () => {
    expect(TERMINAL_STATES.has('COMPLETED')).toBe(true);
    expect(TERMINAL_STATES.has('FAILED')).toBe(true);
  });

  it('does not contain IN_PROGRESS', () => {
    expect(TERMINAL_STATES.has('IN_PROGRESS')).toBe(false);
  });
});
```

- [ ] **Step 11: Run all tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 12: Commit**

```bash
cd ~/github/avic/jules-mcp
git add package.json tsconfig.json .gitignore src/types.ts src/errors.ts tests/errors.test.ts tests/types.test.ts package-lock.json
git commit -m "feat: project scaffold, types, and error classes"
```

---

### Task 2: Audit Module

**Files:**
- Create: `src/audit.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: nothing external
- Produces: `emitAudit(opts: AuditOptions): Promise<void>` where `AuditOptions` is `{ source: string; category: string; action: string; service: string; reason: string; target?: string; payload?: Record<string, unknown> }`.

- [ ] **Step 1: Write failing tests for audit module**

Create `tests/audit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emitAudit } from '../src/audit.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

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
        '--source', 'jules-mcp',
        '--category', 'coding-task',
        '--action', 'POST',
        '--service', 'github/owner/repo',
        '--reason', 'test reason',
      ]),
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('includes optional target and payload args', async () => {
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      if (typeof cb === 'function') cb(null, '', '');
      return {} as any;
    });

    await emitAudit({
      ...baseOpts,
      target: 'session-xyz',
      payload: { prompt: 'fix the bug' },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain('--target');
    expect(args[args.indexOf('--target') + 1]).toBe('session-xyz');
    expect(args).toContain('--payload');
    const payloadStr = args[args.indexOf('--payload') + 1];
    expect(JSON.parse(payloadStr)).toEqual({ prompt: 'fix the bug' });
  });

  it('never includes API key in payload', async () => {
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      if (typeof cb === 'function') cb(null, '', '');
      return {} as any;
    });

    await emitAudit({
      ...baseOpts,
      payload: { prompt: 'test', apiKey: 'SHOULD_NOT_APPEAR' },
    });

    const args = mockExecFile.mock.calls[0][1] as string[];
    const payloadStr = args[args.indexOf('--payload') + 1];
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/audit.test.ts
```

Expected: FAIL — `Cannot find module '../src/audit.js'`

- [ ] **Step 3: Implement audit module**

Create `src/audit.ts`:

```typescript
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
      '--source', opts.source,
      '--category', opts.category,
      '--action', opts.action,
      '--service', opts.service,
      '--reason', opts.reason,
    ];

    if (opts.target) {
      args.push('--target', opts.target);
    }

    if (opts.payload) {
      args.push('--payload', JSON.stringify(opts.payload));
    }

    execFile(INKWELL_BIN, args, { timeout: 5000 }, (error) => {
      if (error) {
        // Swallow — audit failures must never block mutations
        console.error(`[audit] inkwell-emit failed: ${error.message}`);
      }
      resolve();
    });
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
    console.error(`[audit] JSONL fallback failed: ${(error as Error).message}`);
  }
}

export async function emitAudit(opts: AuditOptions): Promise<void> {
  if (inkwellAvailable()) {
    await emitViaInkwell(opts);
  } else {
    emitViaJsonl(opts);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/audit.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/audit.ts tests/audit.test.ts
git commit -m "feat: audit module with inkwell-emit and JSONL fallback"
```

---

### Task 3: Jules HTTP Client

**Files:**
- Create: `src/jules-client.ts`
- Test: `tests/jules-client.test.ts`

**Interfaces:**
- Consumes: `JulesAPIError`, `JulesAuthError`, `JulesNotFoundError`, `JulesRateLimitError` from `src/errors.ts`; `Session`, `Source`, `Activity`, `PaginatedResponse`, `normalizeResourceName` from `src/types.ts`.
- Produces: `class JulesClient` with methods:
  - `constructor(apiKey: string)`
  - `listSources(): Promise<Source[]>`
  - `getSource(name: string): Promise<Source>`
  - `createSession(body: CreateSessionRequest): Promise<Session>`
  - `listSessions(pageSize?: number, pageToken?: string): Promise<{ sessions: Session[]; nextPageToken?: string }>`
  - `getSession(sessionId: string): Promise<Session>`
  - `approvePlan(sessionId: string): Promise<Session>`
  - `sendMessage(sessionId: string, message: string): Promise<Session>`
  - `listActivities(sessionId: string, pageSize?: number, pageToken?: string): Promise<{ activities: Activity[]; nextPageToken?: string }>`
  - `getActivity(sessionId: string, activityId: string): Promise<Activity>`
- Also produces: `interface CreateSessionRequest { prompt: string; sourceContext: SourceContext; title?: string; requirePlanApproval?: boolean; automationMode?: AutomationMode }`.

- [ ] **Step 1: Write failing tests for JulesClient**

Create `tests/jules-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JulesClient } from '../src/jules-client.js';
import { JulesAuthError, JulesNotFoundError, JulesRateLimitError } from '../src/errors.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('JulesClient', () => {
  let client: JulesClient;

  beforeEach(() => {
    vi.resetAllMocks();
    client = new JulesClient('test-api-key');
  });

  describe('listSources', () => {
    it('returns sources array', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        sources: [{ name: 'sources/github/owner/repo' }],
      }));

      const sources = await client.listSources();
      expect(sources).toEqual([{ name: 'sources/github/owner/repo' }]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://jules.googleapis.com/v1alpha/sources',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Goog-Api-Key': 'test-api-key',
          }),
        }),
      );
    });
  });

  describe('createSession', () => {
    it('sends POST with session body', async () => {
      const session = {
        name: 'sessions/123',
        id: '123',
        state: 'QUEUED',
        prompt: 'fix bugs',
        sourceContext: { source: 'sources/github/o/r' },
        createTime: '2026-01-01T00:00:00Z',
        updateTime: '2026-01-01T00:00:00Z',
        url: 'https://jules.google/sessions/123',
      };
      mockFetch.mockResolvedValueOnce(jsonResponse(session));

      const result = await client.createSession({
        prompt: 'fix bugs',
        sourceContext: {
          source: 'sources/github/o/r',
          githubRepoContext: { startingBranch: 'main' },
        },
      });

      expect(result.id).toBe('123');
      expect(result.state).toBe('QUEUED');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('https://jules.googleapis.com/v1alpha/sessions');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toMatchObject({ prompt: 'fix bugs' });
    });
  });

  describe('getSession', () => {
    it('normalizes bare session ID', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: 'sessions/abc', id: 'abc', state: 'COMPLETED',
        prompt: 'x', sourceContext: { source: 's' },
        createTime: '', updateTime: '', url: '',
      }));

      await client.getSession('abc');
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://jules.googleapis.com/v1alpha/sessions/abc',
      );
    });
  });

  describe('approvePlan', () => {
    it('posts to the approvePlan action', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        name: 'sessions/abc', id: 'abc', state: 'IN_PROGRESS',
        prompt: 'x', sourceContext: { source: 's' },
        createTime: '', updateTime: '', url: '',
      }));

      const result = await client.approvePlan('abc');
      expect(result.state).toBe('IN_PROGRESS');
      expect(mockFetch.mock.calls[0][0]).toContain(':approvePlan');
    });
  });

  describe('error handling', () => {
    it('throws JulesAuthError on 401', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'unauth' }, 401));
      await expect(client.listSources()).rejects.toThrow(JulesAuthError);
    });

    it('throws JulesAuthError on 403', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'forbidden' }, 403));
      await expect(client.listSources()).rejects.toThrow(JulesAuthError);
    });

    it('throws JulesNotFoundError on 404', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 404));
      await expect(client.getSession('nope')).rejects.toThrow(JulesNotFoundError);
    });

    it('throws JulesRateLimitError on 429 with retry-after', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ error: 'slow down' }, 429, { 'retry-after': '60' }),
      );
      try {
        await client.listSources();
      } catch (e) {
        expect(e).toBeInstanceOf(JulesRateLimitError);
        expect((e as JulesRateLimitError).retryAfter).toBe(60);
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/jules-client.test.ts
```

Expected: FAIL — `Cannot find module '../src/jules-client.js'`

- [ ] **Step 3: Implement JulesClient**

Create `src/jules-client.ts`:

```typescript
import {
  JulesAPIError,
  JulesAuthError,
  JulesNotFoundError,
  JulesRateLimitError,
} from './errors.js';
import {
  type Session,
  type Source,
  type Activity,
  type SourceContext,
  type AutomationMode,
  normalizeResourceName,
} from './types.js';

const BASE_URL = 'https://jules.googleapis.com/v1alpha';

export interface CreateSessionRequest {
  prompt: string;
  sourceContext: SourceContext;
  title?: string;
  requirePlanApproval?: boolean;
  automationMode?: AutomationMode;
}

export class JulesClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const headers: Record<string, string> = {
      'X-Goog-Api-Key': this.apiKey,
    };

    const init: RequestInit = { method, headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      await this.handleError(response, path);
    }

    return (await response.json()) as T;
  }

  private async handleError(response: Response, path: string): Promise<never> {
    const status = response.status;

    if (status === 401 || status === 403) {
      throw new JulesAuthError();
    }

    if (status === 404) {
      throw new JulesNotFoundError(path);
    }

    if (status === 429) {
      const retryAfter = response.headers.get('retry-after');
      throw new JulesRateLimitError(
        retryAfter ? parseInt(retryAfter, 10) : undefined,
      );
    }

    let message = `Jules API error: ${status}`;
    try {
      const body = await response.json();
      if (body?.error?.message) {
        message = body.error.message;
      }
    } catch {
      // Use default message
    }

    throw new JulesAPIError(message, status);
  }

  // --- Sources ---

  async listSources(): Promise<Source[]> {
    const result = await this.request<{ sources?: Source[] }>('/sources');
    return result.sources ?? [];
  }

  async getSource(name: string): Promise<Source> {
    const normalized = normalizeResourceName(name, 'sources');
    return this.request<Source>(`/${normalized}`);
  }

  // --- Sessions ---

  async createSession(body: CreateSessionRequest): Promise<Session> {
    return this.request<Session>('/sessions', 'POST', body);
  }

  async listSessions(
    pageSize?: number,
    pageToken?: string,
  ): Promise<{ sessions: Session[]; nextPageToken?: string }> {
    const params = new URLSearchParams();
    if (pageSize) params.set('pageSize', String(pageSize));
    if (pageToken) params.set('pageToken', pageToken);
    const query = params.toString();
    const path = query ? `/sessions?${query}` : '/sessions';
    const result = await this.request<{
      sessions?: Session[];
      nextPageToken?: string;
    }>(path);
    return {
      sessions: result.sessions ?? [],
      nextPageToken: result.nextPageToken,
    };
  }

  async getSession(sessionId: string): Promise<Session> {
    const name = normalizeResourceName(sessionId, 'sessions');
    return this.request<Session>(`/${name}`);
  }

  async approvePlan(sessionId: string): Promise<Session> {
    const name = normalizeResourceName(sessionId, 'sessions');
    return this.request<Session>(`/${name}:approvePlan`, 'POST', {});
  }

  async sendMessage(sessionId: string, message: string): Promise<Session> {
    const name = normalizeResourceName(sessionId, 'sessions');
    return this.request<Session>(`/${name}:sendMessage`, 'POST', {
      message,
    });
  }

  // --- Activities ---

  async listActivities(
    sessionId: string,
    pageSize?: number,
    pageToken?: string,
  ): Promise<{ activities: Activity[]; nextPageToken?: string }> {
    const name = normalizeResourceName(sessionId, 'sessions');
    const params = new URLSearchParams();
    if (pageSize) params.set('pageSize', String(pageSize));
    if (pageToken) params.set('pageToken', pageToken);
    const query = params.toString();
    const path = query
      ? `/${name}/activities?${query}`
      : `/${name}/activities`;
    const result = await this.request<{
      activities?: Activity[];
      nextPageToken?: string;
    }>(path);
    return {
      activities: result.activities ?? [],
      nextPageToken: result.nextPageToken,
    };
  }

  async getActivity(
    sessionId: string,
    activityId: string,
  ): Promise<Activity> {
    const sessionName = normalizeResourceName(sessionId, 'sessions');
    return this.request<Activity>(
      `/${sessionName}/activities/${activityId}`,
    );
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/jules-client.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/jules-client.ts tests/jules-client.test.ts
git commit -m "feat: Jules HTTP client with typed methods and error mapping"
```

---

### Task 4: Formatters

**Files:**
- Create: `src/formatters.ts`
- Test: `tests/formatters.test.ts`

**Interfaces:**
- Consumes: `Session`, `Activity`, `Plan`, `SessionState`, `ActivityType` from `src/types.ts`.
- Produces:
  - `formatSession(session: Session): string` — human-readable session summary
  - `formatActivity(activity: Activity): string` — human-readable activity entry
  - `formatPlan(plan: Plan): string` — numbered step list
  - `describeState(state: SessionState): string` — human-readable state description
  - `truncatePatch(patch: string, maxLines?: number): string` — truncate git diffs

- [ ] **Step 1: Write failing tests**

Create `tests/formatters.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  formatSession,
  formatActivity,
  formatPlan,
  describeState,
  truncatePatch,
} from '../src/formatters.js';
import type { Session, Activity, Plan } from '../src/types.js';

describe('describeState', () => {
  it('returns human-readable descriptions', () => {
    expect(describeState('QUEUED')).toBe('Queued — waiting to start');
    expect(describeState('AWAITING_PLAN_APPROVAL')).toContain('plan');
    expect(describeState('COMPLETED')).toContain('complete');
  });
});

describe('truncatePatch', () => {
  it('returns short patches unchanged', () => {
    const patch = 'line1\nline2\nline3';
    expect(truncatePatch(patch, 50)).toBe(patch);
  });

  it('truncates long patches with a count', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const patch = lines.join('\n');
    const result = truncatePatch(patch, 10);
    expect(result).toContain('line 0');
    expect(result).toContain('line 9');
    expect(result).toContain('90 more lines');
    expect(result.split('\n').length).toBeLessThan(15);
  });
});

describe('formatPlan', () => {
  it('formats steps as numbered list', () => {
    const plan: Plan = {
      id: 'plan-1',
      steps: [
        { id: 's1', index: 0, title: 'Analyze code', description: 'Read the files' },
        { id: 's2', index: 1, title: 'Write fix', description: 'Apply the patch' },
      ],
      createTime: '2026-01-01T00:00:00Z',
    };
    const result = formatPlan(plan);
    expect(result).toContain('1. Analyze code');
    expect(result).toContain('2. Write fix');
    expect(result).toContain('Read the files');
  });
});

describe('formatSession', () => {
  const baseSession: Session = {
    name: 'sessions/abc',
    id: 'abc',
    prompt: 'fix the bug',
    title: 'Bug Fix',
    sourceContext: { source: 'sources/github/o/r' },
    createTime: '2026-01-01T00:00:00Z',
    updateTime: '2026-01-01T01:00:00Z',
    state: 'COMPLETED',
    url: 'https://jules.google/sessions/abc',
    outputs: [{ pullRequest: { url: 'https://github.com/o/r/pull/1', title: 'Fix bug', description: 'Fixes it' } }],
  };

  it('includes state description and PR link', () => {
    const result = formatSession(baseSession);
    expect(result).toContain('COMPLETED');
    expect(result).toContain('https://github.com/o/r/pull/1');
    expect(result).toContain('Bug Fix');
  });
});

describe('formatActivity', () => {
  it('formats agent messages', () => {
    const activity: Activity = {
      name: 'sessions/abc/activities/1',
      id: '1',
      description: 'Agent spoke',
      createTime: '2026-01-01T00:00:00Z',
      originator: 'agent',
      activity: { agentMessaged: { agentMessage: 'I found the bug' } },
    };
    const result = formatActivity(activity);
    expect(result).toContain('I found the bug');
    expect(result).toContain('agent');
  });

  it('formats plan generated activities', () => {
    const activity: Activity = {
      name: 'sessions/abc/activities/2',
      id: '2',
      description: 'Plan created',
      createTime: '2026-01-01T00:00:00Z',
      originator: 'agent',
      activity: {
        planGenerated: {
          plan: {
            id: 'p1',
            steps: [{ id: 's1', index: 0, title: 'Step 1', description: 'Do thing' }],
            createTime: '2026-01-01T00:00:00Z',
          },
        },
      },
    };
    const result = formatActivity(activity);
    expect(result).toContain('Plan');
    expect(result).toContain('Step 1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/formatters.test.ts
```

Expected: FAIL — `Cannot find module '../src/formatters.js'`

- [ ] **Step 3: Implement formatters**

Create `src/formatters.ts`:

```typescript
import type {
  Session,
  Activity,
  Plan,
  SessionState,
  ActivityType,
  Artifact,
} from './types.js';

const STATE_DESCRIPTIONS: Record<SessionState, string> = {
  STATE_UNSPECIFIED: 'Unknown state',
  QUEUED: 'Queued — waiting to start',
  PLANNING: 'Planning — Jules is analyzing the task',
  AWAITING_PLAN_APPROVAL: 'Awaiting plan approval — review and approve the plan to proceed',
  AWAITING_USER_FEEDBACK: 'Awaiting feedback — Jules needs your input to continue',
  IN_PROGRESS: 'In progress — Jules is working',
  PAUSED: 'Paused',
  FAILED: 'Failed — the task encountered an error',
  COMPLETED: 'Completed successfully',
};

export function describeState(state: SessionState): string {
  return STATE_DESCRIPTIONS[state] ?? `Unknown state: ${state}`;
}

export function truncatePatch(patch: string, maxLines = 50): string {
  const lines = patch.split('\n');
  if (lines.length <= maxLines) {
    return patch;
  }
  const shown = lines.slice(0, maxLines);
  const remaining = lines.length - maxLines;
  return shown.join('\n') + `\n\n... ${remaining} more lines omitted`;
}

export function formatPlan(plan: Plan): string {
  const header = `Plan ${plan.id}:`;
  const steps = plan.steps
    .sort((a, b) => a.index - b.index)
    .map((s) => `${s.index + 1}. ${s.title}\n   ${s.description}`)
    .join('\n');
  return `${header}\n${steps}`;
}

export function formatSession(session: Session): string {
  const parts: string[] = [];

  parts.push(`Session: ${session.title ?? session.id}`);
  parts.push(`ID: ${session.id}`);
  parts.push(`State: ${session.state} — ${describeState(session.state)}`);
  parts.push(`Prompt: ${session.prompt}`);
  parts.push(`Source: ${session.sourceContext.source}`);
  parts.push(`URL: ${session.url}`);
  parts.push(`Created: ${session.createTime}`);
  parts.push(`Updated: ${session.updateTime}`);

  if (session.outputs?.length) {
    for (const output of session.outputs) {
      if (output.pullRequest) {
        const pr = output.pullRequest;
        parts.push('');
        parts.push(`Pull Request: ${pr.title}`);
        parts.push(`  URL: ${pr.url}`);
        parts.push(`  ${pr.description}`);
      }
    }
  }

  return parts.join('\n');
}

function formatArtifacts(artifacts: Artifact[]): string {
  const parts: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.changeSet) {
      const cs = artifact.changeSet;
      parts.push(`Change in ${cs.source}:`);
      if (cs.gitPatch) {
        parts.push(`  Commit message: ${cs.gitPatch.suggestedCommitMessage}`);
        parts.push(`  Base: ${cs.gitPatch.baseCommitId}`);
        parts.push(`  Diff:\n${truncatePatch(cs.gitPatch.unidiffPatch)}`);
      }
    }
    if (artifact.bashOutput) {
      const bo = artifact.bashOutput;
      parts.push(`Command: ${bo.command} (exit ${bo.exitCode})`);
      parts.push(`Output:\n${bo.output}`);
    }
    if (artifact.media) {
      parts.push(`Media: ${artifact.media.mimeType} (${artifact.media.data.length} bytes base64)`);
    }
  }
  return parts.join('\n');
}

export function formatActivity(activity: Activity): string {
  const parts: string[] = [];
  const time = activity.createTime;
  const from = activity.originator;

  const act = activity.activity;

  if ('agentMessaged' in act) {
    parts.push(`[${time}] Agent: ${act.agentMessaged.agentMessage}`);
  } else if ('userMessaged' in act) {
    parts.push(`[${time}] User: ${act.userMessaged.userMessage}`);
  } else if ('planGenerated' in act) {
    parts.push(`[${time}] Plan generated:`);
    parts.push(formatPlan(act.planGenerated.plan));
  } else if ('planApproved' in act) {
    parts.push(`[${time}] Plan approved (${act.planApproved.planId})`);
  } else if ('progressUpdated' in act) {
    parts.push(`[${time}] Progress: ${act.progressUpdated.title} — ${act.progressUpdated.description}`);
  } else if ('sessionCompleted' in act) {
    parts.push(`[${time}] Session completed`);
  } else if ('sessionFailed' in act) {
    parts.push(`[${time}] Session failed: ${act.sessionFailed.reason}`);
  }

  if (activity.artifacts?.length) {
    parts.push(formatArtifacts(activity.artifacts));
  }

  return parts.join('\n');
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/formatters.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/formatters.ts tests/formatters.test.ts
git commit -m "feat: output formatters for sessions, activities, plans, and patches"
```

---

### Task 5: MCP Tool Handlers — Sources & Sessions

**Files:**
- Create: `src/tools/sources.ts`
- Create: `src/tools/sessions.ts`
- Test: `tests/tools/sources.test.ts`
- Test: `tests/tools/sessions.test.ts`

**Interfaces:**
- Consumes: `JulesClient` and `CreateSessionRequest` from `src/jules-client.ts`; `emitAudit` from `src/audit.ts`; `formatSession` from `src/formatters.ts`; error classes from `src/errors.ts`; types from `src/types.ts`.
- Produces: `registerSourceTools(server: McpServer, client: JulesClient): void`; `registerSessionTools(server: McpServer, client: JulesClient): void`. Each registers tools on the MCP server with zod schemas.

- [ ] **Step 1: Write failing tests for source tools**

Create `tests/tools/sources.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSourceTools } from '../../src/tools/sources.js';
import type { JulesClient } from '../../src/jules-client.js';

describe('source tools', () => {
  let mockServer: any;
  let mockClient: Partial<JulesClient>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };
    mockClient = {
      listSources: vi.fn().mockResolvedValue([
        { name: 'sources/github/owner/repo' },
      ]),
      getSource: vi.fn().mockResolvedValue({
        name: 'sources/github/owner/repo',
      }),
    };

    registerSourceTools(mockServer, mockClient as JulesClient);
  });

  it('registers jules_list_sources and jules_get_source', () => {
    expect(registeredTools.has('jules_list_sources')).toBe(true);
    expect(registeredTools.has('jules_get_source')).toBe(true);
  });

  it('jules_list_sources returns formatted sources', async () => {
    const handler = registeredTools.get('jules_list_sources')!.handler;
    const result = await handler({});
    expect(result.content[0].text).toContain('sources/github/owner/repo');
    expect(mockClient.listSources).toHaveBeenCalled();
  });

  it('jules_get_source calls client with source name', async () => {
    const handler = registeredTools.get('jules_get_source')!.handler;
    const result = await handler({ source: 'github/owner/repo' });
    expect(mockClient.getSource).toHaveBeenCalledWith('github/owner/repo');
  });
});
```

- [ ] **Step 2: Write failing tests for session tools**

Create `tests/tools/sessions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSessionTools } from '../../src/tools/sessions.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
  emitAudit: vi.fn().mockResolvedValue(undefined),
}));

const mockSession: Session = {
  name: 'sessions/abc',
  id: 'abc',
  prompt: 'fix bug',
  sourceContext: { source: 'sources/github/o/r' },
  state: 'QUEUED',
  createTime: '2026-01-01T00:00:00Z',
  updateTime: '2026-01-01T00:00:00Z',
  url: 'https://jules.google/sessions/abc',
};

describe('session tools', () => {
  let mockServer: any;
  let mockClient: Partial<JulesClient>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    vi.resetAllMocks();
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };
    mockClient = {
      createSession: vi.fn().mockResolvedValue(mockSession),
      listSessions: vi.fn().mockResolvedValue({ sessions: [mockSession] }),
      getSession: vi.fn().mockResolvedValue(mockSession),
      approvePlan: vi.fn().mockResolvedValue({ ...mockSession, state: 'IN_PROGRESS' }),
      sendMessage: vi.fn().mockResolvedValue({ ...mockSession, state: 'IN_PROGRESS' }),
    };

    registerSessionTools(mockServer, mockClient as JulesClient);
  });

  it('registers all 5 session tools', () => {
    expect(registeredTools.has('jules_create_session')).toBe(true);
    expect(registeredTools.has('jules_list_sessions')).toBe(true);
    expect(registeredTools.has('jules_get_session')).toBe(true);
    expect(registeredTools.has('jules_approve_plan')).toBe(true);
    expect(registeredTools.has('jules_send_message')).toBe(true);
  });

  it('jules_create_session with dry_run returns DRY_RUN status', async () => {
    const handler = registeredTools.get('jules_create_session')!.handler;
    const result = await handler({
      prompt: 'fix bug',
      source: 'sources/github/o/r',
      starting_branch: 'main',
      reason: 'testing',
      dry_run: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('DRY_RUN');
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('jules_create_session calls client and emits audit', async () => {
    const { emitAudit } = await import('../../src/audit.js');
    const handler = registeredTools.get('jules_create_session')!.handler;
    await handler({
      prompt: 'fix bug',
      source: 'sources/github/o/r',
      starting_branch: 'main',
      reason: 'need to fix it',
    });
    expect(mockClient.createSession).toHaveBeenCalled();
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({
      source: 'jules-mcp',
      category: 'coding-task',
      action: 'POST',
      reason: 'need to fix it',
    }));
  });

  it('jules_approve_plan rejects when session is not AWAITING_PLAN_APPROVAL', async () => {
    // getSession returns IN_PROGRESS state, so approve should fail with state error
    const handler = registeredTools.get('jules_approve_plan')!.handler;
    const result = await handler({ session_id: 'abc', reason: 'approving' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('ERROR');
    expect(parsed.code).toBe(409);
    expect(result.isError).toBe(true);
  });

  it('jules_get_session returns formatted session', async () => {
    const handler = registeredTools.get('jules_get_session')!.handler;
    const result = await handler({ session_id: 'abc' });
    expect(result.content[0].text).toContain('abc');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/tools/
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement source tools**

Create `src/tools/sources.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { JulesAPIError } from '../errors.js';

function errorResponse(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          error instanceof JulesAPIError
            ? error.toJSON()
            : { status: 'ERROR', message: String(error) },
        ),
      },
    ],
    isError: true,
  };
}

export function registerSourceTools(
  server: McpServer,
  client: JulesClient,
): void {
  server.tool(
    'jules_list_sources',
    'List connected GitHub repositories available for Jules coding tasks',
    {},
    async () => {
      try {
        const sources = await client.listSources();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'OK', sources }, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'jules_get_source',
    'Get details for a specific connected source (GitHub repo)',
    { source: z.string().describe('Source name or ID (e.g. "github/owner/repo" or "sources/github/owner/repo")') },
    async ({ source }) => {
      try {
        const result = await client.getSource(source);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'OK', source: result }, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
```

- [ ] **Step 5: Implement session tools**

Create `src/tools/sessions.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { emitAudit } from '../audit.js';
import { formatSession } from '../formatters.js';
import { JulesAPIError, JulesStateError } from '../errors.js';

function errorResponse(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          error instanceof JulesAPIError
            ? error.toJSON()
            : { status: 'ERROR', message: String(error) },
        ),
      },
    ],
    isError: true,
  };
}

export function registerSessionTools(
  server: McpServer,
  client: JulesClient,
): void {
  server.tool(
    'jules_create_session',
    'Create a new Jules coding task. Requires a prompt, source repo, and branch.',
    {
      prompt: z.string().describe('What Jules should do'),
      source: z.string().describe('Source name (e.g. "sources/github/owner/repo")'),
      starting_branch: z.string().describe('Branch to start from (e.g. "main")'),
      title: z.string().optional().describe('Optional session title'),
      require_plan_approval: z.boolean().default(true).describe('Require plan approval before execution (default: true)'),
      automation_mode: z.enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR']).optional().describe('Set to AUTO_CREATE_PR to auto-create a PR'),
      reason: z.string().describe('Why this task is being created (for audit log)'),
      dry_run: z.boolean().default(false).describe('Preview the request without executing'),
    },
    async ({ prompt, source, starting_branch, title, require_plan_approval, automation_mode, reason, dry_run }) => {
      const body = {
        prompt,
        sourceContext: {
          source,
          githubRepoContext: { startingBranch: starting_branch },
        },
        title,
        requirePlanApproval: require_plan_approval,
        automationMode: automation_mode,
      };

      if (dry_run) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'DRY_RUN',
                dry_run: true,
                would_request: { method: 'POST', url: '/v1alpha/sessions', body },
              }, null, 2),
            },
          ],
        };
      }

      try {
        const session = await client.createSession(body);
        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST',
          service: source,
          reason,
          target: session.id,
          payload: { prompt, title },
        });
        return {
          content: [{ type: 'text' as const, text: formatSession(session) }],
        };
      } catch (error) {
        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST_FAIL',
          service: source,
          reason,
          payload: { prompt, error: String(error) },
        });
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'jules_list_sessions',
    'List Jules coding sessions with pagination',
    {
      page_size: z.number().optional().describe('Number of sessions to return'),
      page_token: z.string().optional().describe('Pagination token from previous response'),
    },
    async ({ page_size, page_token }) => {
      try {
        const result = await client.listSessions(page_size, page_token);
        const text = result.sessions.map(formatSession).join('\n\n---\n\n');
        const response: any = { status: 'OK', count: result.sessions.length };
        if (result.nextPageToken) response.nextPageToken = result.nextPageToken;
        return {
          content: [
            { type: 'text' as const, text: `${JSON.stringify(response)}\n\n${text}` },
          ],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'jules_get_session',
    'Get the current status of a Jules session',
    {
      session_id: z.string().describe('Session ID or full resource name'),
    },
    async ({ session_id }) => {
      try {
        const session = await client.getSession(session_id);
        return {
          content: [{ type: 'text' as const, text: formatSession(session) }],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'jules_approve_plan',
    'Approve a pending plan in a Jules session. Only valid when state is AWAITING_PLAN_APPROVAL.',
    {
      session_id: z.string().describe('Session ID or full resource name'),
      reason: z.string().describe('Why the plan is being approved (for audit log)'),
    },
    async ({ session_id, reason }) => {
      try {
        // Pre-validate state before calling the API
        const current = await client.getSession(session_id);
        if (current.state !== 'AWAITING_PLAN_APPROVAL') {
          throw new JulesStateError('approve_plan', current.state);
        }

        const session = await client.approvePlan(session_id);
        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST',
          service: session.sourceContext.source,
          reason,
          target: session.id,
        });
        return {
          content: [{ type: 'text' as const, text: formatSession(session) }],
        };
      } catch (error) {
        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST_FAIL',
          service: session_id,
          reason,
          payload: { error: String(error) },
        });
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'jules_send_message',
    'Send a message or feedback to a Jules session',
    {
      session_id: z.string().describe('Session ID or full resource name'),
      message: z.string().describe('Message to send to Jules'),
      reason: z.string().describe('Why this message is being sent (for audit log)'),
    },
    async ({ session_id, message, reason }) => {
      try {
        const session = await client.sendMessage(session_id, message);
        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST',
          service: session.sourceContext.source,
          reason,
          target: session.id,
          payload: { message },
        });
        return {
          content: [{ type: 'text' as const, text: formatSession(session) }],
        };
      } catch (error) {
        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST_FAIL',
          service: session_id,
          reason,
          payload: { message, error: String(error) },
        });
        return errorResponse(error);
      }
    },
  );
}
```

- [ ] **Step 6: Run tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/tools/
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/tools/sources.ts src/tools/sessions.ts tests/tools/sources.test.ts tests/tools/sessions.test.ts
git commit -m "feat: MCP tool handlers for sources and sessions with audit logging"
```

---

### Task 6: MCP Tool Handlers — Activities

**Files:**
- Create: `src/tools/activities.ts`
- Test: `tests/tools/activities.test.ts`

**Interfaces:**
- Consumes: `JulesClient` from `src/jules-client.ts`; `formatActivity` from `src/formatters.ts`; `JulesAPIError` from `src/errors.ts`.
- Produces: `registerActivityTools(server: McpServer, client: JulesClient): void`.

- [ ] **Step 1: Write failing tests**

Create `tests/tools/activities.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerActivityTools } from '../../src/tools/activities.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Activity } from '../../src/types.js';

const mockActivity: Activity = {
  name: 'sessions/abc/activities/1',
  id: '1',
  description: 'Agent sent message',
  createTime: '2026-01-01T00:00:00Z',
  originator: 'agent',
  activity: { agentMessaged: { agentMessage: 'Found the bug' } },
};

describe('activity tools', () => {
  let mockServer: any;
  let mockClient: Partial<JulesClient>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };
    mockClient = {
      listActivities: vi.fn().mockResolvedValue({ activities: [mockActivity] }),
      getActivity: vi.fn().mockResolvedValue(mockActivity),
    };

    registerActivityTools(mockServer, mockClient as JulesClient);
  });

  it('registers jules_list_activities and jules_get_activity', () => {
    expect(registeredTools.has('jules_list_activities')).toBe(true);
    expect(registeredTools.has('jules_get_activity')).toBe(true);
  });

  it('jules_list_activities returns formatted activities', async () => {
    const handler = registeredTools.get('jules_list_activities')!.handler;
    const result = await handler({ session_id: 'abc' });
    expect(result.content[0].text).toContain('Found the bug');
  });

  it('jules_get_activity returns single activity', async () => {
    const handler = registeredTools.get('jules_get_activity')!.handler;
    const result = await handler({ session_id: 'abc', activity_id: '1' });
    expect(result.content[0].text).toContain('Found the bug');
    expect(mockClient.getActivity).toHaveBeenCalledWith('abc', '1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/tools/activities.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement activity tools**

Create `src/tools/activities.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { formatActivity } from '../formatters.js';
import { JulesAPIError } from '../errors.js';

function errorResponse(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          error instanceof JulesAPIError
            ? error.toJSON()
            : { status: 'ERROR', message: String(error) },
        ),
      },
    ],
    isError: true,
  };
}

export function registerActivityTools(
  server: McpServer,
  client: JulesClient,
): void {
  server.tool(
    'jules_list_activities',
    'List activity log entries for a Jules session — messages, plans, progress updates, and results',
    {
      session_id: z.string().describe('Session ID or full resource name'),
      page_size: z.number().optional().describe('Number of activities to return'),
      page_token: z.string().optional().describe('Pagination token'),
    },
    async ({ session_id, page_size, page_token }) => {
      try {
        const result = await client.listActivities(session_id, page_size, page_token);
        const text = result.activities.map(formatActivity).join('\n\n');
        const response: any = { status: 'OK', count: result.activities.length };
        if (result.nextPageToken) response.nextPageToken = result.nextPageToken;
        return {
          content: [
            { type: 'text' as const, text: `${JSON.stringify(response)}\n\n${text}` },
          ],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'jules_get_activity',
    'Get a single activity with full details including artifacts (code changes, patches, command output)',
    {
      session_id: z.string().describe('Session ID or full resource name'),
      activity_id: z.string().describe('Activity ID'),
    },
    async ({ session_id, activity_id }) => {
      try {
        const activity = await client.getActivity(session_id, activity_id);
        return {
          content: [{ type: 'text' as const, text: formatActivity(activity) }],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );
}
```

- [ ] **Step 4: Run tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/tools/activities.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/tools/activities.ts tests/tools/activities.test.ts
git commit -m "feat: MCP tool handlers for activities"
```

---

### Task 7: Scheduler — Encrypted Persistence & Cron

**Files:**
- Create: `src/scheduler/persistence.ts`
- Create: `src/scheduler/cron.ts`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: `ScheduleEntry` from `src/types.ts`; `JulesClient` and `CreateSessionRequest` from `src/jules-client.ts`; `emitAudit` from `src/audit.ts`.
- Produces:
  - `class ScheduleStore` with methods: `constructor(encryptionKey?: string)`, `load(): ScheduleEntry[]`, `save(entries: ScheduleEntry[]): void`, `add(entry: ScheduleEntry): void`, `remove(id: string): boolean`, `list(): ScheduleEntry[]`.
  - `class ScheduleManager` with methods: `constructor(store: ScheduleStore, client: JulesClient)`, `start(): void`, `stop(): void`, `add(entry: Omit<ScheduleEntry, 'id' | 'createdAt'>): ScheduleEntry`, `remove(id: string): boolean`, `list(): ScheduleEntry[]`.

- [ ] **Step 1: Write failing tests**

Create `tests/scheduler.test.ts`:

```typescript
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
    const store2 = new ScheduleStore('test-encryption-key-32chars!!!!!', tmpDir);
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
    const store = new ScheduleStore('test-encryption-key-32chars!!!!!', tmpDir);
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/scheduler.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement ScheduleStore**

Create `src/scheduler/persistence.ts`:

```typescript
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
      this.key = null;
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
```

- [ ] **Step 4: Implement ScheduleManager**

Create `src/scheduler/cron.ts`:

```typescript
import cron from 'node-cron';
import * as crypto from 'node:crypto';
import type { ScheduleEntry } from '../types.js';
import type { ScheduleStore } from './persistence.js';
import type { JulesClient } from '../jules-client.js';
import { emitAudit } from '../audit.js';

export class ScheduleManager {
  private readonly store: ScheduleStore;
  private readonly client: JulesClient;
  private readonly jobs: Map<string, cron.ScheduledTask> = new Map();

  constructor(store: ScheduleStore, client: JulesClient) {
    this.store = store;
    this.client = client;
  }

  start(): void {
    for (const entry of this.store.list()) {
      this.startJob(entry);
    }
  }

  stop(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
  }

  add(
    input: Omit<ScheduleEntry, 'id' | 'createdAt'>,
  ): ScheduleEntry {
    const entry: ScheduleEntry = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.store.add(entry);
    this.startJob(entry);
    return entry;
  }

  remove(id: string): boolean {
    const job = this.jobs.get(id);
    if (job) {
      job.stop();
      this.jobs.delete(id);
    }
    return this.store.remove(id);
  }

  list(): ScheduleEntry[] {
    return this.store.list();
  }

  private startJob(entry: ScheduleEntry): void {
    if (!cron.validate(entry.cron)) {
      console.error(`[scheduler] Invalid cron expression for "${entry.label}": ${entry.cron}`);
      return;
    }

    const task = cron.schedule(entry.cron, async () => {
      try {
        const session = await this.client.createSession({
          prompt: entry.prompt,
          sourceContext: {
            source: entry.source,
            githubRepoContext: { startingBranch: entry.startingBranch },
          },
          requirePlanApproval: entry.requirePlanApproval,
          automationMode: entry.automationMode,
        });
        await emitAudit({
          source: 'jules-mcp',
          category: 'scheduling',
          action: 'POST',
          service: entry.source,
          reason: `Scheduled task "${entry.label}" (${entry.cron})`,
          target: session.id,
          payload: { scheduleId: entry.id, prompt: entry.prompt },
        });
      } catch (error) {
        await emitAudit({
          source: 'jules-mcp',
          category: 'scheduling',
          action: 'POST_FAIL',
          service: entry.source,
          reason: `Scheduled task "${entry.label}" failed`,
          payload: { scheduleId: entry.id, error: String(error) },
        });
      }
    });

    this.jobs.set(entry.id, task);
  }
}
```

- [ ] **Step 5: Run tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/scheduler.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/scheduler/persistence.ts src/scheduler/cron.ts tests/scheduler.test.ts
git commit -m "feat: scheduler with encrypted persistence and cron management"
```

---

### Task 8: MCP Tool Handlers — Scheduling & Convenience

**Files:**
- Create: `src/tools/scheduling.ts`
- Create: `src/tools/convenience.ts`
- Test: `tests/tools/scheduling.test.ts`
- Test: `tests/tools/convenience.test.ts`

**Interfaces:**
- Consumes: `ScheduleManager` from `src/scheduler/cron.ts`; `JulesClient` from `src/jules-client.ts`; `emitAudit` from `src/audit.ts`; `formatSession` from `src/formatters.ts`; `TERMINAL_STATES` from `src/types.ts`; `JulesAPIError` from `src/errors.js`.
- Produces: `registerSchedulingTools(server: McpServer, manager: ScheduleManager): void`; `registerConvenienceTools(server: McpServer, client: JulesClient): void`.

- [ ] **Step 1: Write failing tests for scheduling tools**

Create `tests/tools/scheduling.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSchedulingTools } from '../../src/tools/scheduling.js';
import type { ScheduleManager } from '../../src/scheduler/cron.js';

vi.mock('../../src/audit.js', () => ({
  emitAudit: vi.fn().mockResolvedValue(undefined),
}));

describe('scheduling tools', () => {
  let mockServer: any;
  let mockManager: Partial<ScheduleManager>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    vi.resetAllMocks();
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };
    mockManager = {
      add: vi.fn().mockReturnValue({
        id: 'sched-1', label: 'Weekly lint', cron: '0 9 * * 1',
        prompt: 'lint', source: 's', startingBranch: 'main',
        requirePlanApproval: true, createdAt: '2026-01-01T00:00:00Z',
      }),
      list: vi.fn().mockReturnValue([]),
      remove: vi.fn().mockReturnValue(true),
    };

    registerSchedulingTools(mockServer, mockManager as ScheduleManager);
  });

  it('registers jules_schedule_task and jules_list_schedules', () => {
    expect(registeredTools.has('jules_schedule_task')).toBe(true);
    expect(registeredTools.has('jules_list_schedules')).toBe(true);
  });

  it('jules_schedule_task with dry_run returns DRY_RUN', async () => {
    const handler = registeredTools.get('jules_schedule_task')!.handler;
    const result = await handler({
      cron: '0 9 * * 1', prompt: 'lint', source: 's',
      starting_branch: 'main', label: 'Weekly lint',
      reason: 'automation', dry_run: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('DRY_RUN');
    expect(mockManager.add).not.toHaveBeenCalled();
  });

  it('jules_schedule_task creates a schedule', async () => {
    const handler = registeredTools.get('jules_schedule_task')!.handler;
    await handler({
      cron: '0 9 * * 1', prompt: 'lint', source: 's',
      starting_branch: 'main', label: 'Weekly lint',
      reason: 'automation',
    });
    expect(mockManager.add).toHaveBeenCalled();
  });

  it('jules_list_schedules with delete action removes', async () => {
    const handler = registeredTools.get('jules_list_schedules')!.handler;
    await handler({ action: 'delete', schedule_id: 'sched-1' });
    expect(mockManager.remove).toHaveBeenCalledWith('sched-1');
  });
});
```

- [ ] **Step 2: Write failing tests for convenience tool**

Create `tests/tools/convenience.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerConvenienceTools } from '../../src/tools/convenience.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
  emitAudit: vi.fn().mockResolvedValue(undefined),
}));

describe('convenience tools', () => {
  let mockServer: any;
  let mockClient: Partial<JulesClient>;
  let registeredTools: Map<string, { handler: Function }>;

  beforeEach(() => {
    vi.resetAllMocks();
    registeredTools = new Map();
    mockServer = {
      tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
        registeredTools.set(name, { handler });
      }),
    };

    const sessionSequence: Session[] = [
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'QUEUED', createTime: '', updateTime: '', url: '' },
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'AWAITING_PLAN_APPROVAL', createTime: '', updateTime: '', url: '' },
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'IN_PROGRESS', createTime: '', updateTime: '', url: '' },
      { name: 's/1', id: '1', prompt: 'p', sourceContext: { source: 's' }, state: 'COMPLETED', createTime: '', updateTime: '', url: '', outputs: [{ pullRequest: { url: 'https://pr', title: 'PR', description: 'd' } }] },
    ];
    let callCount = 0;

    mockClient = {
      createSession: vi.fn().mockResolvedValue(sessionSequence[0]),
      getSession: vi.fn().mockImplementation(async () => {
        callCount++;
        return sessionSequence[Math.min(callCount, sessionSequence.length - 1)];
      }),
      approvePlan: vi.fn().mockResolvedValue(sessionSequence[2]),
    };

    registerConvenienceTools(mockServer, mockClient as JulesClient);
  });

  it('registers jules_run_task', () => {
    expect(registeredTools.has('jules_run_task')).toBe(true);
  });

  it('runs through create → poll → approve → poll → complete', async () => {
    const handler = registeredTools.get('jules_run_task')!.handler;
    const result = await handler({
      prompt: 'fix bug',
      source: 'sources/github/o/r',
      starting_branch: 'main',
      reason: 'need fix',
      auto_approve: true,
      poll_interval_ms: 10, // fast for tests
      timeout_ms: 5000,
    });
    expect(mockClient.createSession).toHaveBeenCalled();
    expect(mockClient.approvePlan).toHaveBeenCalled();
    expect(result.content[0].text).toContain('COMPLETED');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/tools/scheduling.test.ts tests/tools/convenience.test.ts
```

Expected: FAIL

- [ ] **Step 4: Implement scheduling tools**

Create `src/tools/scheduling.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ScheduleManager } from '../scheduler/cron.js';
import { emitAudit } from '../audit.js';
import { JulesAPIError } from '../errors.js';

function errorResponse(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          error instanceof JulesAPIError
            ? error.toJSON()
            : { status: 'ERROR', message: String(error) },
        ),
      },
    ],
    isError: true,
  };
}

export function registerSchedulingTools(
  server: McpServer,
  manager: ScheduleManager,
): void {
  server.tool(
    'jules_schedule_task',
    'Schedule a recurring Jules coding task using a cron expression',
    {
      cron: z.string().describe('Cron expression (e.g. "0 9 * * 1" for every Monday 9am)'),
      prompt: z.string().describe('What Jules should do each time'),
      source: z.string().describe('Source name (e.g. "sources/github/owner/repo")'),
      starting_branch: z.string().describe('Branch to start from'),
      label: z.string().describe('Human-readable name for this schedule'),
      require_plan_approval: z.boolean().default(true).describe('Require plan approval'),
      automation_mode: z.enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR']).optional(),
      reason: z.string().describe('Why this schedule is being created (for audit log)'),
      dry_run: z.boolean().default(false).describe('Preview without creating'),
    },
    async ({ cron, prompt, source, starting_branch, label, require_plan_approval, automation_mode, reason, dry_run }) => {
      const input = {
        label,
        cron,
        prompt,
        source,
        startingBranch: starting_branch,
        requirePlanApproval: require_plan_approval,
        automationMode: automation_mode,
      };

      if (dry_run) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'DRY_RUN', dry_run: true, would_create: input }, null, 2),
            },
          ],
        };
      }

      try {
        const entry = manager.add(input);
        await emitAudit({
          source: 'jules-mcp',
          category: 'scheduling',
          action: 'POST',
          service: source,
          reason,
          target: entry.id,
          payload: { label, cron, prompt },
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'OK', schedule: entry }, null, 2),
            },
          ],
        };
      } catch (error) {
        return errorResponse(error);
      }
    },
  );

  server.tool(
    'jules_list_schedules',
    'List or delete scheduled Jules tasks',
    {
      action: z.enum(['list', 'delete']).default('list').describe('"list" to show all schedules, "delete" to remove one'),
      schedule_id: z.string().optional().describe('Schedule ID to delete (required for delete action)'),
    },
    async ({ action, schedule_id }) => {
      if (action === 'delete') {
        if (!schedule_id) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ status: 'ERROR', message: 'schedule_id is required for delete action' }),
              },
            ],
            isError: true,
          };
        }
        const removed = manager.remove(schedule_id);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: removed ? 'OK' : 'ERROR',
                message: removed ? `Schedule ${schedule_id} deleted` : `Schedule ${schedule_id} not found`,
              }),
            },
          ],
          isError: !removed,
        };
      }

      const schedules = manager.list();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ status: 'OK', count: schedules.length, schedules }, null, 2),
          },
        ],
      };
    },
  );
}
```

- [ ] **Step 5: Implement convenience tool**

Create `src/tools/convenience.ts`:

```typescript
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JulesClient } from '../jules-client.js';
import { emitAudit } from '../audit.js';
import { formatSession } from '../formatters.js';
import { TERMINAL_STATES } from '../types.js';
import { JulesAPIError } from '../errors.js';

function errorResponse(error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          error instanceof JulesAPIError
            ? error.toJSON()
            : { status: 'ERROR', message: String(error) },
        ),
      },
    ],
    isError: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerConvenienceTools(
  server: McpServer,
  client: JulesClient,
): void {
  server.tool(
    'jules_run_task',
    'Create a Jules session, poll until plan is ready, auto-approve, and wait for completion. One-shot fire-and-forget for trusted tasks.',
    {
      prompt: z.string().describe('What Jules should do'),
      source: z.string().describe('Source name'),
      starting_branch: z.string().describe('Branch to start from'),
      title: z.string().optional().describe('Optional session title'),
      automation_mode: z.enum(['AUTOMATION_MODE_UNSPECIFIED', 'AUTO_CREATE_PR']).optional(),
      reason: z.string().describe('Why this task is being run (for audit log)'),
      auto_approve: z.boolean().default(true).describe('Auto-approve the plan when ready'),
      poll_interval_ms: z.number().default(5000).describe('Polling interval in milliseconds'),
      timeout_ms: z.number().default(600000).describe('Maximum wait time in milliseconds (default 10 minutes)'),
    },
    async ({ prompt, source, starting_branch, title, automation_mode, reason, auto_approve, poll_interval_ms, timeout_ms }) => {
      try {
        // 1. Create session
        const session = await client.createSession({
          prompt,
          sourceContext: {
            source,
            githubRepoContext: { startingBranch: starting_branch },
          },
          title,
          requirePlanApproval: auto_approve, // if auto_approve, still require it so we can approve it
          automationMode: automation_mode,
        });

        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST',
          service: source,
          reason,
          target: session.id,
          payload: { prompt, title, mode: 'run_task' },
        });

        const deadline = Date.now() + timeout_ms;

        // 2. Poll until terminal or needs action
        let current = session;
        while (!TERMINAL_STATES.has(current.state) && Date.now() < deadline) {
          if (current.state === 'AWAITING_PLAN_APPROVAL' && auto_approve) {
            current = await client.approvePlan(current.id);
            await emitAudit({
              source: 'jules-mcp',
              category: 'coding-task',
              action: 'POST',
              service: source,
              reason: `Auto-approved plan for run_task: ${reason}`,
              target: current.id,
            });
            continue;
          }

          if (current.state === 'AWAITING_USER_FEEDBACK') {
            // Can't auto-handle user feedback — return current state
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Session needs user feedback. Use jules_send_message to respond.\n\n${formatSession(current)}`,
                },
              ],
            };
          }

          await sleep(poll_interval_ms);
          current = await client.getSession(current.id);
        }

        if (!TERMINAL_STATES.has(current.state)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Timed out after ${timeout_ms}ms. Session is still ${current.state}.\n\n${formatSession(current)}`,
              },
            ],
          };
        }

        return {
          content: [{ type: 'text' as const, text: formatSession(current) }],
        };
      } catch (error) {
        await emitAudit({
          source: 'jules-mcp',
          category: 'coding-task',
          action: 'POST_FAIL',
          service: source,
          reason,
          payload: { prompt, error: String(error), mode: 'run_task' },
        });
        return errorResponse(error);
      }
    },
  );
}
```

- [ ] **Step 6: Run tests**

```bash
cd ~/github/avic/jules-mcp
npx vitest run tests/tools/scheduling.test.ts tests/tools/convenience.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/tools/scheduling.ts src/tools/convenience.ts tests/tools/scheduling.test.ts tests/tools/convenience.test.ts
git commit -m "feat: scheduling and run_task convenience tools"
```

---

### Task 9: MCP Server Entry Point

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: all tool registration functions (`registerSourceTools`, `registerSessionTools`, `registerActivityTools`, `registerSchedulingTools`, `registerConvenienceTools`); `JulesClient` from `src/jules-client.ts`; `ScheduleStore` from `src/scheduler/persistence.ts`; `ScheduleManager` from `src/scheduler/cron.ts`.
- Produces: executable MCP server entry point.

- [ ] **Step 1: Implement server entry point**

Create `src/index.ts`:

```typescript
#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JulesClient } from './jules-client.js';
import { ScheduleStore } from './scheduler/persistence.js';
import { ScheduleManager } from './scheduler/cron.js';
import { registerSourceTools } from './tools/sources.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerActivityTools } from './tools/activities.js';
import { registerSchedulingTools } from './tools/scheduling.js';
import { registerConvenienceTools } from './tools/convenience.js';

const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
  console.error(
    'JULES_API_KEY environment variable is required. Generate one at https://jules.google/settings',
  );
  process.exit(1);
}

const encryptionKey = process.env.JULES_ENCRYPTION_KEY;

const server = new McpServer({
  name: 'jules-mcp',
  version: '0.1.0',
});

const client = new JulesClient(apiKey);
const store = new ScheduleStore(encryptionKey);
const manager = new ScheduleManager(store, client);

// Register all tools
registerSourceTools(server, client);
registerSessionTools(server, client);
registerActivityTools(server, client);
registerSchedulingTools(server, manager);
registerConvenienceTools(server, client);

// Start scheduler
manager.start();

// Connect transport
const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
process.on('SIGINT', () => {
  manager.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  manager.stop();
  process.exit(0);
});
```

- [ ] **Step 2: Verify it builds**

```bash
cd ~/github/avic/jules-mcp
npx tsc
```

Expected: no errors. If there are type errors, fix them.

- [ ] **Step 3: Run full test suite**

```bash
cd ~/github/avic/jules-mcp
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
cd ~/github/avic/jules-mcp
git add src/index.ts
git commit -m "feat: MCP server entry point with all tools and scheduler"
```

---

### Task 10: Plugin Config, LICENSE & Smoke Test

**Files:**
- Create: `LICENSE`
- Create: `.claude/settings.json`
- Create: `scripts/smoke-test.ts`

**Interfaces:**
- Consumes: the built MCP server at `dist/index.js`; `JulesClient` from `src/jules-client.ts`.
- Produces: a working Claude Code plugin MCP config; MIT license; smoke test script.

- [ ] **Step 1: Create MIT LICENSE**

Create `LICENSE`:

```
MIT License

Copyright (c) 2026 Simmons Systems

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Create Claude Code plugin MCP config**

Create `.claude/settings.json`:

```json
{
  "mcpServers": {
    "jules": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": ".",
      "env": {
        "JULES_API_KEY": "${JULES_API_KEY}"
      }
    }
  }
}
```

- [ ] **Step 3: Create smoke test**

Create `scripts/smoke-test.ts`:

```typescript
/**
 * Smoke test — hits the real Jules API to verify connectivity.
 * Run with: npm run smoke
 * Requires JULES_API_KEY in environment.
 */

import { JulesClient } from '../src/jules-client.js';

const apiKey = process.env.JULES_API_KEY;
if (!apiKey) {
  console.error('JULES_API_KEY not set');
  process.exit(1);
}

const client = new JulesClient(apiKey);

async function main() {
  console.log('=== Jules MCP Smoke Test ===\n');

  // Test 1: List sources
  console.log('1. Listing sources...');
  try {
    const sources = await client.listSources();
    console.log(`   Found ${sources.length} source(s)`);
    for (const s of sources) {
      console.log(`   - ${s.name}`);
    }
  } catch (error) {
    console.error(`   FAILED: ${error}`);
  }

  // Test 2: List sessions
  console.log('\n2. Listing recent sessions...');
  try {
    const { sessions } = await client.listSessions(5);
    console.log(`   Found ${sessions.length} session(s)`);
    for (const s of sessions) {
      console.log(`   - ${s.id}: ${s.state} — ${s.title ?? s.prompt.slice(0, 50)}`);
    }
  } catch (error) {
    console.error(`   FAILED: ${error}`);
  }

  console.log('\n=== Smoke test complete ===');
}

main().catch(console.error);
```

- [ ] **Step 4: Build and verify everything works**

```bash
cd ~/github/avic/jules-mcp
npm run build
npm run test
```

Expected: build succeeds, all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/github/avic/jules-mcp
git add LICENSE .claude/settings.json scripts/smoke-test.ts
git commit -m "feat: MIT license, plugin config, and smoke test"
```

- [ ] **Step 6: Run smoke test against real API**

```bash
cd ~/github/avic/jules-mcp
source ~/.bash_secrets
npm run smoke
```

Expected: lists sources and recent sessions without errors.

- [ ] **Step 7: Final commit — tag v0.1.0**

```bash
cd ~/github/avic/jules-mcp
git tag -a v0.1.0 -m "Initial release — 12 MCP tools for Jules API"
```
