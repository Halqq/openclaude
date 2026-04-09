/**
 * Shutdown Escalation — cooperative shutdown with force_shutdown fallback.
 *
 * Sends a cooperative shutdown_request, waits for a response, and escalates
 * to force_shutdown if the teammate does not respond within the timeout.
 */

import { logForDebugging } from '../debug.js'
import { sleep } from '../sleep.js'
import {
  isShutdownApproved,
  isShutdownRejected,
  readMailbox,
  sendForceShutdownRequestToMailbox,
  sendShutdownRequestToMailbox,
} from '../teammateMailbox.js'
import { TEAM_LEAD_NAME } from './constants.js'

const DEFAULT_ESCALATION_TIMEOUT_MS = 30_000

/**
 * Sends a shutdown request with automatic escalation to force_shutdown
 * if the teammate does not respond within the timeout.
 *
 * @param targetName - Teammate to shut down
 * @param teamName - Team name
 * @param reason - Reason for shutdown
 * @param timeoutMs - Time to wait before escalating (default: 30s)
 */
export async function sendShutdownWithEscalation(params: {
  targetName: string
  teamName?: string
  reason?: string
  timeoutMs?: number
}): Promise<{ escalated: boolean; requestId: string }> {
  const {
    targetName,
    teamName,
    reason,
    timeoutMs = DEFAULT_ESCALATION_TIMEOUT_MS,
  } = params

  // Step 1: Send cooperative shutdown request
  const { requestId } = await sendShutdownRequestToMailbox(
    targetName,
    teamName,
    reason,
  )

  logForDebugging(
    `[shutdownEscalation] Sent shutdown_request to ${targetName} (request ${requestId}), will escalate after ${timeoutMs}ms`,
  )

  // Step 2: Wait for response
  await sleep(timeoutMs)

  // Step 3: Check if teammate responded
  const leaderInbox = await readMailbox(TEAM_LEAD_NAME, teamName)
  const responded = leaderInbox.some(m => {
    if (m.read) return false
    const approved = isShutdownApproved(m.text)
    const rejected = isShutdownRejected(m.text)
    if (!approved && !rejected) return false
    try {
      const parsed = JSON.parse(m.text)
      return parsed.requestId === requestId
    } catch {
      return false
    }
  })

  if (!responded) {
    logForDebugging(
      `[shutdownEscalation] No response from ${targetName} after ${timeoutMs}ms — escalating to force_shutdown`,
    )

    await sendForceShutdownRequestToMailbox(targetName, teamName, reason)

    return { escalated: true, requestId }
  }

  logForDebugging(
    `[shutdownEscalation] ${targetName} responded to shutdown request cooperatively`,
  )

  return { escalated: false, requestId }
}
