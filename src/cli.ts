#!/usr/bin/env node
/**
 * agentsnap — CLI for agent snapshot testing
 */

import * as fs from 'fs';
import * as path from 'path';
import { recordFromText, recordFromFile } from './recorder.js';
import { diffSessions } from './differ.js';
import {
  init, loadConfig, createSnapshot, listSnapshots,
  loadSnapshot, deleteSnapshot, findSnapshotsByTask,
} from './snapshots.js';
import { AgentFormat, SessionDiff } from './types.js';

const args = process.argv.slice(2);
const command = args[0];
const projectDir = process.cwd();

function usage(): never {
  console.log(`agentsnap — snapshot testing for AI coding agents

Usage:
  agentsnap init                    Initialize agentsnap in project
  agentsnap record <file> -t <task> Record a session from JSONL file
  agentsnap list                    List all snapshots
  agentsnap show <id>               Show snapshot details
  agentsnap diff <id1> <id2>        Compare two snapshots
  agentsnap remove <id>             Delete a snapshot
  agentsnap history <task>          Show snapshot history for a task

Options:
  -t, --task <name>      Task name for the session
  -a, --agent <name>     Agent name (default: unknown)
  -f, --format <fmt>     Input format: auto|codex|claude-code|cursor|generic
  --threshold <0-1>      Similarity threshold (default: 0.7)
  --json                  Output as JSON
  --tags <tags>           Comma-separated tags for snapshot
`);
  process.exit(0);
}

