# agentsnap

Snapshot testing for AI coding agents. Record agent sessions, replay them, and diff the results to catch behavior regressions when you change models, skills, or prompts.

## Why?

You upgrade from Claude Sonnet to Opus. You swap a skill. You tweak a system prompt. Suddenly your agent starts missing edge cases, using wrong patterns, or hallucinating imports. You only find out when it breaks something in production.

Existing eval tools (Promptfoo, DeepEval, LangSmith) test LLM outputs in isolation. Nobody does **snapshot-style behavior regression testing** for coding agents against real tasks.

agentsnap lets you:

- **Record** coding agent sessions (tool calls, file reads/writes, decisions)
- **Store** snapshots with task names and tags
- **Diff** two snapshots to see exactly what changed
- **Detect regressions** automatically (new errors, missing tool calls, file changes)

## Install

```bash
npm install -g agentsnap
```

## Quick Start

```bash
# Initialize in your project
agentsnap init

# Record a session from agent JSONL output
agentsnap record session.jsonl -t "add auth middleware" -a codex

# Record with tags
agentsnap record baseline.jsonl -t "add auth middleware" --tags baseline,claude-sonnet

# List snapshots
agentsnap list

# Compare two snapshots
agentsnap diff snap_001 snap_002

# View snapshot history for a task
agentsnap history "add auth middleware"
```

## How It Works

1. **Record**: Feed your agent's JSONL output (stdout, log files) to `agentsnap record`. It parses tool calls, file operations, errors, and timing.

2. **Snapshot**: Sessions are stored as JSONL in `.agentsnap/` with metadata (task, agent, tags, timestamp).

3. **Diff**: Compare any two snapshots. agentsnap computes:
   - Tool call changes (added, removed, modified)
   - File operation changes
   - Error count differences
   - Timing differences
   - **Similarity score** (Jaccard on tool call signatures)
   - **Regression detection** (automatic, configurable threshold)

4. **CI Mode**: Use `--json` output and `--threshold` to fail CI when behavior drifts.

## Supported Agent Formats

agentsnap auto-detects the format:

| Format | Agents |
|--------|--------|
| `codex` | OpenAI Codex CLI |
| `claude-code` | Claude Code |
| `cursor` | Cursor |
| `generic` | Any JSONL with `{ type, timestamp, data }` |

If your agent outputs JSONL, agentsnap can probably handle it.

## Diff Output Example

```
Diff: snap_baseline → snap_new
Similarity: 72.3%

⚠  REGRESSION DETECTED:
   • Low similarity score: 72.3% (threshold: 70%)
   • Error count increased by 2
   • 1 file-modifying tool calls changed

Tool Calls: 2 added, 1 removed, 1 changed
Files: 1 added, 0 removed, 2 modified
Errors: +2
Success changed: YES
Duration: +12.4s (+28.3%)

Changed tool calls:
  [CHANGED] Edit (input, output)
  [ADDED] Bash

File changes:
  [ADDED] src/new-module.ts
  [MODIFIED] src/auth.ts
```

## Use Cases

**Model upgrades**: Record with GPT-4, replay with GPT-4.1, diff to see behavior changes.

**Skill changes**: Before/after snapshots when adding or modifying agent skills.

**Prompt regression**: Catch when a system prompt tweak causes the agent to miss steps.

**CI/CD**: Run agentsnap in your pipeline to alert when agent behavior drifts from baseline.

## Configuration

`agentsnap.json` (created by `agentsnap init`):

```json
{
  "snapshotsDir": ".agentsnap",
  "defaultFormat": "auto",
  "similarityThreshold": 0.7,
  "ignoreTools": [],
  "ignorePaths": []
}
```

## CLI Reference

```
agentsnap init                    Initialize agentsnap in project
agentsnap record <file> -t <task> Record a session from JSONL file
agentsnap list                    List all snapshots
agentsnap show <id>               Show snapshot details
agentsnap diff <id1> <id2>        Compare two snapshots
agentsnap remove <id>             Delete a snapshot
agentsnap history <task>          Show snapshot history for a task

Options:
  -t, --task <name>      Task name
  -a, --agent <name>     Agent name
  -f, --format <fmt>     Input format: auto|codex|claude-code|cursor|generic
  --threshold <0-1>      Similarity threshold (default: 0.7)
  --json                  Output as JSON
  --tags <tags>           Comma-separated tags
```

## License

MIT
