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
            tool: vi.fn(
                (
                    name: string,
                    _desc: string,
                    _schema: any,
                    handler: Function,
                ) => {
                    registeredTools.set(name, { handler });
                },
            ),
        };
        mockClient = {
            createSession: vi.fn().mockResolvedValue(mockSession),
            listSessions: vi
                .fn()
                .mockResolvedValue({ sessions: [mockSession] }),
            getSession: vi.fn().mockResolvedValue(mockSession),
            approvePlan: vi
                .fn()
                .mockResolvedValue({ ...mockSession, state: 'IN_PROGRESS' }),
            sendMessage: vi
                .fn()
                .mockResolvedValue({ ...mockSession, state: 'IN_PROGRESS' }),
            listActivities: vi.fn().mockResolvedValue({ activities: [] }),
            archiveSession: vi
                .fn()
                .mockResolvedValue({ ...mockSession, archived: true }),
            unarchiveSession: vi
                .fn()
                .mockResolvedValue({ ...mockSession, archived: false }),
            deleteSession: vi.fn().mockResolvedValue(undefined),
        };

        registerSessionTools(mockServer, mockClient as JulesClient);
    });

    it('registers all session tools', () => {
        expect(registeredTools.has('jules_create_session')).toBe(true);
        expect(registeredTools.has('jules_list_sessions')).toBe(true);
        expect(registeredTools.has('jules_get_session')).toBe(true);
        expect(registeredTools.has('jules_approve_plan')).toBe(true);
        expect(registeredTools.has('jules_send_message')).toBe(true);
        expect(registeredTools.has('jules_archive_session')).toBe(true);
        expect(registeredTools.has('jules_unarchive_session')).toBe(true);
        expect(registeredTools.has('jules_delete_session')).toBe(true);
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

    it('jules_create_session prepends standing guidance to the prompt', async () => {
        const handler = registeredTools.get('jules_create_session')!.handler;
        const result = await handler({
            prompt: 'fix bug',
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'testing',
            dry_run: true,
        });
        const sent = JSON.parse(result.content[0].text).would_request.body
            .prompt;
        expect(sent).toContain('fix bug');
        expect(sent).toContain('commented-out code');
        expect(sent.indexOf('commented-out code')).toBeLessThan(
            sent.indexOf('fix bug'),
        );
    });

    it('jules_create_session sends the bare prompt when guidance is opted out', async () => {
        const handler = registeredTools.get('jules_create_session')!.handler;
        const result = await handler({
            prompt: 'fix bug',
            source: 'sources/github/o/r',
            starting_branch: 'main',
            reason: 'testing',
            include_guidance: false,
            dry_run: true,
        });
        const sent = JSON.parse(result.content[0].text).would_request.body
            .prompt;
        expect(sent).toBe('fix bug');
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
        expect(emitAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                source: 'jules-mcp',
                category: 'coding-task',
                action: 'POST',
                reason: 'need to fix it',
            }),
        );
    });

    it('jules_approve_plan rejects when session is not AWAITING_PLAN_APPROVAL', async () => {
        // getSession returns IN_PROGRESS state, so approve should fail with state error
        const handler = registeredTools.get('jules_approve_plan')!.handler;
        const result = await handler({
            session_id: 'abc',
            reason: 'approving',
        });
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.status).toBe('ERROR');
        expect(parsed.code).toBe(409);
        expect(result.isError).toBe(true);
        expect(mockClient.approvePlan).not.toHaveBeenCalled();
    });

    // #30: the :sendMessage endpoint returns google.protobuf.Empty, so the
    // response carries no session fields. Reading session.sourceContext.source
    // for the audit entry threw AFTER the POST had already succeeded, so a
    // delivered message was reported to the caller as a hard 500.
    describe('jules_send_message with an empty API response', () => {
        it('succeeds and falls back to fetching the session', async () => {
            (mockClient.sendMessage as any).mockResolvedValue(undefined);
            const handler = registeredTools.get('jules_send_message')!.handler;
            const result = await handler({
                session_id: 'abc',
                message: 'please revert',
                reason: 'wrong premise',
            });
            expect(result.isError).toBeUndefined();
            expect(mockClient.getSession).toHaveBeenCalledWith('abc');
            expect(result.content[0].text).toContain('abc');
        });

        it('still reports success when the follow-up fetch fails', async () => {
            // The message was delivered; a failure to re-read the session
            // afterwards must not be reported as a failure to send.
            (mockClient.sendMessage as any).mockResolvedValue(undefined);
            (mockClient.getSession as any).mockRejectedValue(
                new Error('transient'),
            );
            const handler = registeredTools.get('jules_send_message')!.handler;
            const result = await handler({
                session_id: 'abc',
                message: 'please revert',
                reason: 'wrong premise',
            });
            expect(result.isError).toBeUndefined();
            expect(result.content[0].text).toMatch(/sent|delivered/i);
        });

        it('emits an audit entry even without a session payload', async () => {
            const { emitAudit } = await import('../../src/audit.js');
            (mockClient.sendMessage as any).mockResolvedValue(undefined);
            (mockClient.getSession as any).mockRejectedValue(
                new Error('transient'),
            );
            const handler = registeredTools.get('jules_send_message')!.handler;
            await handler({
                session_id: 'abc',
                message: 'please revert',
                reason: 'wrong premise',
            });
            expect(emitAudit).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'POST',
                    reason: 'wrong premise',
                }),
            );
        });
    });

    it('jules_get_session returns formatted session', async () => {
        const handler = registeredTools.get('jules_get_session')!.handler;
        const result = await handler({ session_id: 'abc' });
        expect(result.content[0].text).toContain('abc');
    });

    describe('jules_list_sessions options', () => {
        const sessA: Session = {
            ...mockSession,
            id: 'a',
            sourceContext: { source: 'sources/github/o/bfr-shift-dashboard' },
        };
        const sessB: Session = {
            ...mockSession,
            id: 'b',
            sourceContext: { source: 'sources/github/o/other-repo' },
        };
        const sessC: Session = {
            ...mockSession,
            id: 'c',
            sourceContext: { source: 'sources/github/o/bfr-shift-dashboard' },
        };

        it('filters by source across auto-followed pages', async () => {
            (mockClient.listSessions as any)
                .mockResolvedValueOnce({
                    sessions: [sessA, sessB],
                    nextPageToken: 'p2',
                })
                .mockResolvedValueOnce({ sessions: [sessC] });
            const handler = registeredTools.get('jules_list_sessions')!.handler;
            const result = await handler({ source: 'bfr-shift-dashboard' });
            const meta = JSON.parse(result.content[0].text.split('\n\n')[0]);
            // source set → default cap 10, so both pages are scanned, then filtered
            expect(mockClient.listSessions).toHaveBeenCalledTimes(2);
            expect(meta.count).toBe(2);
            expect(meta.scanned).toBe(3);
            expect(meta.filteredBy).toBe('bfr-shift-dashboard');
            expect(result.content[0].text).toContain('ID: a');
            expect(result.content[0].text).toContain('ID: c');
            expect(result.content[0].text).not.toContain('other-repo');
        });

        it('compact mode emits one line per session and no prompt block', async () => {
            (mockClient.listSessions as any).mockResolvedValue({
                sessions: [sessA, sessB],
            });
            const handler = registeredTools.get('jules_list_sessions')!.handler;
            const result = await handler({ compact: true });
            const body = result.content[0].text
                .split('\n\n')
                .slice(1)
                .join('\n\n')
                .trim();
            expect(body).toContain('o/bfr-shift-dashboard  ::');
            expect(body).not.toContain('Prompt:');
            expect(body.split('\n')).toHaveLength(2);
        });

        it('default call scans a single page and stays backward compatible', async () => {
            (mockClient.listSessions as any).mockResolvedValue({
                sessions: [sessA],
                nextPageToken: 'more',
            });
            const handler = registeredTools.get('jules_list_sessions')!.handler;
            const result = await handler({});
            const meta = JSON.parse(result.content[0].text.split('\n\n')[0]);
            expect(mockClient.listSessions).toHaveBeenCalledTimes(1);
            expect(meta.pagesFetched).toBe(1);
            expect(meta.nextPageToken).toBe('more');
            expect(result.content[0].text).toContain('Prompt:');
        });

        it('detect_changes annotates each session via listActivities', async () => {
            (mockClient.listSessions as any).mockResolvedValue({
                sessions: [sessA],
            });
            (mockClient.listActivities as any).mockResolvedValue({
                activities: [
                    {
                        name: 's/a/1',
                        id: '1',
                        createTime: 't',
                        originator: 'agent',
                        sessionCompleted: {},
                        artifacts: [
                            {
                                changeSet: {
                                    source: 'src',
                                    gitPatch: {
                                        unidiffPatch:
                                            'diff --git a/f.js b/f.js\n+x',
                                        baseCommitId: 'b',
                                        suggestedCommitMessage: 'm',
                                    },
                                },
                            },
                        ],
                    },
                ],
            });
            const handler = registeredTools.get('jules_list_sessions')!.handler;
            const result = await handler({
                detect_changes: true,
                compact: true,
            });
            expect(mockClient.listActivities).toHaveBeenCalledWith('a', 200);
            expect(result.content[0].text).toContain('(1 file)');
        });
    });

    describe('archive / unarchive / delete', () => {
        it('jules_archive_session archives and emits an audit', async () => {
            const { emitAudit } = await import('../../src/audit.js');
            const handler = registeredTools.get(
                'jules_archive_session',
            )!.handler;
            const result = await handler({
                session_id: 'abc',
                reason: 'reviewed and merged',
            });
            expect(mockClient.archiveSession).toHaveBeenCalledWith('abc');
            expect(result.content[0].text).toContain('Archived: true');
            expect(emitAudit).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'POST',
                    target: 'abc',
                    reason: 'reviewed and merged',
                }),
            );
        });

        it('jules_unarchive_session unarchives the session', async () => {
            const handler = registeredTools.get(
                'jules_unarchive_session',
            )!.handler;
            const result = await handler({
                session_id: 'abc',
                reason: 'reopening',
            });
            expect(mockClient.unarchiveSession).toHaveBeenCalledWith('abc');
            // archived:false → no "Archived: true" line
            expect(result.content[0].text).not.toContain('Archived: true');
        });

        it('jules_delete_session refuses without confirm_destructive', async () => {
            const handler = registeredTools.get(
                'jules_delete_session',
            )!.handler;
            const result = await handler({
                session_id: 'abc',
                reason: 'cleanup',
            });
            const parsed = JSON.parse(result.content[0].text);
            expect(parsed.status).toBe('CONFIRMATION_REQUIRED');
            expect(result.isError).toBe(true);
            expect(mockClient.deleteSession).not.toHaveBeenCalled();
        });

        it('jules_delete_session deletes when confirmed', async () => {
            const handler = registeredTools.get(
                'jules_delete_session',
            )!.handler;
            const result = await handler({
                session_id: 'abc',
                reason: 'cleanup',
                confirm_destructive: true,
            });
            const parsed = JSON.parse(result.content[0].text);
            expect(parsed.status).toBe('OK');
            expect(parsed.deleted).toBe('abc');
            expect(mockClient.deleteSession).toHaveBeenCalledWith('abc');
        });
    });
});

