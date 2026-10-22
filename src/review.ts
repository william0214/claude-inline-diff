import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { charDiff } from './diff';
import {
  SessionStore, FileReview, ReviewHunk, computeReview, currentText, fileKey, openDocument,
} from './session';

export const COMMENT_CONTROLLER_ID = 'claude-inline-diff';

interface ThreadEntry {
  thread: vscode.CommentThread;
  signature: string;
}

// 在原始檔案編輯器中呈現審查狀態：
//   新增 / 修改後的行   → 綠色背景（TextEditorDecorationType），修改的字元再加深
//   刪除 / 修改前的行   → Comments API 的區塊，嵌在兩行之間顯示完整原始程式碼（紅色背景）
//   每段變更的保留 / 復原 → CodeLens 與區塊標題列的按鈕
export class ReviewManager implements vscode.Disposable {
  private readonly cache = new Map<string, { stamp: string; review: FileReview }>();
  private readonly threads = new Map<string, Map<string, ThreadEntry>>();
  private readonly threadHunks = new WeakMap<vscode.CommentThread, { path: string; id: string }>();
  private readonly codeLensEmitter = new vscode.EventEmitter<void>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly controller = vscode.comments.createCommentController(COMMENT_CONTROLLER_ID, 'Claude 修改審查');
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  readonly onDidChange = this.changeEmitter.event;

