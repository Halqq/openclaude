# Tools System & Tool Registry — Comprehensive Report

## 1. Architecture Overview

### 1.1 The Tool Interface (`src/Tool.ts`)

Every tool in the codebase conforms to a generic `Tool<Input, Output, Progress>` type defined in `src/Tool.ts` (~803 lines). Key characteristics:

- **Generic typing**: `Tool<Input, Output, Progress>` — input is validated via Zod v4, output is arbitrary, progress is optional streaming data
- **~40+ properties/methods** spanning: identity, capability declarations, permission checking, rendering, execution, and result mapping
- **`buildTool<D>()` factory**: Merges a partial `ToolDef` with safe defaults to avoid boilerplate repetition

#### Core Properties

| Property | Purpose | Default |
|---|---|---|
| `name` | Internal identifier (e.g., `"Bash"`) | — |
| `inputSchema` | Zod v4 strict object for input validation | — |
| `call(input, context)` | Execution logic returning `ToolResult<Output>` | — |
| `isEnabled()` | Whether the tool appears in the tool pool | `true` |
| `isConcurrencySafe()` | Can run in parallel with other tools | `false` |
| `isReadOnly()` | Does not mutate state/filesystem | `false` |
| `isDestructive()` | Potentially irreversible operation | `false` |
| `checkPermissions()` | Returns `{ behavior: 'allow' \| 'deny' \| 'ask', ... }` | `{ behavior: 'allow' }` |
| `maxResultSizeChars` | Result size cap before disk spill | varies per tool |
| `userFacingName()` | Display name in UI | same as `name` |
| `description()` | Short description for model | — |
| `prompt()` | Extended usage instructions for model | — |
| `renderToolUseMessage()` | Custom UI rendering for tool invocation | `null` |
| `mapToolResultToToolResultBlockParam()` | Maps output to API response block | default mapper |

#### ToolResult Return Type

```typescript
type ToolResult<T> = {
  data: T                    // The actual output
  newMessages?: [...]        // Additional messages to inject
  contextModifier?(ctx)      // Mutate ToolUseContext between turns
  mcpMeta?: {...}            // MCP-specific metadata
}
```

#### `ToolUseContext`

Carries all runtime state into tool calls: options, abort controller, message history, app state, permission context, sandbox config, and more.

### 1.2 Schema Validation

All tool inputs use **Zod v4** (`z.strictObject()`) schemas. Many tools wrap schemas in `lazySchema()` to defer evaluation and avoid circular import issues during module initialization.

### 1.3 `buildTool` Pattern

```typescript
export const SomeTool = buildTool({
  name: 'SomeTool',
  // ... overrides
  async call(input, context) { ... }
} satisfies ToolDef<...>)
```

`buildTool` applies `TOOL_DEFAULTS` for any property not explicitly provided:
- `isEnabled: () => true`
- `isConcurrencySafe: () => false`
- `isReadOnly: () => false`
- `isDestructive: () => false`
- `checkPermissions: () => Promise.resolve({ behavior: 'allow', updatedInput: input })`

---

## 2. Registration Mechanism

### 2.1 Manual Array Assembly (`src/tools.ts`)

Tool registration is **not automatic or discovery-based**. The master tool array is assembled manually in `getAllBaseTools()` (~390 lines):

```typescript
function getAllBaseTools(): Tool<any, any, any>[] {
  return [
    BashTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    // ... ~40+ tools
    ...(feature('someFlag') ? [SomeExperimentalTool] : []),
    ...(process.env.USER_TYPE === 'ant' ? [AntOnlyTool] : []),
  ]
}
```

### 2.2 Feature Flag Gating

Tools are conditionally loaded via several mechanisms:

| Mechanism | Example |
|---|---|
| `feature()` (bun:bundle) | REPLTool, SuggestBackgroundPRTool, SleepTool, CronTools |
| `USER_TYPE === 'ant'` | RemoteTriggerTool, MonitorTool, SendUserFileTool, PushNotificationTool |
| Environment variables | SubscribePRTool, VerifyPlanExecutionTool, OverflowTestTool |
| `NODE_ENV === 'test'` | TestingPermissionTool |

### 2.3 MCP Tool Integration

External MCP (Model Context Protocol) tools are treated as first-class citizens:

- `assembleToolPool(builtInTools, mcpTools)` merges built-in + MCP tools
- **Name-based deduplication**: Built-in tools take precedence over MCP tools with the same name
- MCP tools are prefixed with `mcp__` in some contexts
- `MCPTool` wrapper adapts MCP tools to the internal `Tool` interface
- `McpAuthTool` handles OAuth flows for MCP servers
- `ListMcpResourcesTool` and `ReadMcpResourceTool` expose MCP resource discovery

