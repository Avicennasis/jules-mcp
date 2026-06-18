import cron, { type ScheduledTask } from 'node-cron';
import * as crypto from 'node:crypto';
import type { ScheduleEntry } from '../types.js';
import type { ScheduleStore } from './persistence.js';
import type { JulesClient } from '../jules-client.js';
import { emitAudit } from '../audit.js';

export class ScheduleManager {
  private readonly store: ScheduleStore;
  private readonly client: JulesClient;
  private readonly jobs: Map<string, ScheduledTask> = new Map();

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
    if (!cron.validate(input.cron)) {
      throw new Error(`Invalid cron expression: "${input.cron}"`);
    }

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
