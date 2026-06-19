#!/usr/bin/env tsx
import { JulesClient } from '../src/jules-client.js';
import type { Activity } from '../src/types.js';

const client = new JulesClient(process.env.JULES_API_KEY!);

const ids = process.argv.slice(2);

for (const id of ids) {
    const session = await client.getSession(id);
    const { activities } = await client.listActivities(id, 200);

    const changeActivities = activities.filter((a: Activity) =>
        a.artifacts?.some((art) => art.changeSet?.gitPatch),
    );
    const last = changeActivities[changeActivities.length - 1];

    console.log('\n========================================================');
    console.log(`TITLE: ${session.title}`);
    console.log(`ID: ${id}`);
    console.log(`URL: ${session.url}`);

    if (!last?.artifacts) {
        console.log('RESULT: PLAN ONLY — no code changes.');
        continue;
    }

    const files: string[] = [];
    let totalAdd = 0;
    let totalDel = 0;
    for (const art of last.artifacts) {
        const diff = art.changeSet?.gitPatch?.unidiffPatch ?? '';
        for (const line of diff.split('\n')) {
            if (line.startsWith('diff --git'))
                files.push(
                    line
                        .replace('diff --git ', '')
                        .split(' ')[0]
                        .replace('a/', ''),
                );
            else if (line.startsWith('+') && !line.startsWith('+++'))
                totalAdd++;
            else if (line.startsWith('-') && !line.startsWith('---'))
                totalDel++;
        }
    }
    console.log(`FILES: ${files.join(', ')}`);
    console.log(`LINES: +${totalAdd} -${totalDel}`);

    // Show non-test production hunks (manage.js / content.js / background.js)
    for (const art of last.artifacts) {
        const diff = art.changeSet?.gitPatch?.unidiffPatch ?? '';
        const isProd = diff.includes('a/src/');
        if (!isProd) continue;
        // print only src/ file hunks, code lines
        const lines = diff.split('\n');
        let inSrc = false;
        const out: string[] = [];
        for (const line of lines) {
            if (line.startsWith('diff --git')) inSrc = line.includes('a/src/');
            if (inSrc && /^[+-@]/.test(line) && !/^[+-]{3}/.test(line))
                out.push(line);
        }
        if (out.length) {
            console.log('--- PRODUCTION HUNKS ---');
            console.log(out.slice(0, 60).join('\n'));
            if (out.length > 60)
                console.log(`... (${out.length - 60} more lines)`);
        }
    }
}
