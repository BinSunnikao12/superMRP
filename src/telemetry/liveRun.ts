import { bus } from "./eventWriter.js";
import type { LiveRun, RunEvent, RunId } from "./eventTypes.js";
import type { RoleName, AccountId } from "../roles.js";
import { emptyRoleTokens } from "../roles.js";

const liveRuns = new Map<RunId, LiveRun>();

function touch(runId: RunId, projectId: string, ts: number): LiveRun {
  let r = liveRuns.get(runId);
  if (!r) {
    r = {
      runId,
      projectId,
      goal: "",
      startedAt: ts,
      currentRound: 0,
      totalTokens: 0,
      perAccount: {},
      perRole: emptyRoleTokens(),
      state: "running",
    };
    liveRuns.set(runId, r);
  }
  return r;
}

bus.on("event", (e: RunEvent) => {
  const r = touch(e.runId, e.projectId, e.ts);

  switch (e.type) {
    case "run.start":
      r.goal = e.goal;
      break;
    case "run.round":
      r.currentRound = e.round;
      break;
    case "run.task.done": {
      const tokens = e.inputTokens + e.outputTokens;
      r.totalTokens += tokens;
      r.perAccount[e.accountId as AccountId] = (r.perAccount[e.accountId as AccountId] ?? 0) + tokens;
      r.perRole[e.role] = (r.perRole[e.role] ?? 0) + tokens;
      break;
    }
    case "run.done":
      r.state = "done";
      r.doneReason = e.reason;
      setTimeout(() => liveRuns.delete(e.runId), 5 * 60_000);
      break;
    case "run.task.error":
    case "account.exhausted":
    case "run.task.start":
    case "run.task.text":
    case "run.task.tool":
    case "run.round.done":
      break;
  }
});

export function getLiveRun(runId: RunId): LiveRun | undefined {
  return liveRuns.get(runId);
}

export function listLiveRuns(): LiveRun[] {
  return Array.from(liveRuns.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export type { LiveRun };