### 2.4 Filtering Pipeline

```
getAllBaseTools()
  → filter by mode (simple mode, REPL mode)
  → filter by deny rules (getDenyRuleForTool)
  → assembleToolPool() — merge with MCP tools, deduplicate
  → apply defer logic (ToolSearchTool determines deferred vs eager schemas)
  → final ToolPool
```

### 2.5 Tool Presets

Only `'default'` preset is currently defined. Presets could theoretically enable/disable subsets of tools.

### 2.6 Deferred Schema Loading

`ToolSearchTool` enables lazy schema loading to reduce prompt size:
- `shouldDefer` flag marks tools whose schemas are not sent initially
- `alwaysLoad` flag marks tools that are always included regardless
- Model can discover deferred tools via the ToolSearch tool at runtime

---

## 3. Execution Flow

### 3.1 Single Tool Lifecycle (`src/services/tools/toolExecution.ts`, ~1746 lines)

```
1. Zod validation (inputSchema.safeParse)
2. Value validation (tool.validateInput if defined)
3. PreToolUse hooks (external interceptors)
4. Permission check (checkPermissions → resolveHookPermissionDecision)
5. tool.call(input, context) — actual execution
6. PostToolUse hooks (on success)
   OR PostToolUseFailure hooks (on error)
7. Result mapping (mapToolResultToToolResultBlockParam)
8. OTel span completion
9. Analytics event (tengu_tool_use_success/error/cancelled)
```

Key functions:
- `runToolUse()` — main entry point
- `checkPermissionsAndCallTool()` — full lifecycle orchestrator
- `classifyToolError()` — telemetry-safe error classification
- `buildSchemaNotSentHint()` — deferred schema error handling

### 3.2 Batch Orchestration (`src/services/tools/toolOrchestration.ts`, ~189 lines)

`runTools()` orchestrates multiple tool calls in a single turn:

1. **Partition**: `partitionToolCalls()` groups consecutive concurrency-safe tools into batches
2. **Execute**: Concurrent-safe batches run via `runToolsConcurrently()` (parallel), others via `runToolsSerially()` (sequential)
3. **Max concurrency**: `getMaxToolUseConcurrency()` — env var `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` or default 10

### 3.3 Streaming Executor (`src/services/tools/StreamingToolExecutor.ts`, ~531 lines)

`StreamingToolExecutor` class for streaming responses:

- **TrackedTool type**: Tracks id, block, status (`queued|executing|completed|yielded`), concurrency safety, promise, results, pending progress
- **Sibling abort**: Bash errors cancel sibling tool executions via abort controller
- **Progress yielding**: `progressAvailableResolve` signals when progress messages are available
- **discard()**: Cleanup method for streaming fallback scenarios

### 3.4 Concurrency Model

| Property | Effect |
|---|---|
| `isConcurrencySafe() === true` | Runs in parallel batches |
| `isConcurrencySafe() === false` | Runs serially |
| `isReadOnly() === true` | Safe in read-only modes |
| `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` | Caps parallel batch size (default: 10) |

---

## 4. Permissions Model

Tool permissions operate in **layers**, evaluated in order:

### 4.1 Layer 1: PreToolUse Hooks

External interceptors that can `allow`, `deny`, or `ask` before any tool executes. Hooks run first and can short-circuit the entire pipeline.

### 4.2 Layer 2: Deny Rules

