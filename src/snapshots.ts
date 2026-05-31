/**
 * Snapshot manager — CRUD for snapshots
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentSession, SnapshotMeta, AgentsnapConfig } from './types.js';
import { saveSession, loadSession } from './recorder.js';

const DEFAULT_CONFIG: AgentsnapConfig = {
  snapshotsDir: '.agentsnap',
  defaultFormat: 'auto',
  similarityThreshold: 0.7,
  ignoreTools: [],
  ignorePaths: [],
};

/** Initialize agentsnap in a project */
export function init(projectDir: string): AgentsnapConfig {
  const configPath = path.join(projectDir, 'agentsnap.json');
  const snapDir = path.join(projectDir, DEFAULT_CONFIG.snapshotsDir);

  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  fs.mkdirSync(snapDir, { recursive: true });
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gi.includes('.agentsnap')) {
      fs.appendFileSync(gitignorePath, '\n.agentsnap/\n');
    }
  }

  const config = { ...DEFAULT_CONFIG };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  return config;
}

/** Load config */
export function loadConfig(projectDir: string): AgentsnapConfig {
  const configPath = path.join(projectDir, 'agentsnap.json');
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf-8')) };
}

/** Save a session as a named snapshot */
export function createSnapshot(
  projectDir: string,
  session: AgentSession,
  tags: string[] = [],
): SnapshotMeta {
  const config = loadConfig(projectDir);
  const snapDir = path.join(projectDir, config.snapshotsDir);
  const sessionFile = saveSession(session, snapDir);

  const meta: SnapshotMeta = {
    id: session.id,
    task: session.task,
    agent: session.agent,
    format: session.format,
    createdAt: new Date().toISOString(),
    sessionFile: path.relative(projectDir, sessionFile),
    tags,
  };

  const metaPath = path.join(snapDir, `${session.id}.meta.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

  return meta;
}

/** List all snapshots */
export function listSnapshots(projectDir: string): SnapshotMeta[] {
  const config = loadConfig(projectDir);
  const snapDir = path.join(projectDir, config.snapshotsDir);

  if (!fs.existsSync(snapDir)) return [];

  const metas: SnapshotMeta[] = [];
  for (const file of fs.readdirSync(snapDir)) {
    if (file.endsWith('.meta.json')) {
      metas.push(JSON.parse(fs.readFileSync(path.join(snapDir, file), 'utf-8')));
    }
  }

  return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Load a snapshot by ID */
export function loadSnapshot(projectDir: string, id: string): { meta: SnapshotMeta; session: AgentSession } | null {
  const config = loadConfig(projectDir);
  const snapDir = path.join(projectDir, config.snapshotsDir);

  const metaPath = path.join(snapDir, `${id}.meta.json`);
  if (!fs.existsSync(metaPath)) return null;

  const meta: SnapshotMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const sessionPath = path.join(projectDir, meta.sessionFile);
  if (!fs.existsSync(sessionPath)) return null;

  const session = loadSession(sessionPath);
  return { meta, session };
}

/** Delete a snapshot by ID */
export function deleteSnapshot(projectDir: string, id: string): boolean {
  const config = loadConfig(projectDir);
  const snapDir = path.join(projectDir, config.snapshotsDir);

  const metaPath = path.join(snapDir, `${id}.meta.json`);
  const sessionPath = path.join(snapDir, `${id}.jsonl`);

  let deleted = false;
  if (fs.existsSync(metaPath)) { fs.unlinkSync(metaPath); deleted = true; }
  if (fs.existsSync(sessionPath)) { fs.unlinkSync(sessionPath); deleted = true; }

  return deleted;
}

/** Find snapshots by task name */
export function findSnapshotsByTask(projectDir: string, task: string): SnapshotMeta[] {
  return listSnapshots(projectDir).filter(s =>
    s.task.toLowerCase().includes(task.toLowerCase()),
  );
}
