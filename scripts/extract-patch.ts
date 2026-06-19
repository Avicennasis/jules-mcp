#!/usr/bin/env tsx
// Extract the final cumulative git patch(es) from a Jules session to stdout.
import { JulesClient } from '../src/jules-client.js';
import type { Activity } from '../src/types.js';

const client = new JulesClient(process.env.JULES_API_KEY!);
const id = process.argv[2];
const { activities } = await client.listActivities(id, 200);
const changeActivities = activities.filter((a: Activity) =>
    a.artifacts?.some((art) => art.changeSet?.gitPatch),
);
const last = changeActivities[changeActivities.length - 1];
if (!last?.artifacts) {
    console.error('No changeset in session', id);
    process.exit(2);
}
for (const art of last.artifacts) {
    if (art.changeSet?.gitPatch?.unidiffPatch) {
        process.stdout.write(art.changeSet.gitPatch.unidiffPatch);
        if (!art.changeSet.gitPatch.unidiffPatch.endsWith('\n'))
            process.stdout.write('\n');
    }
}
