import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerSessionTools } from '../../src/tools/sessions.js';
import { registerConvenienceTools } from '../../src/tools/convenience.js';
import { registerSchedulingTools } from '../../src/tools/scheduling.js';
import type { JulesClient } from '../../src/jules-client.js';
import type { ScheduleManager } from '../../src/scheduler/cron.js';

vi.mock('../../src/audit.js', () => ({
    emitAudit: vi.fn().mockResolvedValue(undefined),
}));
import { emitAudit } from '../../src/audit.js';

// jules-mcp#50432. The policy module has its own unit tests; these assert the
// three tools that CREATE or SCHEDULE work actually consult it.
//
// The distinction matters and is the failure this file exists to catch: a
// predicate can be written, unit-tested and never wired in — the TheNovaNodes
// defect recorded on #50461, a green suite over a dead code path. So every
// assertion here goes through a registered tool handler, and the negative
// control is that the SAME call succeeds once the repo is on the list.

function harness() {
    const tools = new Map<string, { handler: Function }>();
    const server: any = {
        tool: vi.fn(
            (name: string, _d: string, _s: any, handler: Function) =>
                void tools.set(name, { handler }),
        ),
    };
    const client: Partial<JulesClient> = {
        createSession: vi.fn().mockResolvedValue({
            name: 'sessions/1',
            id: '1',
            prompt: 'p',
            sourceContext: { source: 's' },
            state: 'COMPLETED',
            createTime: '',
            updateTime: '',
            url: '',
        }),
        getSession: vi.fn(),
        approvePlan: vi.fn(),
    };
    const manager: Partial<ScheduleManager> = {
        add: vi.fn().mockReturnValue({ id: 'sch_1', label: 'l' }),
        list: vi.fn().mockReturnValue([]),
    };
    registerSessionTools(server, client as JulesClient);
    registerConvenienceTools(server, client as JulesClient);
    registerSchedulingTools(server, manager as ScheduleManager);
    return { tools, client, manager };
}

const CASES: [string, (extra: object) => object][] = [
    [
        'jules_create_session',
        (extra) => ({
            prompt: 'p',
            starting_branch: 'main',
            reason: 'r',
            require_plan_approval: true,
            include_guidance: false,
            dry_run: false,
            ...extra,
        }),
    ],
    [
        'jules_run_task',
        (extra) => ({
            prompt: 'p',
            starting_branch: 'main',
            reason: 'r',
            auto_approve: true,
            poll_interval_ms: 5,
            timeout_ms: 200,
            parallel: 1,
            ...extra,
        }),
    ],
    [
        'jules_schedule_task',
        (extra) => ({
            cron: '0 3 * * *',
            prompt: 'p',
            starting_branch: 'main',
            label: 'nightly',
            reason: 'r',
            dry_run: false,
            ...extra,
        }),
    ],
];

describe('JULES_ALLOWED_REPOS is enforced on every creating tool', () => {
    const saved = process.env.JULES_ALLOWED_REPOS;
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => {
        if (saved === undefined) delete process.env.JULES_ALLOWED_REPOS;
        else process.env.JULES_ALLOWED_REPOS = saved;
    });

    it.each(CASES)('%s refuses a repo off the list', async (name, args) => {
        process.env.JULES_ALLOWED_REPOS = 'avic/*';
        const { tools, client, manager } = harness();

        const result: any = await tools
            .get(name)!
            .handler(args({ source: 'sources/github/stranger/thing' }));

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('stranger/thing');
        expect(result.content[0].text).toContain('JULES_ALLOWED_REPOS');
        // Nothing was created or scheduled — the point of the guard.
        expect(client.createSession).not.toHaveBeenCalled();
        expect(manager.add).not.toHaveBeenCalled();
        // And the denial is on the record.
        expect(emitAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'DENY' }),
        );
    });

    // The negative control. Without it, a handler that errored for any other
    // reason would pass every assertion above.
    it.each(CASES)('%s allows a repo ON the list', async (name, args) => {
        process.env.JULES_ALLOWED_REPOS = 'avic/*';
        const { tools } = harness();

        const result: any = await tools
            .get(name)!
            .handler(args({ source: 'sources/github/avic/thing' }));

        expect(result.content[0].text).not.toContain('JULES_ALLOWED_REPOS');
        expect(emitAudit).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'DENY' }),
        );
    });

    it.each(CASES)(
        '%s is unrestricted when the var is unset',
        async (name, args) => {
            delete process.env.JULES_ALLOWED_REPOS;
            const { tools } = harness();

            const result: any = await tools
                .get(name)!
                .handler(args({ source: 'sources/github/anyone/anything' }));

            expect(result.content[0].text).not.toContain('JULES_ALLOWED_REPOS');
        },
    );

    // dry_run is a preview, not an exemption: a denied repo must be refused in
    // both modes, or the preview becomes a rehearsal for a request that would
    // be refused anyway.
    it.each([
        ['jules_create_session', CASES[0][1]],
        ['jules_schedule_task', CASES[2][1]],
    ] as [string, (e: object) => object][])(
        '%s refuses a denied repo even under dry_run',
        async (name, args) => {
            process.env.JULES_ALLOWED_REPOS = 'avic/*';
            const { tools } = harness();

            const result: any = await tools.get(name)!.handler(
                args({
                    source: 'sources/github/stranger/thing',
                    dry_run: true,
                }),
            );

            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('JULES_ALLOWED_REPOS');
        },
    );
});