function parseOpts(argList: string[]): Record<string, string | boolean> {
  const opts: Record<string, string | boolean> = {};
  for (let i = 0; i < argList.length; i++) {
    if (argList[i].startsWith('--')) {
      const key = argList[i].slice(2);
      if (i + 1 < argList.length && !argList[i + 1].startsWith('-')) {
        opts[key] = argList[++i];
      } else {
        opts[key] = true;
      }
    } else if (argList[i].startsWith('-') && argList[i].length === 2) {
      const key = argList[i].slice(1);
      if (i + 1 < argList.length && !argList[i + 1].startsWith('-')) {
        opts[key] = argList[++i];
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function formatDiffOutput(diff: SessionDiff, json: boolean): string {
  if (json) return JSON.stringify(diff, null, 2);

  const lines: string[] = [];
  const s = diff.summary;

  lines.push(`Diff: ${diff.baselineId} → ${diff.currentId}`);
  lines.push(`Similarity: ${(s.similarityScore * 100).toFixed(1)}%`);
  lines.push('');

  if (diff.regressionDetected) {
    lines.push('⚠  REGRESSION DETECTED:');
    for (const r of diff.regressionReasons) lines.push(`   • ${r}`);
    lines.push('');
  } else {
    lines.push('✓ No regression detected');
    lines.push('');
  }

  lines.push(`Tool Calls: ${s.toolCallsAdded} added, ${s.toolCallsRemoved} removed, ${s.toolCallsChanged} changed`);
  lines.push(`Files: ${s.filesAdded} added, ${s.filesRemoved} removed, ${s.filesModified} modified`);
  lines.push(`Errors: ${s.errorCountDiff > 0 ? '+' : ''}${s.errorCountDiff}`);
  lines.push(`Success changed: ${s.successChanged ? 'YES' : 'no'}`);
  lines.push(`Duration: ${diff.timingDiff.diff_ms > 0 ? '+' : ''}${diff.timingDiff.diff_ms}ms (${diff.timingDiff.percentChange > 0 ? '+' : ''}${diff.timingDiff.percentChange.toFixed(1)}%)`);

  if (diff.toolCallChanges.some(tc => tc.change !== 'unchanged')) {
    lines.push('');
    lines.push('Changed tool calls:');
    for (const tc of diff.toolCallChanges) {
      if (tc.change !== 'unchanged') {
        lines.push(`  [${tc.change.toUpperCase()}] ${tc.tool} ${tc.fieldChanges.length > 0 ? `(${tc.fieldChanges.join(', ')})` : ''}`);
      }
    }
  }

  if (diff.fileChanges.some(f => f.change !== 'unchanged')) {
    lines.push('');
    lines.push('File changes:');
    for (const f of diff.fileChanges) {
      if (f.change !== 'unchanged') {
        lines.push(`  [${f.change.toUpperCase()}] ${f.path}`);
      }
    }
  }

  return lines.join('\n');
}

async function main() {
  if (!command || command === 'help' || command === '--help') usage();

  switch (command) {
    case 'init': {
      const config = init(projectDir);
      console.log(`Initialized agentsnap in ${projectDir}`);
      console.log(`Snapshots dir: ${config.snapshotsDir}/`);
      break;
    }

    case 'record': {
      const opts = parseOpts(args.slice(1));
      const file = args[1];
      if (!file) { console.error('Error: provide a JSONL file path'); process.exit(1); }
      const task = typeof opts.t === 'string' ? opts.t : typeof opts.task === 'string' ? (opts.task as string) : '';
      if (!task) { console.error('Error: provide task name with -t <task>'); process.exit(1); }
      const agent = typeof opts.a === 'string' ? opts.a : typeof opts.agent === 'string' ? (opts.agent as string) : 'unknown';
      const format = (typeof opts.f === 'string' ? opts.f : typeof opts.format === 'string' ? opts.format : 'auto') as AgentFormat;
      const tags = typeof opts.tags === 'string' ? (opts.tags as string).split(',') : [];

      const filePath = path.resolve(file);
      if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(1); }

      const session = recordFromFile(filePath, task, agent, format);
      if (!session) { console.error('No events found in file'); process.exit(1); }
      const config = loadConfig(projectDir);
      const snapDir = path.join(projectDir, config.snapshotsDir);
      if (!fs.existsSync(snapDir)) init(projectDir);

      const meta = createSnapshot(projectDir, session, tags);

      if (opts.json) {
        console.log(JSON.stringify(meta, null, 2));
      } else {
        console.log(`Recorded snapshot: ${meta.id}`);
        console.log(`  Task: ${task}`);
        console.log(`  Agent: ${agent}`);
        console.log(`  Events: ${session.events.length}`);
        console.log(`  Tool calls: ${session.toolCalls.length}`);
        console.log(`  Files read: ${session.filesRead.length}`);
        console.log(`  Files written: ${session.filesWritten.length}`);
      }
      break;
    }

    case 'list': {
      const opts = parseOpts(args.slice(1));
      const snapshots = listSnapshots(projectDir);
      if (snapshots.length === 0) {
        console.log('No snapshots found. Run `agentsnap init` then `agentsnap record`.');
        break;
      }
      if (opts.json) {
        console.log(JSON.stringify(snapshots, null, 2));
      } else {
        console.log(`Snapshots (${snapshots.length}):`);
        for (const s of snapshots) {
          console.log(`  ${s.id}  ${s.task}  [${s.agent}]  ${s.createdAt}`);
        }
      }
      break;
    }

    case 'show': {
      const opts = parseOpts(args.slice(1));
      const id = args[1];
      if (!id) { console.error('Error: provide snapshot ID'); process.exit(1); }
      const snap = loadSnapshot(projectDir, id);
      if (!snap) { console.error(`Snapshot not found: ${id}`); process.exit(1); }
      const { meta, session } = snap;
      if (opts.json) {
        console.log(JSON.stringify({ meta, eventCount: session.events.length, toolCallCount: session.toolCalls.length, filesRead: session.filesRead, filesWritten: session.filesWritten }, null, 2));
      } else {
        console.log(`Snapshot: ${meta.id}`);
        console.log(`  Task: ${meta.task}`);
        console.log(`  Agent: ${meta.agent}`);
        console.log(`  Format: ${meta.format}`);
        console.log(`  Created: ${meta.createdAt}`);
        console.log(`  Tags: ${meta.tags.join(', ') || '(none)'}`);
        console.log(`  Events: ${session.events.length}`);
        console.log(`  Tool calls: ${session.toolCalls.length}`);
        console.log(`  Files read: ${session.filesRead.join(', ') || '(none)'}`);
        console.log(`  Files written: ${session.filesWritten.join(', ') || '(none)'}`);
        console.log(`  Errors: ${session.errorCount}`);
        console.log(`  Success: ${session.success}`);
      }
      break;
    }

    case 'diff': {
      const opts = parseOpts(args.slice(1));
      const id1 = args[1];
      const id2 = args[2];
      if (!id1 || !id2) { console.error('Error: provide two snapshot IDs'); process.exit(1); }
      const snap1 = loadSnapshot(projectDir, id1);
      const snap2 = loadSnapshot(projectDir, id2);
      if (!snap1) { console.error(`Snapshot not found: ${id1}`); process.exit(1); }
      if (!snap2) { console.error(`Snapshot not found: ${id2}`); process.exit(1); }

      const threshold = opts.threshold ? parseFloat(opts.threshold as string) : 0.7;
      const diff = diffSessions(snap1.session, snap2.session, threshold);
      console.log(formatDiffOutput(diff, !!opts.json));

      if (diff.regressionDetected) process.exit(1);
      break;
    }

    case 'remove': {
      const id = args[1];
      if (!id) { console.error('Error: provide snapshot ID'); process.exit(1); }
      const deleted = deleteSnapshot(projectDir, id);
      if (deleted) {
        console.log(`Deleted snapshot: ${id}`);
      } else {
        console.error(`Snapshot not found: ${id}`);
        process.exit(1);
      }
      break;
    }

    case 'history': {
      const opts = parseOpts(args.slice(1));
      const task = args[1];
      if (!task) { console.error('Error: provide task name'); process.exit(1); }
      const snaps = findSnapshotsByTask(projectDir, task);
      if (snaps.length === 0) {
        console.log(`No snapshots found for task: ${task}`);
        break;
      }
      if (opts.json) {
        console.log(JSON.stringify(snaps, null, 2));
      } else {
        console.log(`History for "${task}" (${snaps.length} snapshots):`);
        for (const s of snaps) {
          console.log(`  ${s.id}  [${s.agent}]  ${s.createdAt}  tags: ${s.tags.join(',') || '-'}`);
        }
        if (snaps.length >= 2) {
          const s1 = loadSnapshot(projectDir, snaps[snaps.length - 1].id);
          const s2 = loadSnapshot(projectDir, snaps[0].id);
          if (s1 && s2) {
            const threshold = opts.threshold ? parseFloat(opts.threshold as string) : 0.7;
            const diff = diffSessions(s1.session, s2.session, threshold);
            console.log('');
            console.log('Latest vs oldest:');
            console.log(formatDiffOutput(diff, false));
          }
        }
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      usage();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
