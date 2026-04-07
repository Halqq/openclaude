/**
 * Tests for writeToMailbox retry logic (Issue #1 — message loss under lock contention).
 *
 * The fix adds an outer retry loop so that if proper-lockfile exhausts its
 * inner retries and throws, the write is attempted again (up to
 * MAILBOX_WRITE_MAX_ATTEMPTS total) instead of being silently discarded.
 */

import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// --- module mocks (must be at top level, before any imports of the module under test) ---

const mockLock = mock(async (_file: string, _opts?: unknown) => {
  return async () => {}
})

mock.module('./lockfile.js', () => ({
  lock: mockLock,
  lockSync: mock(() => () => {}),
  unlock: mock(async () => {}),
  check: mock(async () => false),
}))

const mockLogError = mock((_err: unknown) => {})
mock.module('./log.js', () => ({
  logError: mockLogError,
  log: mock(() => {}),
}))

mock.module('./debug.js', () => ({
  logForDebugging: mock(() => {}),
}))

// sleep is imported by teammateMailbox; replace with instant no-op so tests run fast
mock.module('./sleep.js', () => ({
  sleep: mock(async (_ms: number) => {}),
  withTimeout: mock(async (p: Promise<unknown>) => p),
}))

// teammate helpers – keep simple, deterministic values
mock.module('./teammate.js', () => ({
  getTeamName: mock(() => 'test-team'),
  getAgentName: mock(() => 'test-agent'),
  getTeammateColor: mock(() => undefined),
}))

// import AFTER all mock.module() calls
import {
  writeToMailbox,
  readMailbox,
  type TeammateMessage,
} from './teammateMailbox.js'

// ---------------------------------------------------------------------------

let tmpDir: string

beforeEach(async () => {
  tmpDir = join(tmpdir(), `mailbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(join(tmpDir, 'teams', 'test-team', 'inboxes'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  mockLock.mockClear()
  mockLogError.mockClear()
})

afterEach(async () => {
  delete process.env.CLAUDE_CONFIG_DIR
  await rm(tmpDir, { recursive: true, force: true })
})

const baseMessage = {
  from: 'sender',
  text: 'hello',
  timestamp: '2026-01-01T00:00:00.000Z',
  color: undefined,
  summary: undefined,
} as const

// ---------------------------------------------------------------------------

describe('writeToMailbox — lock succeeds immediately', () => {
  test('writes the message to the inbox file', async () => {
    await writeToMailbox('leader', baseMessage, 'test-team')

    const messages = await readMailbox('leader', 'test-team')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('hello')
    expect(messages[0]?.read).toBe(false)
  })

  test('appends to existing messages', async () => {
    await writeToMailbox('leader', baseMessage, 'test-team')
    await writeToMailbox('leader', { ...baseMessage, text: 'second' }, 'test-team')

    const messages = await readMailbox('leader', 'test-team')
    expect(messages).toHaveLength(2)
    expect(messages[1]?.text).toBe('second')
  })
})

// ---------------------------------------------------------------------------

describe('writeToMailbox — lock fails then succeeds (retry logic)', () => {
  test('succeeds on second attempt when lock fails once', async () => {
    let callCount = 0
    mockLock.mockImplementation(async () => {
      callCount++
      if (callCount === 1) throw new Error('ELOCKED: lock already held')
      return async () => {}
    })

    await writeToMailbox('leader', baseMessage, 'test-team')

    expect(callCount).toBe(2)
    const messages = await readMailbox('leader', 'test-team')
    expect(messages).toHaveLength(1)
    expect(messages[0]?.text).toBe('hello')
    expect(mockLogError).not.toHaveBeenCalled()
  })

  test('succeeds on third attempt when lock fails twice', async () => {
    let callCount = 0
    mockLock.mockImplementation(async () => {
      callCount++
      if (callCount < 3) throw new Error('ELOCKED: lock already held')
      return async () => {}
    })

    await writeToMailbox('leader', baseMessage, 'test-team')

    expect(callCount).toBe(3)
    const messages = await readMailbox('leader', 'test-team')
    expect(messages).toHaveLength(1)
    expect(mockLogError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------

describe('writeToMailbox — all attempts fail', () => {
  test('logs error when all lock attempts are exhausted', async () => {
    mockLock.mockImplementation(async () => {
      throw new Error('ELOCKED: lock always fails')
    })

    await writeToMailbox('leader', baseMessage, 'test-team')

    // Must have tried MAILBOX_WRITE_MAX_ATTEMPTS (4) times
    expect(mockLock.mock.calls.length).toBe(4)
    // Error must be reported — message was not silently discarded
    expect(mockLogError).toHaveBeenCalledTimes(1)
    // No message written
    const messages = await readMailbox('leader', 'test-team')
    expect(messages).toHaveLength(0)
  })
})
