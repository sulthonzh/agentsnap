/**
 * Diff engine — compare two agent sessions and detect regressions
 */

import { AgentSession, SessionDiff, DiffSummary, ToolCallDiff, FileChangeDiff, TimingDiff, TokenDiff } from './types.js';

/** Compare two arrays and return added/removed/common items */
function diffArrays<T>(baseline: T[], current: T[], keyFn: (item: T) => string): {
  added: T[];
  removed: T[];
  common: [T, T][];
} {
  const baselineMap = new Map(baseline.map(item => [keyFn(item), item]));
  const currentMap = new Map(current.map(item => [keyFn(item), item]));

  const added: T[] = [];
  const removed: T[] = [];
  const common: [T, T][] = [];

  for (const [key, item] of baselineMap) {
    if (currentMap.has(key)) {
      common.push([item, currentMap.get(key)!]);
    } else {
      removed.push(item);
    }
  }
  for (const [key, item] of currentMap) {
    if (!baselineMap.has(key)) {
      added.push(item);
    }
  }

  return { added, removed, common };
}

/** Find fields that differ between two objects */
function findFieldChanges(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changes: string[] = [];
  for (const key of allKeys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changes.push(key);
    }
  }
  return changes;
}

/** Compare tool calls between sessions */
export function diffToolCalls(baseline: AgentSession, current: AgentSession): ToolCallDiff[] {
  const { added, removed, common } = diffArrays(
    baseline.toolCalls,
    current.toolCalls,
    tc => `${tc.tool}:${tc.id}`,
  );

  const diffs: ToolCallDiff[] = [];

  for (const tc of added) {
    diffs.push({ tool: tc.tool, change: 'added', current: tc, fieldChanges: [] });
  }
  for (const tc of removed) {
    diffs.push({ tool: tc.tool, change: 'removed', baseline: tc, fieldChanges: [] });
  }
  for (const [b, c] of common) {
    const fieldChanges = findFieldChanges(
      { ...b.input, output: b.output } as Record<string, unknown>,
      { ...c.input, output: c.output } as Record<string, unknown>,
    );
    diffs.push({
      tool: b.tool,
      change: fieldChanges.length > 0 ? 'changed' : 'unchanged',
      baseline: b,
      current: c,
      fieldChanges,
    });
  }

  return diffs;
}

/** Compare file sets between sessions */
export function diffFiles(baseline: AgentSession, current: AgentSession): FileChangeDiff[] {
  const bRead = new Set(baseline.filesRead);
  const bWrite = new Set(baseline.filesWritten);
  const cRead = new Set(current.filesRead);
  const cWrite = new Set(current.filesWritten);

  const allFiles = new Set([...bRead, ...bWrite, ...cRead, ...cWrite]);
  const diffs: FileChangeDiff[] = [];

  for (const file of allFiles) {
    const wasRead = bRead.has(file) || bWrite.has(file);
    const isRead = cRead.has(file) || cWrite.has(file);
    const wasWritten = bWrite.has(file);
    const isWritten = cWrite.has(file);

    if (!wasRead && isRead) {
      diffs.push({ path: file, change: 'added' });
    } else if (wasRead && !isRead) {
      diffs.push({ path: file, change: 'removed' });
    } else if (wasWritten !== isWritten) {
      diffs.push({ path: file, change: 'modified' });
    } else {
      diffs.push({ path: file, change: 'unchanged' });
    }
  }

  return diffs;
}

/** Compute Jaccard similarity between tool call sequences */
export function computeSimilarity(baseline: AgentSession, current: AgentSession): number {
  const bTools = baseline.toolCalls.map(tc => `${tc.tool}(${Object.keys(tc.input).sort().join(',')})`);
  const cTools = current.toolCalls.map(tc => `${tc.tool}(${Object.keys(tc.input).sort().join(',')})`);

  if (bTools.length === 0 && cTools.length === 0) return 1.0;
  if (bTools.length === 0 || cTools.length === 0) return 0.0;

  const bSet = new Set(bTools);
  const cSet = new Set(cTools);
  const intersection = new Set([...bSet].filter(x => cSet.has(x)));

  return intersection.size / (bSet.size + cSet.size - intersection.size);
}

/** Detect regressions from a diff */
export function detectRegressions(
  diff: SessionDiff,
  threshold: number = 0.7,
): { regressionDetected: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (diff.summary.similarityScore < threshold) {
    reasons.push(
      `Low similarity score: ${(diff.summary.similarityScore * 100).toFixed(1)}% (threshold: ${(threshold * 100).toFixed(0)}%)`,
    );
  }

  if (diff.summary.successChanged) {
    reasons.push('Task completion status changed');
  }

  if (diff.summary.errorCountDiff > 0) {
    reasons.push(`Error count increased by ${diff.summary.errorCountDiff}`);
  }

  const criticalTools = diff.toolCallChanges.filter(
    tc => tc.change !== 'unchanged' && (tc.tool === 'write' || tc.tool === 'Edit' || tc.tool === 'execute' || tc.tool === 'bash'),
  );
  if (criticalTools.length > 0) {
    reasons.push(`${criticalTools.length} file-modifying tool calls changed`);
  }

  if (diff.summary.filesRemoved > 0) {
    reasons.push(`${diff.summary.filesRemoved} files were removed from session`);
  }

  return {
    regressionDetected: reasons.length > 0,
    reasons,
  };
}

/** Main diff function — compare two sessions */
export function diffSessions(baseline: AgentSession, current: AgentSession, threshold: number = 0.7): SessionDiff {
  const toolCallChanges = diffToolCalls(baseline, current);
  const fileChanges = diffFiles(baseline, current);

  const timingDiff: TimingDiff = {
    baseline_ms: baseline.totalDuration_ms || 0,
    current_ms: current.totalDuration_ms || 0,
    diff_ms: (current.totalDuration_ms || 0) - (baseline.totalDuration_ms || 0),
    percentChange: baseline.totalDuration_ms
      ? ((current.totalDuration_ms || 0) - baseline.totalDuration_ms) / baseline.totalDuration_ms * 100
      : 0,
  };

  const tokenDiff: TokenDiff | undefined = baseline.totalTokens && current.totalTokens
    ? {
        baseline: baseline.totalTokens,
        current: current.totalTokens,
        diff: current.totalTokens - baseline.totalTokens,
        percentChange: (current.totalTokens - baseline.totalTokens) / baseline.totalTokens * 100,
      }
    : undefined;

  const summary: DiffSummary = {
    toolCallsAdded: toolCallChanges.filter(tc => tc.change === 'added').length,
    toolCallsRemoved: toolCallChanges.filter(tc => tc.change === 'removed').length,
    toolCallsChanged: toolCallChanges.filter(tc => tc.change === 'changed').length,
    filesAdded: fileChanges.filter(f => f.change === 'added').length,
    filesRemoved: fileChanges.filter(f => f.change === 'removed').length,
    filesModified: fileChanges.filter(f => f.change === 'modified').length,
    errorCountDiff: current.errorCount - baseline.errorCount,
    successChanged: baseline.success !== current.success,
    durationDiff_ms: timingDiff.diff_ms,
    similarityScore: computeSimilarity(baseline, current),
  };

  const partial: SessionDiff = {
    baselineId: baseline.id,
    currentId: current.id,
    summary,
    toolCallChanges,
    fileChanges,
    timingDiff,
    tokenDiff,
    regressionDetected: false,
    regressionReasons: [],
  };

  const regression = detectRegressions(partial, threshold);
  partial.regressionDetected = regression.regressionDetected;
  partial.regressionReasons = regression.reasons;

  return partial;
}
