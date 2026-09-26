import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerSessionTools } from '../../src/tools/sessions.js';
import { registerConvenienceTools } from '../../src/tools/convenience.js';
import { registerSchedulingTools } from '../../src/tools/scheduling.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { ScheduleManager } from '../../src/scheduler/cron.js';
import { emitAudit } from '../../src/audit.js';
import type { Session } from '../../src/types.js';

vi.mock('../../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));

// #50431 -- one wiring test per tool that takes a prompt/message, driving the
// REAL handler (not the predicate), and asserting the secret never reaches the
// client or the audit record.
const SECRET = `ghp_${'a'.repeat(36)}`;

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

describe('secret-scan wiring (#50431)', () => {
    let tools: Map<string, Function>;
    let client: Partial<JulesClient>;
    let manager: Partial<ScheduleManager>;

    beforeEach(() => {
        vi.clearAllMocks();
        tools = new Map();
        const server: any = {
            tool: vi.fn(
                (name: string, _d: string, _s: any, handler: Function) => {
                    tools.set(name, handler);
                },
            ),
        };
        client = {
            createSession: vi.fn().mockResolvedValue(mockSession),
            getSession: vi.fn().mockResolvedValue(mockSession),
            sendMessage: vi
                .fn()
                .mockResolvedValue({ ...mockSession, state: 'IN_PROGRESS' }),
        };
        manager = {
            add: vi.fn().mockReturnValue({ ...mockSession, id: 'sched-1' }),
            list: vi.fn().mockReturnValue([]),
            remove: vi.fn().mockReturnValue(true),
        };
        registerSessionTools(server, client as JulesClient);
        registerConvenienceTools(server, client as JulesClient);
        registerSchedulingTools(server, manager as ScheduleManager);
    });

    const auditsContainSecret = () =>
        vi
            .mocked(emitAudit)
            .mock.calls.some((c) => JSON.stringify(c[0]).includes(SECRET));

    it('jules_create_session refuses a secret prompt', async () => {
        const r = await tools.get('jules_create_session')!({
            prompt: `please deploy using ${SECRET}`,
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'automation',
        });
        expect(r.isError).toBe(true);
        expect(JSON.parse(r.content[0].text).pattern_class).toBe(
            'github-token',
        );
        expect(client.createSession).not.toHaveBeenCalled();
        expect(auditsContainSecret()).toBe(false);
    });

    it('jules_run_task refuses a secret prompt', async () => {
        const r = await tools.get('jules_run_task')!({
            prompt: `use ${SECRET}`,
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'automation',
        });
        expect(r.isError).toBe(true);
        expect(client.createSession).not.toHaveBeenCalled();
        expect(auditsContainSecret()).toBe(false);
    });

    it('jules_send_message refuses a secret message', async () => {
        const r = await tools.get('jules_send_message')!({
            session_id: 'abc',
            message: `here is the key ${SECRET}`,
            reason: 'automation',
        });
        expect(r.isError).toBe(true);
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(auditsContainSecret()).toBe(false);
    });

    it('jules_schedule_task refuses a secret prompt', async () => {
        const r = await tools.get('jules_schedule_task')!({
            cron: '0 * * * *',
            prompt: `use ${SECRET}`,
            source: 'sources/github/o/r',
            starting_branch: 'main',
            label: 'x',
            reason: 'automation',
        });
        expect(r.isError).toBe(true);
        expect(manager.add).not.toHaveBeenCalled();
        expect(auditsContainSecret()).toBe(false);
    });

    it('a clean prompt still goes through', async () => {
        const r = await tools.get('jules_create_session')!({
            prompt: 'Refactor the parser and add tests.',
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'automation',
        });
        expect(r.isError).toBeUndefined();
        expect(client.createSession).toHaveBeenCalled();
    });

    it('allow_secret overrides, but the audit record is still redacted', async () => {
        const r = await tools.get('jules_create_session')!({
            prompt: `deliberately send ${SECRET}`,
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'deliberate fixture',
            allow_secret: true,
        });
        expect(r.isError).toBeUndefined();
        expect(client.createSession).toHaveBeenCalled();
        expect(auditsContainSecret()).toBe(false);
    });
});
