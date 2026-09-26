// Pure cron-interval computation for the schedule gate (#50433).
//
// Why this exists: `jules_schedule_task` validated that a cron expression
// PARSES, not that it is SANE. `* * * * *` parses and then fires 1,440 Jules
// sessions a day, unattended -- the scheduler is in-process and nobody is
// watching. Syntactic validity is not safety.
//
// This computes the minimum interval between consecutive fires by scanning a
// bounded window at the expression's own granularity, so it needs no live job
// (the surveyed implementation created and cancelled a real job just to test
// validity -- a validity check with a side effect). It is deliberately PURE:
// no I/O, no timers, no node-cron state.

const MONTHS: Record<string, number> = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
};
const DOWS: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
};

interface CronSpec {
    hasSeconds: boolean;
    seconds: Set<number>;
    minutes: Set<number>;
    hours: Set<number>;
    doms: Set<number>;
    months: Set<number>;
    dows: Set<number>;
    /** dom and dow are BOTH restricted -> cron uses OR, not AND. */
    domRestricted: boolean;
    dowRestricted: boolean;
}

/** Parse one cron field into the set of values it matches, or null. */
function parseField(
    field: string,
    min: number,
    max: number,
    names?: Record<string, number>,
): Set<number> | null {
    const out = new Set<number>();
    const toNum = (token: string): number | null => {
        const t = token.trim().toLowerCase();
        if (names && t in names) return names[t];
        if (!/^\d+$/.test(t)) return null;
        return parseInt(t, 10);
    };

    for (const part of field.split(',')) {
        const [rangePart, stepPart] = part.split('/');
        let step = 1;
        if (stepPart !== undefined) {
            if (!/^\d+$/.test(stepPart)) return null;
            step = parseInt(stepPart, 10);
            if (step < 1) return null;
        }

        let lo: number;
        let hi: number;
        if (rangePart === '*' || rangePart === '') {
            lo = min;
            hi = max;
        } else if (rangePart.includes('-')) {
            const [a, b] = rangePart.split('-');
            const an = toNum(a);
            const bn = toNum(b);
            if (an === null || bn === null) return null;
            lo = an;
            hi = bn;
        } else {
            const n = toNum(rangePart);
            if (n === null) return null;
            // `A/n` (a bare value with a step) means A..max step n, matching
            // Vixie cron; a bare value without a step is just {A}.
            lo = n;
            hi = stepPart !== undefined ? max : n;
        }

        if (lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
}

function parseCron(expr: string): CronSpec | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5 && fields.length !== 6) return null;
    const hasSeconds = fields.length === 6;
    const [sec, min, hour, dom, mon, dow] = hasSeconds
        ? fields
        : ['0', ...fields];

    const seconds = parseField(sec, 0, 59);
    const minutes = parseField(min, 0, 59);
    const hours = parseField(hour, 0, 23);
    const doms = parseField(dom, 1, 31);
    const months = parseField(mon, 1, 12, MONTHS);
    const dows = parseField(dow, 0, 7, DOWS);
    if (!seconds || !minutes || !hours || !doms || !months || !dows) {
        return null;
    }
    // Cron names Sunday both 0 and 7 (and ranges may use 7).
    if (dows.has(7)) {
        dows.add(0);
        dows.delete(7);
    }
    return {
        hasSeconds,
        seconds,
        minutes,
        hours,
        doms,
        months,
        dows,
        domRestricted: dom !== '*',
        dowRestricted: dow !== '*',
    };
}

function specMatches(spec: CronSpec, d: Date, second: number): boolean {
    if (spec.hasSeconds && !spec.seconds.has(second)) return false;
    if (!spec.minutes.has(d.getUTCMinutes())) return false;
    if (!spec.hours.has(d.getUTCHours())) return false;
    if (!spec.months.has(d.getUTCMonth() + 1)) return false;

    const domMatch = spec.doms.has(d.getUTCDate());
    const dowMatch = spec.dows.has(d.getUTCDay());
    // Standard cron: when BOTH day fields are restricted they are OR'd.
    if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
    if (spec.domRestricted) return domMatch;
    if (spec.dowRestricted) return dowMatch;
    return true;
}

export interface CronInterval {
    /** Minimum seconds between consecutive fires; null if fewer than two fires
     * fall inside the scan window (i.e. it is at least week-scale). */
    intervalSeconds: number | null;
    /** How many fires were seen in the window — 0 or 1 means "long/unknown". */
    firesInWindow: number;
}

/**
 * Compute the minimum interval between fires for a cron expression, or null if
 * the expression cannot be parsed (callers should then fall back to
 * `cron.validate` only). Pure and bounded.
 */
export function cronIntervalSeconds(expr: string): CronInterval | null {
    const spec = parseCron(expr);
    if (!spec) return null;

    const secondGranular = spec.seconds.size > 1;
    const stepMs = secondGranular ? 1000 : 60_000;
    const horizonMs = secondGranular ? 120_000 : 7 * 24 * 3600_000;
    const fixedSecond = spec.seconds.size === 1 ? [...spec.seconds][0] : 0;

    // Align to the next whole step, in UTC. Gaps are offset-invariant, so UTC
    // is fine even though node-cron schedules in local time.
    let t = Math.floor(Date.now() / stepMs) * stepMs + stepMs;
    const end = t + horizonMs;
    let prev: number | null = null;
    let minGap: number | null = null;
    let fires = 0;
    for (; t <= end; t += stepMs) {
        const d = new Date(t);
        const second = secondGranular ? d.getUTCSeconds() : fixedSecond;
        if (!specMatches(spec, d, second)) continue;
        fires++;
        if (prev !== null) {
            const gap = (t - prev) / 1000;
            if (minGap === null || gap < minGap) minGap = gap;
        }
        prev = t;
    }
    return { intervalSeconds: minGap, firesInWindow: fires };
}

export const DEFAULT_MIN_SCHEDULE_INTERVAL_SECONDS = 3600;

/** The configured minimum schedule interval, in seconds. */
export function minScheduleIntervalSeconds(): number {
    const raw = process.env.JULES_SCHEDULE_MIN_INTERVAL_SECONDS;
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_MIN_SCHEDULE_INTERVAL_SECONDS;
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        return DEFAULT_MIN_SCHEDULE_INTERVAL_SECONDS;
    }
    return n;
}

export interface CronIntervalVerdict {
    ok: boolean;
    intervalSeconds: number | null;
    minimumSeconds: number;
    message: string;
}

/**
 * Decide whether a cron expression fires often enough to be safe. An expression
 * whose interval cannot be computed (unparseable, or week-scale) passes — the
 * gate exists to catch sub-hourly bursts, not to invent a verdict it cannot
 * support.
 */
export function checkCronInterval(expr: string): CronIntervalVerdict {
    const minimumSeconds = minScheduleIntervalSeconds();
    const computed = cronIntervalSeconds(expr);
    const intervalSeconds = computed?.intervalSeconds ?? null;
    if (intervalSeconds !== null && intervalSeconds < minimumSeconds) {
        return {
            ok: false,
            intervalSeconds,
            minimumSeconds,
            message:
                `Cron fires every ${intervalSeconds}s, below the minimum of ` +
                `${minimumSeconds}s. Increase the interval or lower ` +
                `JULES_SCHEDULE_MIN_INTERVAL_SECONDS.`,
        };
    }
    return {
        ok: true,
        intervalSeconds,
        minimumSeconds,
        message: 'ok',
    };
}
