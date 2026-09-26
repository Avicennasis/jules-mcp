import { describe, it, expect, afterEach } from 'vitest';
import {
    cronIntervalSeconds,
    checkCronInterval,
    minScheduleIntervalSeconds,
    DEFAULT_MIN_SCHEDULE_INTERVAL_SECONDS,
} from '../src/scheduler/cron-interval.js';

describe('cronIntervalSeconds', () => {
    it('minutely is 60s', () => {
        expect(cronIntervalSeconds('* * * * *')?.intervalSeconds).toBe(60);
    });

    it('hourly is 3600s', () => {
        expect(cronIntervalSeconds('0 * * * *')?.intervalSeconds).toBe(3600);
    });

    it('twice-hourly is 1800s', () => {
        expect(cronIntervalSeconds('0,30 * * * *')?.intervalSeconds).toBe(1800);
    });

    it('every 2 hours is 7200s', () => {
        expect(cronIntervalSeconds('0 */2 * * *')?.intervalSeconds).toBe(7200);
    });

    it('a weekly expression is week-scale, never sub-hourly', () => {
        const iv = cronIntervalSeconds('0 9 * * 1')?.intervalSeconds ?? null;
        expect(iv === null || iv >= 3600).toBe(true);
    });

    it('a 6-field per-second expression is 1s — the hourly-looking trap', () => {
        // node-cron accepts an optional seconds field, so this looks hourly to
        // a human reading only the last five fields.
        expect(cronIntervalSeconds('* * * * * *')?.intervalSeconds).toBe(1);
    });

    it('a 6-field per-5-seconds expression is 5s', () => {
        expect(cronIntervalSeconds('*/5 * * * * *')?.intervalSeconds).toBe(5);
    });

    it('a 6-field HOURLY expression is 3600s (seconds fixed)', () => {
        expect(cronIntervalSeconds('0 0 * * * *')?.intervalSeconds).toBe(3600);
    });

    it('a 6-field per-minute expression is 60s', () => {
        expect(cronIntervalSeconds('0 * * * * *')?.intervalSeconds).toBe(60);
    });

    it('parses names (MON)', () => {
        const iv = cronIntervalSeconds('0 9 * * MON')?.intervalSeconds ?? null;
        expect(iv === null || iv >= 3600).toBe(true);
    });

    it('returns null for an expression it cannot parse', () => {
        expect(cronIntervalSeconds('not a cron')).toBeNull();
        expect(cronIntervalSeconds('99 99 * * *')).toBeNull();
    });
});

describe('minScheduleIntervalSeconds', () => {
    const ORIG = process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
    afterEach(() => {
        if (ORIG === undefined)
            delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
        else process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS = ORIG;
    });

    it('defaults to hourly', () => {
        delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
        expect(minScheduleIntervalSeconds()).toBe(
            DEFAULT_MIN_SCHEDULE_INTERVAL_SECONDS,
        );
    });

    it('honours the env override', () => {
        process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS = '300';
        expect(minScheduleIntervalSeconds()).toBe(300);
    });

    it('falls back to the default on an invalid value', () => {
        process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS = 'nonsense';
        expect(minScheduleIntervalSeconds()).toBe(
            DEFAULT_MIN_SCHEDULE_INTERVAL_SECONDS,
        );
    });
});

describe('checkCronInterval', () => {
    const ORIG = process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
    afterEach(() => {
        if (ORIG === undefined)
            delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
        else process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS = ORIG;
    });

    it('rejects a minutely schedule and reports both intervals', () => {
        delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
        const v = checkCronInterval('* * * * *');
        expect(v.ok).toBe(false);
        expect(v.intervalSeconds).toBe(60);
        expect(v.minimumSeconds).toBe(3600);
        expect(v.message).toContain('60');
        expect(v.message).toContain('3600');
    });

    it('rejects a 6-field per-second schedule', () => {
        const v = checkCronInterval('*/1 * * * * *');
        expect(v.ok).toBe(false);
        expect(v.intervalSeconds).toBe(1);
    });

    it('accepts an hourly schedule (equal to the minimum)', () => {
        delete process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
        expect(checkCronInterval('0 * * * *').ok).toBe(true);
    });

    it('accepts a week-scale schedule with no computable interval', () => {
        expect(checkCronInterval('0 9 * * 1').ok).toBe(true);
    });

    it('respects a lowered minimum from the env', () => {
        process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS = '60';
        expect(checkCronInterval('* * * * *').ok).toBe(true);
    });
});
