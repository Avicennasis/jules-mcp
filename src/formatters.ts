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
  const steps = [...plan.steps]
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