// #34: the strength label only helps if it survives into the rendered output.
// TypeScript cannot catch this half — `[{id, strength}].join(', ')` typechecks
// perfectly and renders "[object Object]" — so it is asserted on the string.
describe('jules_list_sessions duplicate rendering', () => {
    const sessionAt = (id: string, title: string): Session => ({
        name: `sessions/${id}`,
        id,
        prompt: 'p',
        title,
        sourceContext: { source: 'sources/github/Avicennasis/GrantLoft' },
        state: 'COMPLETED',
        createTime: '2026-01-01T00:00:00Z',
        updateTime: '2026-01-01T00:00:00Z',
        url: `https://jules.google/sessions/${id}`,
    });

    const patchAt = (start: number) =>
        [
            'diff --git a/public_html/lib/access-state.ts b/public_html/lib/access-state.ts',
            '--- a/public_html/lib/access-state.ts',
            '+++ b/public_html/lib/access-state.ts',
            `@@ -${start},6 +${start},8 @@`,
            '+  changed line',
        ].join('\n');

    const run = async (startA: number, startB: number) => {
        const registered = new Map<string, { handler: Function }>();
        const server = {
            tool: vi.fn((name: string, _d: string, _s: any, h: Function) => {
                registered.set(name, { handler: h });
            }),
        };
        const sessions = [
            sessionAt('pr316', 'Fix access state handling'),
            sessionAt('pr320', 'Fix access state checking'),
        ];
        const client = {
            listSessions: vi.fn().mockResolvedValue({ sessions }),
            listActivities: vi.fn(async (id: string) => ({
                activities: [
                    {
                        name: `sessions/${id}/activities/1`,
                        id: '1',
                        createTime: '2026-01-01T00:00:00Z',
                        originator: 'agent',
                        artifacts: [
                            {
                                changeSet: {
                                    source: 'sources/github/Avicennasis/GrantLoft',
                                    gitPatch: {
                                        unidiffPatch: patchAt(
                                            id === 'pr316' ? startA : startB,
                                        ),
                                        baseCommitId: 'abc',
                                        suggestedCommitMessage: 'm',
                                    },
                                },
                            },
                        ],
                    },
                ],
            })),
        } as unknown as JulesClient;
        registerSessionTools(server as any, client);
        const res = await registered.get('jules_list_sessions')!.handler({
            compact: true,
            detect_changes: true,
            detect_duplicates: true,
        });
        return res.content[0].text as string;
    };

    it('never renders raw objects into the output', async () => {
        const text = await run(360, 434);
        expect(text).not.toContain('[object Object]');
    });

    it('labels disjoint regions as same-file', async () => {
        const text = await run(360, 434);
        expect(text).toContain('same-file');
        expect(text).not.toContain('overlapping-hunks');
    });

    it('labels colliding regions as overlapping-hunks', async () => {
        const text = await run(360, 364);
        expect(text).toContain('overlapping-hunks');
    });
});