Blanket tool-level denials via `getDenyRuleForTool()`. If a tool matches a deny rule, it is filtered out of the tool pool entirely (never appears in the model's available tools).

### 4.3 Layer 3: Auto-Mode Classifier

Built-in classifier that auto-decides `allow`/`deny`/`ask` based on:
- Tool type and input parameters
- Current permission mode (yolo, accept-warnings, default)
- Path semantics (destructive command detection for Bash)
- Sandbox configuration

### 4.4 Layer 4: Interactive Dialog

When classifier returns `{ behavior: 'ask' }`, a permission dialog is presented to the user. Tools can customize:
- The prompt message
- Whether to show on repeat calls
- Default selection (allow/deny)

### 4.5 Layer 5: PostToolUse Hooks

Run after tool execution (success or failure). Can inspect results and log/audit/block downstream effects.

### 4.6 Permission Modes

- **Yolo mode**: Auto-allow most tools
- **Accept-warnings**: Auto-allow read-only, prompt for destructive
- **Default**: Full permission evaluation

### 4.7 Agent-Specific Allowed Tools (`src/constants/tools.ts`)

Different agent modes have restricted tool sets:

| Constant | Tools Allowed |
|---|---|
| `ALL_AGENT_DISALLOWED_TOOLS` | TaskOutput, ExitPlanMode, EnterPlanMode, AskUserQuestion, TaskStop, AgentTool (non-ant), WorkflowTool |
| `ASYNC_AGENT_ALLOWED_TOOLS` | Read, WebSearch, TodoWrite, Grep, WebFetch, Glob, shell tools, Edit, Write, NotebookEdit, Skill, SyntheticOutput, ToolSearch, EnterWorktree, ExitWorktree |
| `IN_PROCESS_TEAMMATE_ALLOWED_TOOLS` | TaskCreate, TaskGet, TaskList, TaskUpdate, SendMessage, Cron tools |
| `COORDINATOR_MODE_ALLOWED_TOOLS` | AgentTool, TaskStop, SendMessage, SyntheticOutput |

---

## 5. Complete Tool Catalog

### 5.1 File Operations

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **FileReadTool** | Read files with offset/limit/pages (PDF, images, notebooks). Includes image compression, binary detection, memory freshness tracking | Yes | Yes |
| **FileWriteTool** | Write/create files with safety checks (overwrite warnings, path validation) | No | No |
| **FileEditTool** | Apply text edits (search/replace, line-based edits). Includes diff generation and conflict detection | No | No |
| **NotebookEditTool** | Edit Jupyter notebook cells (replace, insert, delete) | No | No |

### 5.2 Shell Operations

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **BashTool** | Execute shell commands with sandbox detection, destructive command warnings, path validation, sed validation, mode validation | No | No |
| **PowerShellTool** | Windows PowerShell execution (conditional on platform) | No | No |
| **REPLTool** | Interactive REPL session support (feature-gated) | No | No |

### 5.3 Search & Discovery

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **GrepTool** | Regex search across files (ripgrep-powered) | Yes | Yes |
| **GlobTool** | Filename pattern matching | Yes | Yes |
| **LSPTool** | Language Server Protocol queries (symbol lookup, diagnostics, hover) | Yes | No |
| **ToolSearchTool** | Deferred tool schema discovery — enables lazy loading of tool schemas | Yes | Yes |

### 5.4 Web & External

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **WebSearchTool** | Web search with domain filtering | Yes | Yes |
| **WebFetchTool** | Fetch URL content, HTML-to-markdown conversion | Yes | Yes |
| **McpAuthTool** | OAuth authentication for MCP servers | No | No |
| **ListMcpResourcesTool** | Discover MCP server resources | Yes | No |
| **ReadMcpResourceTool** | Read MCP resource data | Yes | No |
| **MCPTool** | Generic MCP tool adapter/wrapper | Varies | Varies |

### 5.5 Task Management

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **TaskCreateTool** | Create structured task with subject, description, dependencies | No | Yes |
| **TaskGetTool** | Retrieve task details by ID | Yes | Yes |
| **TaskListTool** | List all tasks with status/owner/dependencies | Yes | Yes |
| **TaskUpdateTool** | Update task status, owner, dependencies, metadata | No | Yes |
| **TaskOutputTool** | Output task results (typically for sub-agents) | No | No |
| **TaskStopTool** | Stop/cancel a running task | No | No |
| **TodoWriteTool** | Simple todo list management (lightweight task tracking) | No | Yes |

### 5.6 Team & Swarm

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **AgentTool** | Spawn sub-agent with isolated context (supports multiple built-in agents) | No | No |
| **TeamCreateTool** | Create a team of agents with coordination | No | No |
| **TeamDeleteTool** | Delete an existing team | No | No |
| **SendMessageTool** | Send messages between teammate agents | No | Yes |
| **SyntheticOutputTool** | Generate synthetic output (for coordinator pattern) | No | No |
| **SkillTool** | Invoke slash-command skills (e.g., /commit, /review-pr) | No | No |

#### AgentTool Built-in Agents
- `generalPurposeAgent` — Default agent
- `planAgent` — Planning mode
- `exploreAgent` — Codebase exploration
- `claudeCodeGuideAgent` — Documentation/guidance
- `verificationAgent` — Verification/validation
- Plus agents loaded dynamically from agents dir (`loadAgentsDir`)

### 5.7 Configuration & Settings

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **ConfigTool** | View/modify Claude Code configuration settings | No | No |

### 5.8 Mode Transitions

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **EnterPlanModeTool** | Switch to plan mode for structured planning | No | No |
| **ExitPlanModeV2Tool** | Exit plan mode, commit plan | No | No |
| **EnterWorktreeTool** | Create and enter an isolated git worktree | No | No |
| **ExitWorktreeTool** | Exit current git worktree | No | No |

### 5.9 Communication

| Tool | Description | Read-Only | Concurrency Safe |
|---|---|---|---|
| **AskUserQuestionTool** | Prompt the user for input/clarification | Yes | No |
| **BriefTool** | Generate and share briefs/summaries with attachments | No | No |

### 5.10 Experimental / Feature-Gated

| Tool | Description | Gating |
|---|---|---|
| **SleepTool** | Pause/delay execution | feature flag |
| **ScheduleCronTool** | Schedule cron-like recurring tasks | feature flag |
| **RemoteTriggerTool** | Trigger remote operations | USER_TYPE === 'ant' |
| **MonitorTool** | Monitoring/observability | USER_TYPE === 'ant' |
| **SendUserFileTool** | Send files to user | USER_TYPE === 'ant' |
| **PushNotificationTool** | Push notifications | USER_TYPE === 'ant' |
| **SubscribePRTool** | Subscribe to PR updates | env var |
| **VerifyPlanExecutionTool** | Verify plan execution correctness | env var |
| **OverflowTestTool** | Overflow testing | env var |
| **SuggestBackgroundPRTool** | Suggest background PRs | feature flag |
| **WorkflowTool** | Workflow orchestration | ALL_AGENT_DISALLOWED_TOOLS |
| **TungstenTool** | Tungsten-related operations | — |

### 5.11 Testing

| Tool | Description | Gating |
|---|---|---|
| **TestingPermissionTool** | Always triggers permission dialog for e2e testing | NODE_ENV === 'test' |

---

## 6. Shared Infrastructure (`src/tools/shared/`)

### 6.1 `spawnMultiAgent.ts` (~1176 lines)

Shared teammate spawning logic used by TeamCreateTool and AgentTool:

- **Three spawn modes**: split-pane, separate window, in-process
- **Model resolution**: `resolveTeammateModel()` handles `'inherit'` alias (case-insensitive), whitespace normalization, and allowlist validation via `isModelAllowed`
- **Name generation**: `generateUniqueTeammateName()` appends numeric suffix for duplicates
- **Team file management**: `ensureTeamFileExists()` auto-creates team file if missing
- **CLI flag propagation**: Permission mode, model, settings, plugins, chrome flags
- **Mailbox system**: Out-of-process teammates receive initial prompts via mailbox

### 6.2 `gitOperationTracking.ts` (~278 lines)

Shell-agnostic git operation detection for usage metrics:

- **Regex-based detection** on raw command text (works for Bash and PowerShell)
- **Tracks**: commit, amend, cherry-pick, push, merge, rebase, gh pr create/edit/merge/comment/close/ready
- **Structured results**: `detectGitOperation(command, output)` returns `{ commit?, push?, branch?, pr? }`
- **Analytics**: Increments OTLP counters (`getCommitCounter`, `getPrCounter`), fires `tengu_git_operation` events
- **PR linking**: Auto-links session to PR via `linkSessionToPR()` when PR URL detected in stdout
- **Curl detection**: Detects PR creation via curl POST to Bitbucket/GitHub/GitLab APIs

### 6.3 `resolveTeammateModel.test.ts`

Tests for model resolution behaviors:
- Whitespace normalization for input model
- Case-insensitive `'inherit'` handling
- Allowlist validation via `isModelAllowed`
- Fallback to hardcoded default when leader model is null

---

## 7. Key Architectural Insights

1. **No auto-discovery**: Tools are manually registered in `getAllBaseTools()`. Adding a new tool requires importing and adding it to the array.

2. **Two execution paths**: Batch orchestration (`runTools`) for non-streaming and `StreamingToolExecutor` for streaming responses with progress updates.

3. **MCP as first-class**: External MCP tools merge into the built-in pool with name-based deduplication. Built-in tools win on collision.

4. **Deferred schema loading**: `ToolSearchTool` reduces initial prompt size by deferring tool schemas. The model discovers tools lazily at runtime.

5. **Layered permissions**: Five-layer permission evaluation (PreToolUse hooks → deny rules → auto-classifier → interactive dialog → PostToolUse hooks) provides fine-grained control.

6. **Agent-scoped tool sets**: Different agent modes (async agent, in-process teammate, coordinator) have strictly bounded tool allowlists defined in `src/constants/tools.ts`.

7. **Context modifiers**: Tools can return `contextModifier` functions that mutate `ToolUseContext` between turns, enabling stateful tool interactions.

8. **Result size management**: Per-tool `maxResultSizeChars` caps; oversized results are persisted to disk with a reference returned instead of inline content.
