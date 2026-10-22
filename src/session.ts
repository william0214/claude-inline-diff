import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { diffLines, splitLines, stripBom, eolOf, overlaps, shiftBefore, hashText } from './diff';

// 一個檔案的審查狀態，對應 .claude/inline-diff/<id>.json
//   base：AI 修改前的內容（接受的變更會併入）
//   ai  ：AI 最後一次修改後的內容（PostToolUse hook 寫入；拒絕的變更會從這裡移除）
// AI 的變更 = diff(base, ai)；之後使用者的手動修改 = diff(ai, 目前內容)，不會被當成 AI 修改。
export interface FileSession {
  path: string;
  existed: boolean;
  base: string;
  ai?: string;
  sessionId?: string;
  snapshotFile: string;
  rev: number;
}

export type HunkStatus = 'pending' | 'conflicted';

export interface ReviewHunk {
  id: string;
  type: 'add' | 'delete' | 'modify';
  removed: string[];
  added: string[];
  baseStart: number;
  aiStart: number;
  // 在目前文件中的起始行（0 起算）；純刪除時為被刪內容原本所在的位置
  curStart: number;
  status: HunkStatus;
}

export interface FileReview {
  session: FileSession;
  hunks: ReviewHunk[];
  additions: number;
  deletions: number;
  missing: boolean;
}

export const BASELINE_DIR = path.join('.claude', 'inline-diff');

const realPathCache = new Map<string, string>();

// 轉成真實完整路徑再比對（Windows 8.3 短檔名、symlink），與 hook 記錄的路徑一致
export function fileKey(p: string): string {
  let real = realPathCache.get(p);
  if (real === undefined) {
    try {
      real = fs.realpathSync.native(p);
    } catch {
      try {
        real = path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
      } catch {
        real = path.normalize(p);
      }
    }
    realPathCache.set(p, real);
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

export function openDocument(filePath: string): vscode.TextDocument | undefined {
  const k = fileKey(filePath);
  return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && fileKey(d.uri.fsPath) === k);
}

export function currentText(filePath: string): string | undefined {
  const doc = openDocument(filePath);
  if (doc) return doc.getText();
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return undefined; }
}

// 依 base / ai / 目前內容算出待審查的 hunk 與它們在目前文件中的位置
export function computeReview(s: FileSession, current: string | undefined): FileReview {
  const base = splitLines(s.base);
  const missing = current === undefined;
  const cur = splitLines(stripBom(current ?? ''));
  const ai = s.ai === undefined ? cur : splitLines(s.ai);
  const aiHunks = diffLines(base, ai);
  const userChanges = s.ai === undefined || missing ? [] : diffLines(ai, cur);

  const seen = new Map<string, number>();
  const hunks = aiHunks.map(h => {
    const aS = h.cStart;
    const aE = h.cStart + h.added.length;
    const touched = userChanges.some(d => overlaps(aS, aE, d.bStart, d.bStart + d.removed.length));
    const curStart = aS + shiftBefore(userChanges, aS, aE);
    // 保險：確認目前文件那幾行仍是 AI 寫入的內容
    const intact = !touched && h.added.every((l, i) => cur[curStart + i] === l);
    const sig = hashText(h.removed.join('\n') + '\u0000' + h.added.join('\n'));
    const n = seen.get(sig) ?? 0;
    seen.set(sig, n + 1);
    const hunk: ReviewHunk = {
      id: `${sig}#${n}`,
      type: h.removed.length === 0 ? 'add' : h.added.length === 0 ? 'delete' : 'modify',
      removed: h.removed,
      added: h.added,
      baseStart: h.bStart,
      aiStart: aS,
      curStart,
      status: intact && !missing ? 'pending' : 'conflicted',
    };
    return hunk;
  });
  return {
    session: s,
    hunks,
    additions: hunks.reduce((n, h) => n + h.added.length, 0),
    deletions: hunks.reduce((n, h) => n + h.removed.length, 0),
    missing,
  };
}

// 接受：把這段變更併入 base
export function acceptInSession(s: FileSession, h: ReviewHunk) {
  const lines = splitLines(s.base);
  lines.splice(h.baseStart, h.removed.length, ...h.added);
  s.base = lines.join(eolOf(s.base, s.ai));
}

// 拒絕：把這段變更從 ai 移除（目前文件的還原由呼叫端以 WorkspaceEdit 處理）
export function rejectInSession(s: FileSession, h: ReviewHunk) {
  if (s.ai === undefined) return;
  const lines = splitLines(s.ai);
  lines.splice(h.aiStart, h.added.length, ...h.removed);
  s.ai = lines.join(eolOf(s.ai, s.base));
}