// #36: 37 of one repo's 104 sessions were AWAITING_USER_FEEDBACK, nearly all
// repeated persona runs annotated "(no changes)" — no PR, no diff, waiting on
// feedback nobody is going to give. Finding them meant listing everything and
// reading annotations by hand.
describe('jules_list_sessions stale_only (#36)', () => {
    const mk = (id: string, state: string): Session => ({
        name: `sessions/${id}`,
        id,
        prompt: 'p',
        title: `Session ${id}`,
        sourceContext: { source: 'sources/github/Avicennasis/GrantLoft' },
        state: state as Session['state'],
        createTime: '2026-01-01T00:00:00Z',
        updateTime: '2026-01-01T00:00:00Z',
        url: `https://jules.google/sessions/${id}`,
    });

    // awaiting + no diff (stale), awaiting + real diff (live), completed
    const SESSIONS = [
        mk('stale1', 'AWAITING_USER_FEEDBACK'),
        mk('stale2', 'AWAITING_USER_FEEDBACK'),
        mk('busy', 'AWAITING_USER_FEEDBACK'),
        mk('done', 'COMPLETED'),
    ];
    const WITH_DIFF = new Set(['busy', 'done']);

    const run = async (args: any, opts?: { failFetchFor?: string }) => {
        const registered = new Map<string, { handler: Function }>();
        const server = {
            tool: vi.fn((name: string, _d: string, _s: any, h: Function) => {
                registered.set(name, { handler: h });
            }),
        };
        const client = {
            listSessions: vi.fn().mockResolvedValue({ sessions: SESSIONS }),
            listActivities: vi.fn(async (id: string) => {
                if (opts?.failFetchFor === id) throw new Error('transient');
                return {
                    activities: WITH_DIFF.has(id)
                        ? [
                              {
                                  name: `sessions/${id}/activities/1`,
                                  id: '1',
                                  createTime: '2026-01-01T00:00:00Z',
                                  originator: 'agent',
                                  artifacts: [
                                      {
                                          changeSet: {
                                              source: 'sources/github/Avicennasis/GrantLoft',
                                              gitPatch: {
                                                  unidiffPatch:
                                                      'diff --git a/x.ts b/x.ts\n@@ -1,2 +1,3 @@\n+change',
                                                  baseCommitId: 'abc',
                                                  suggestedCommitMessage: 'm',
                                              },
                                          },
                                      },
                                  ],
                              },
                          ]
                        : [],
                };
            }),
        } as unknown as JulesClient;
        registerSessionTools(server as any, client);
        const res = await registered
            .get('jules_list_sessions')!
            .handler({ compact: true, ...args });
        return { text: res.content[0].text as string, client };
    };

    it('returns only awaiting-feedback sessions that produced no changes', async () => {
        const { text } = await run({ stale_only: true });
        expect(text).toContain('stale1');
        expect(text).toContain('stale2');
        expect(text).not.toContain('busy');
        expect(text).not.toContain('done');
    });

    it('implies detect_changes without the caller passing it', async () => {
        const { client } = await run({ stale_only: true });
        expect(client.listActivities).toHaveBeenCalled();
    });

    it('does not fetch activities for sessions already excluded by state', async () => {
        // State narrowing happens first, so COMPLETED costs no API call.
        const { client } = await run({ stale_only: true });
        const ids = (client.listActivities as any).mock.calls.map(
            (c: any[]) => c[0],
        );
        expect(ids).not.toContain('done');
    });

    it('excludes a session whose activities fetch failed', async () => {
        // No change data is not evidence of no changes.
        const { text } = await run(
            { stale_only: true },
            {
                failFetchFor: 'stale1',
            },
        );
        expect(text).not.toContain('stale1');
        expect(text).toContain('stale2');
    });

    it('state filter works on its own', async () => {
        const { text } = await run({ state: 'COMPLETED' });
        expect(text).toContain('done');
        expect(text).not.toContain('stale1');
    });

    it('state filter is case-insensitive', async () => {
        const { text } = await run({ state: 'completed' });
        expect(text).toContain('done');
    });

    it('returns everything when neither filter is set', async () => {
        const { text } = await run({});
        for (const s of SESSIONS) expect(text).toContain(s.id);
    });
});
