/**
 * Session recording — capture agent sessions from JSONL/stdin
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AgentSession, SessionEvent, ToolCall, AgentFormat } from './types.js';

/** Generate a unique session ID */
export function generateId(): string {
  return `snap_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/** Detect the agent format from a JSONL line */
export function detectFormat(line: string): AgentFormat {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'tool_call' || obj.tool) return 'generic';
    if (obj.role === 'assistant' && obj.content) return 'claude-code';
    if (obj.type === 'response' && obj.model) return 'codex';
    if (obj.event === 'tool_use') return 'cursor';
  } catch { /* not JSON */ }
  return 'generic';
}

/** Parse a single JSONL line into a session event */
export function parseLine(line: string): SessionEvent | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  try {
    const obj = JSON.parse(trimmed);

    // Generic format: { type, timestamp, data }
    if (obj.type && obj.timestamp) {
      return obj as SessionEvent;
    }

    // Codex format: { type: "response", model, ... }
    if (obj.type === 'response' || obj.type === 'tool_call') {
      return {
        type: 'tool_call',
        timestamp: obj.timestamp || new Date().toISOString(),
        data: obj,
      };
    }

    // Claude Code format: { role, content }
    if (obj.role === 'assistant' && Array.isArray(obj.content)) {
      const toolUse = obj.content.find((c: any) => c.type === 'tool_use');
      if (toolUse) {
        return {
          type: 'tool_call',
          timestamp: obj.timestamp || new Date().toISOString(),
          data: { tool: toolUse.name, input: toolUse.input, id: toolUse.id },
        };
      }
      return {
        type: 'message',
        timestamp: obj.timestamp || new Date().toISOString(),
        data: { role: obj.role, content: obj.content },
      };
    }

    // Wrap anything else as generic event
    return {
      type: 'state_change',
      timestamp: obj.timestamp || new Date().toISOString(),
      data: obj,
    };
  } catch {
    return null;
  }
}

/** Extract tool calls from parsed events */
export function extractToolCalls(events: SessionEvent[]): ToolCall[] {
  return events
    .filter(e => e.type === 'tool_call')
    .map((e, i) => ({
      id: (e.data.id as string) || `tc_${i}`,
      tool: (e.data.tool as string) || (e.data.name as string) || 'unknown',
      input: (e.data.input as Record<string, unknown>) || {},
      output: e.data.output as string | undefined,
      timestamp: e.timestamp,
      duration_ms: e.data.duration_ms as number | undefined,
      success: e.data.success !== false,
    }));
}

/** Build a full AgentSession from raw events */
export function buildSession(
  events: SessionEvent[],
  task: string,
  agent: string,
  format: AgentFormat,
): AgentSession {
  const toolCalls = extractToolCalls(events);
  const filesRead = toolCalls
    .filter(tc => tc.tool === 'read' || tc.tool === 'Read' || tc.tool === 'cat')
    .map(tc => (tc.input.path || tc.input.file_path || tc.input.filename || '') as string)
    .filter(Boolean);
  const filesWritten = toolCalls
    .filter(tc => tc.tool === 'write' || tc.tool === 'Write' || tc.tool === 'edit' || tc.tool === 'Edit')
    .map(tc => (tc.input.path || tc.input.file_path || tc.input.filename || '') as string)
    .filter(Boolean);
  const errorEvents = events.filter(e => e.type === 'error');
  const timestamps = events.map(e => e.timestamp).filter(Boolean).sort();

  return {
    id: generateId(),
    agent,
    format,
    task,
    startedAt: timestamps[0] || new Date().toISOString(),
    endedAt: timestamps[timestamps.length - 1] || undefined,
    events,
    toolCalls,
    filesRead: [...new Set(filesRead)],
    filesWritten: [...new Set(filesWritten)],
    filesModified: [...new Set([...filesWritten])],
    totalTokens: undefined,
    totalDuration_ms: undefined,
    errorCount: errorEvents.length,
    success: errorEvents.length === 0,
    metadata: {},
  };
}

/** Record a session from a JSONL file */
export function recordFromFile(filePath: string, task: string, agent: string, format: AgentFormat = 'auto'): AgentSession | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  return recordFromText(content, task, agent, format);
}

/** Record a session from JSONL text */
export function recordFromText(text: string, task: string, agent: string, format: AgentFormat = 'auto'): AgentSession {
  const lines = text.split('\n');
  const events: SessionEvent[] = [];

  let detectedFormat = format;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (detectedFormat === 'auto') {
      detectedFormat = detectFormat(trimmed);
    }

    const event = parseLine(trimmed);
    if (event) events.push(event);
  }

  return buildSession(events, task, agent, detectedFormat);
}

/** Save a session to disk */
export function saveSession(session: AgentSession, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${session.id}.jsonl`);
  const lines = session.events.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(filePath, lines, 'utf-8');
  return filePath;
}

/** Load a session from disk */
export function loadSession(filePath: string): AgentSession {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const events: SessionEvent[] = [];
  let format: AgentFormat = 'generic';

  for (const line of lines) {
    const event = parseLine(line);
    if (event) {
      events.push(event);
      if (format === 'generic') format = detectFormat(line);
    }
  }

  const fileName = path.basename(filePath, '.jsonl');
  return {
    ...buildSession(events, '', 'unknown', format),
    id: fileName,
  };
}