export function isSettled(s: FileSession, current: string | undefined): boolean {
  const ai = s.ai ?? stripBom(current ?? '');
  return diffLines(splitLines(s.base), splitLines(ai)).length === 0;
}

export class SessionStore implements vscode.Disposable {
  private readonly sessions = new Map<string, FileSession>();
  private readonly emitter = new vscode.EventEmitter<FileSession | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly watched = new Set<string>();
  private rev = 0;
  readonly onDidChange = this.emitter.event;

  constructor() {
    this.watchFolders(vscode.workspace.workspaceFolders ?? []);
    this.disposables.push(
      this.emitter,
      vscode.workspace.onDidChangeWorkspaceFolders(e => this.watchFolders(e.added)),
      vscode.workspace.onDidRenameFiles(e => {
        for (const f of e.files) this.rename(f.oldUri.fsPath, f.newUri.fsPath);
      }),
    );
  }

  private watchFolders(folders: readonly vscode.WorkspaceFolder[]) {
    for (const folder of folders) {
      if (this.watched.has(folder.uri.toString())) continue;
      this.watched.add(folder.uri.toString());
      const dir = path.join(folder.uri.fsPath, BASELINE_DIR);
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) this.load(path.join(dir, f));
      }
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.claude/inline-diff/*.json'));
      watcher.onDidCreate(u => this.load(u.fsPath));
      watcher.onDidChange(u => this.load(u.fsPath));
      watcher.onDidDelete(u => this.drop(u.fsPath));
      this.disposables.push(watcher);
    }
  }

  get(filePath: string): FileSession | undefined {
    return this.sessions.get(fileKey(filePath));
  }

  all(): FileSession[] {
    return [...this.sessions.values()];
  }

  load(snapshotFile: string) {
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
    } catch {
      return; // hook 可能還在寫入中，等下一次 change 事件
    }
    if (typeof data?.path !== 'string') return;
    const existing = this.get(data.path);
    // 自己剛寫入的內容不必重新載入
    if (existing && existing.snapshotFile === snapshotFile
      && existing.base === stripBom(String(data.base ?? data.content ?? ''))
      && existing.ai === (typeof data.ai === 'string' ? stripBom(data.ai) : undefined)) return;
    for (const [k, s] of this.sessions) if (s.snapshotFile === snapshotFile) this.sessions.delete(k);
    const s: FileSession = {
      path: data.path,
      existed: data.existed !== false,
      // 0.1 / 0.2 版的 snapshot 只有 content（沒有 ai）
      base: stripBom(String(data.base ?? data.content ?? '')),
      ai: typeof data.ai === 'string' ? stripBom(data.ai) : undefined,
      sessionId: data.sessionId,
      snapshotFile,
      rev: ++this.rev,
    };
    this.sessions.set(fileKey(s.path), s);
    this.emitter.fire(s);
  }

  private drop(snapshotFile: string) {
    for (const [k, s] of this.sessions) {
      if (s.snapshotFile !== snapshotFile) continue;
      this.sessions.delete(k);
      this.emitter.fire(undefined);
    }
  }

  save(s: FileSession) {
    s.rev = ++this.rev;
    const tmp = s.snapshotFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      version: 2, path: s.path, existed: s.existed, base: s.base, ai: s.ai, sessionId: s.sessionId,
      updatedAt: new Date().toISOString(),
    }));
    fs.renameSync(tmp, s.snapshotFile);
    this.emitter.fire(s);
  }

  clear(s: FileSession) {
    this.sessions.delete(fileKey(s.path));
    try { fs.unlinkSync(s.snapshotFile); } catch { /* 已不存在 */ }
    this.emitter.fire(undefined);
  }

  // 手動審查模式：給沒有 hook 的 AI 工具用，從現在的內容開始追蹤此檔案的所有變更
  startManual(filePath: string, text: string) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    const root = folder?.uri.fsPath ?? path.dirname(filePath);
    const dir = path.join(root, BASELINE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const s: FileSession = {
      path: filePath,
      existed: true,
      base: stripBom(text),
      ai: undefined,
      sessionId: 'manual',
      snapshotFile: path.join(dir, `manual-${hashText(fileKey(filePath))}.json`),
      rev: 0,
    };
    this.sessions.set(fileKey(filePath), s);
    this.save(s);
  }

  private rename(oldPath: string, newPath: string) {
    const s = this.get(oldPath);
    if (!s) return;
    this.sessions.delete(fileKey(oldPath));
    realPathCache.clear();
    s.path = newPath;
    this.sessions.set(fileKey(newPath), s);
    this.save(s);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}