  private readonly addedLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    borderStyle: 'solid',
    borderWidth: '0 0 0 3px',
    borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly addedChars = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  });
  private readonly deletedAt = vscode.window.createTextEditorDecorationType({
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly conflictLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'dashed',
    borderWidth: '0 0 0 3px',
    borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.warningForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(private readonly store: SessionStore) {
    this.controller.options = { placeHolder: '', prompt: '' };
    this.disposables.push(
      this.controller, this.codeLensEmitter, this.changeEmitter,
      this.addedLine, this.addedChars, this.deletedAt, this.conflictLine,
      store.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme === 'file' && store.get(e.document.uri.fsPath)) this.schedule();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderEditors()),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
        onDidChangeCodeLenses: this.codeLensEmitter.event,
        provideCodeLenses: doc => this.codeLenses(doc),
      }),
    );
  }

  // ---------- 狀態查詢 ----------

  review(filePath: string): FileReview | undefined {
    const s = this.store.get(filePath);
    if (!s) return undefined;
    const doc = openDocument(s.path);
    let stamp = `${s.rev}:`;
    if (doc) {
      stamp += `v${doc.version}`;
    } else {
      try { stamp += `d${fs.statSync(s.path).mtimeMs}`; } catch { stamp += 'missing'; }
    }
    const k = fileKey(s.path);
    const hit = this.cache.get(k);
    if (hit && hit.stamp === stamp) return hit.review;
    const review = computeReview(s, currentText(s.path));
    this.cache.set(k, { stamp, review });
    return review;
  }

  reviews(): FileReview[] {
    return this.store.all()
      .map(s => this.review(s.path)!)
      .filter(r => r.hunks.length > 0 || r.missing);
  }

  findHunk(filePath: string, id: string): ReviewHunk | undefined {
    return this.review(filePath)?.hunks.find(h => h.id === id);
  }

  hunkOfThread(thread: vscode.CommentThread) {
    return this.threadHunks.get(thread);
  }

  // ---------- 重新繪製 ----------

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 80);
  }

  refresh() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const live = new Set<string>();
    for (const s of this.store.all()) {
      const k = fileKey(s.path);
      live.add(k);
      this.renderThreads(k, this.review(s.path)!);
    }
    for (const [k, entries] of this.threads) {
      if (live.has(k)) continue;
      for (const e of entries.values()) e.thread.dispose();
      this.threads.delete(k);
      this.cache.delete(k);
    }
    this.renderEditors();
    this.codeLensEmitter.fire();
    this.changeEmitter.fire();
  }

  private renderEditors() {
    for (const editor of vscode.window.visibleTextEditors) this.renderEditor(editor);
  }

  private renderEditor(editor: vscode.TextEditor) {
    const doc = editor.document;
    const review = doc.uri.scheme === 'file' ? this.review(doc.uri.fsPath) : undefined;
    const added: vscode.DecorationOptions[] = [];
    const chars: vscode.DecorationOptions[] = [];
    const deleted: vscode.DecorationOptions[] = [];
    const conflicts: vscode.DecorationOptions[] = [];
    const last = doc.lineCount - 1;

    for (const h of review && !review.missing ? review.hunks : []) {
      const lines = h.added.map((_, i) => h.curStart + i).filter(l => l <= last);
      if (h.status === 'conflicted') {
        const at = Math.min(h.curStart, last);
        conflicts.push(...(lines.length ? lines : [at]).map(l => ({
          range: doc.lineAt(l).range,
          hoverMessage: '這段 Claude 的修改之後又被手動編輯過，無法安全地自動復原；可以保留，或手動處理。',
        })));
        continue;
      }
      const hover = h.removed.length ? originalHover(h, doc.languageId) : undefined;
      for (const [i, l] of lines.entries()) {
        added.push({ range: doc.lineAt(l).range, hoverMessage: hover });
        // 一對一修改的行：標出實際變動的字元
        if (h.type === 'modify' && i < h.removed.length) {
          const d = charDiff(h.removed[i], h.added[i]);
          if (d.bEnd > d.bStart && d.bEnd - d.bStart < h.added[i].length) {
            chars.push({ range: new vscode.Range(l, d.bStart, l, d.bEnd) });
          }
        }
      }
      if (h.type === 'delete') deleted.push({ range: doc.lineAt(Math.min(h.curStart, last)).range });
    }
    editor.setDecorations(this.addedLine, added);
    editor.setDecorations(this.addedChars, chars);
    editor.setDecorations(this.deletedAt, deleted);
    editor.setDecorations(this.conflictLine, conflicts);
  }

  // 每段有刪除內容的變更，建立一個嵌在原始檔案中的區塊顯示被刪掉的程式碼
  private renderThreads(k: string, review: FileReview) {
    const entries = this.threads.get(k) ?? new Map<string, ThreadEntry>();
    this.threads.set(k, entries);
    const uri = vscode.Uri.file(review.session.path);
    const keep = new Set<string>();

    for (const h of review.missing ? [] : review.hunks) {
      if (h.removed.length === 0) continue;
      keep.add(h.id);
      const line = Math.max(0, h.curStart - 1);
      const signature = `${h.status}:${line}`;
      const existing = entries.get(h.id);
      if (existing && existing.signature === signature) continue;
      const range = new vscode.Range(line, 0, line, 0);
      const thread = existing?.thread ?? this.controller.createCommentThread(uri, range, []);
      thread.range = range;
      thread.canReply = false;
      thread.contextValue = h.status;
      thread.label = threadLabel(h);
      thread.comments = [{
        body: deletedBlock(h),
        mode: vscode.CommentMode.Preview,
        author: { name: h.status === 'conflicted' ? '已被手動修改' : '修改前' },
        contextValue: h.status,
      }];
      if (!existing) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      this.threadHunks.set(thread, { path: review.session.path, id: h.id });
      entries.set(h.id, { thread, signature });
    }
    for (const [id, e] of entries) {
      if (keep.has(id)) continue;
      e.thread.dispose();
      entries.delete(id);
    }
  }

  private codeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const review = this.review(doc.uri.fsPath);
    if (!review || review.missing || review.hunks.length === 0) return [];
    const p = doc.uri.fsPath;
    const last = doc.lineCount - 1;
    const pending = review.hunks.filter(h => h.status === 'pending').length;
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, {
        title: `$(sparkle) Claude 修改了 ${review.hunks.length} 處（+${review.additions} −${review.deletions}）`,
        command: 'claudeInlineDiff.compareFile', arguments: [p], tooltip: '以 VS Code diff 檢視比對',
      }),
      new vscode.CodeLens(top, { title: '$(check-all) 全部保留', command: 'claudeInlineDiff.acceptFile', arguments: [p] }),
    ];
    if (pending > 0) {
      lenses.push(new vscode.CodeLens(top, { title: '$(discard) 全部復原', command: 'claudeInlineDiff.rejectFile', arguments: [p] }));
    }
    for (const h of review.hunks) {
      const line = Math.min(h.curStart, last);
      const r = new vscode.Range(line, 0, line, 0);
      if (h.status === 'conflicted') {
        lenses.push(
          new vscode.CodeLens(r, { title: '$(warning) 已被手動修改', command: 'claudeInlineDiff.explainConflict', arguments: [p, h.id] }),
          new vscode.CodeLens(r, { title: '$(check) 保留', command: 'claudeInlineDiff.acceptHunk', arguments: [p, h.id] }),
        );
      } else {
        lenses.push(
          new vscode.CodeLens(r, { title: '$(check) 保留', command: 'claudeInlineDiff.acceptHunk', arguments: [p, h.id] }),
          new vscode.CodeLens(r, { title: '$(discard) 復原', command: 'claudeInlineDiff.rejectHunk', arguments: [p, h.id] }),
        );
      }
    }
    return lenses;
  }

  // 測試與除錯用：目前的審查狀態
  debugState() {
    return this.reviews().map(r => ({
      path: r.session.path,
      additions: r.additions,
      deletions: r.deletions,
      missing: r.missing,
      threads: [...(this.threads.get(fileKey(r.session.path))?.values() ?? [])].map(e => ({
        line: e.thread.range?.start.line,
        label: e.thread.label,
        body: (e.thread.comments[0]?.body as vscode.MarkdownString)?.value,
      })),
      hunks: r.hunks.map(h => ({
        id: h.id, type: h.type, status: h.status, curStart: h.curStart, removed: h.removed, added: h.added,
      })),
    }));
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    for (const entries of this.threads.values()) for (const e of entries.values()) e.thread.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function threadLabel(h: ReviewHunk): string {
  const what = h.type === 'delete' ? `Claude 刪除了 ${h.removed.length} 行` : `Claude 修改了以下 ${h.removed.length} 行`;
  return h.status === 'conflicted' ? `${what}（之後被手動修改，無法自動復原）` : what;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 被刪除的原始程式碼：等寬字型、保留縮排、紅色背景；修改的行另外加深變動的字元
function deletedBlock(h: ReviewHunk): vscode.MarkdownString {
  const width = Math.max(1, ...h.removed.map(l => l.length));
  const rows = h.removed.map((line, i) => {
    let inner = escapeHtml(line);
    if (h.type === 'modify' && i < h.added.length) {
      const d = charDiff(line, h.added[i]);
      if (d.aEnd > d.aStart && d.aEnd - d.aStart < line.length) {
        inner = escapeHtml(line.slice(0, d.aStart))
          + `<span style="background-color:var(--vscode-diffEditor-removedTextBackground);">${escapeHtml(line.slice(d.aStart, d.aEnd))}</span>`
          + escapeHtml(line.slice(d.aEnd));
      }
    }
    const pad = ' '.repeat(width - line.length + 2);
    return `<span style="color:var(--vscode-editor-foreground);background-color:var(--vscode-diffEditor-removedLineBackground);">${inner}${pad}</span>`;
  });
  const md = new vscode.MarkdownString(`<pre>${rows.join('\n')}</pre>`);
  md.supportHtml = true;
  return md;
}

function originalHover(h: ReviewHunk, languageId: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`**修改前（${h.removed.length} 行）**`);
  md.appendCodeblock(h.removed.join('\n'), languageId);
  return md;
}

export function relativeName(filePath: string) {
  return { name: path.basename(filePath), relative: vscode.workspace.asRelativePath(filePath) };
}
