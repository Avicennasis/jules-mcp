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
