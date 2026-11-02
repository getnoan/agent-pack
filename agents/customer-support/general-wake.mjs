/**
 * Wake the general worker the moment code files a task for the agent to claim:
 * assigned to the agent, no trigger tag. The webhook route for this fires only
 * on a PERSON's edit, so without this a code-made task waits for the backstop
 * cron.
 *
 * Call it AFTER the task is complete (assigned last). The worker skips its claim
 * grace for code-created externalIds (cmd:, general:), so a run woken seconds
 * after the assign claims the task on arrival.
 *
 * Fail-soft, like every other dispatch in the fleet: a wake that is skipped or
 * fails only means the cron claims the task later. Active only where
 * GH_DISPATCH_PAT is set; the GITHUB_TOKEN cannot start a workflow run.
 */
export async function wakeGeneralWorker(taskId, { log = console.log, env = process.env, fetchImpl = fetch } = {}) {
  const pat = env.GH_DISPATCH_PAT;
  if (!pat) { log(`  general wake skipped (no GH_DISPATCH_PAT): the backstop cron will claim ${taskId}`); return false; }
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) { log(`  general wake skipped (no GITHUB_REPOSITORY): the backstop cron will claim ${taskId}`); return false; }
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ event_type: "general-task" }),
    });
    // 204 is success. Log anything else: an unauthorised PAT would otherwise
    // look exactly like a working wake until someone notices the cron doing it.
    if (r.ok) { log(`  ⏩ woke the general worker for ${taskId}`); return true; }
    log(`  warn: general wake returned ${r.status}: the backstop cron will claim ${taskId}`);
  } catch (e) {
    log(`  warn: general wake failed (${e.message}): the backstop cron will claim ${taskId}`);
  }
  return false;
}
