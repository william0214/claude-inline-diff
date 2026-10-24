import * as vscode from 'vscode';
import * as fs from 'fs';
import { charDiff } from './diff';
import {
  SessionStore, FileReview, ReviewHunk, computeReview, currentText, fileKey, openDocument,
} from './session';

// 在原始檔案編輯器中呈現審查狀態（只用 TextEditorDecorationType、CodeLens、Hover，不改動文件內容）：
//   新增 / 修改後的行 → 綠色背景，修改的字元再加深
//   刪除的位置       → 紅色細線；完整的刪除內容以紅色背景顯示在 hover 中
//   每段變更         → 上方一行精簡的 CodeLens：✓ 保留 | ↶ 復原 | ⊖ 已刪除 N 行 / 原：…
// VS Code 公開 API 無法在一般編輯器的兩行之間插入真正的程式碼行，所以刪除內容無法像 Copilot 一樣常駐成紅色列。
export class ReviewManager implements vscode.Disposable {
  private readonly cache = new Map<string, { stamp: string; review: FileReview }>();
  private readonly codeLensEmitter = new vscode.EventEmitter<void>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
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
  // 刪除點在該行上緣；刪除發生在檔尾時畫在最後一行下緣
  private readonly deletedAbove = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly deletedBelow = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth: '0 0 2px 0',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
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
    this.disposables.push(
      this.codeLensEmitter, this.changeEmitter,
      this.addedLine, this.addedChars, this.deletedAbove, this.deletedBelow, this.conflictLine,
      store.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme === 'file' && store.get(e.document.uri.fsPath)) this.schedule();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderEditors()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.renderEditors()),
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, {
        onDidChangeCodeLenses: this.codeLensEmitter.event,
        provideCodeLenses: doc => this.codeLenses(doc),
      }),
    );
  }

  // ---------- 狀態查詢（清單與編輯器共用同一份 Session State） ----------

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

  // 刪除標示所在的行（hover 顯示完整刪除內容的位置）
  markerLine(h: ReviewHunk, lineCount: number): number {
    return Math.min(h.curStart, lineCount - 1);
  }

  // ---------- 重新繪製 ----------

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 80);
  }

  refresh() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const live = new Set(this.store.all().map(s => fileKey(s.path)));
    for (const k of this.cache.keys()) if (!live.has(k)) this.cache.delete(k);
    this.renderEditors();
    this.codeLensEmitter.fire();
    this.changeEmitter.fire();
  }

  private renderEditors() {
    for (const editor of vscode.window.visibleTextEditors) this.renderEditor(editor);
  }

  private renderEditor(editor: vscode.TextEditor) {
    const doc = editor.document;
    // diff 編輯器自己會畫紅綠，裡面的原始檔案不再疊加行內標示（CodeLens 仍保留）
    const review = doc.uri.scheme === 'file' && !inDiffEditor(editor) ? this.review(doc.uri.fsPath) : undefined;
    const added: vscode.DecorationOptions[] = [];
    const chars: vscode.DecorationOptions[] = [];
    const above: vscode.DecorationOptions[] = [];
    const below: vscode.DecorationOptions[] = [];
    const conflicts: vscode.DecorationOptions[] = [];
    const last = doc.lineCount - 1;

    for (const h of review && !review.missing ? review.hunks : []) {
      const lines = h.added.map((_, i) => h.curStart + i).filter(l => l <= last);
      if (h.status === 'conflicted') {
        conflicts.push(...(lines.length ? lines : [Math.min(h.curStart, last)]).map(l => ({
          range: doc.lineAt(l).range,
          hoverMessage: '這段 Claude 的修改之後又被手動編輯過，無法安全地自動復原；可以保留，或手動處理。',
        })));
        continue;
      }
      const hover = h.removed.length ? deletedHover(h) : undefined;
      for (const [i, l] of lines.entries()) {
        added.push({ range: doc.lineAt(l).range, hoverMessage: hover });
        if (h.type === 'modify' && i < h.removed.length) {
          const d = charDiff(h.removed[i], h.added[i]);
          if (d.bEnd > d.bStart && d.bEnd - d.bStart < h.added[i].length) {
            chars.push({ range: new vscode.Range(l, d.bStart, l, d.bEnd) });
          }
        }
      }
      if (h.type === 'delete') {
        const marker = { range: doc.lineAt(this.markerLine(h, doc.lineCount)).range, hoverMessage: hover };
        (h.curStart > last ? below : above).push(marker);
      }
    }
    editor.setDecorations(this.addedLine, added);
    editor.setDecorations(this.addedChars, chars);
    editor.setDecorations(this.deletedAbove, above);
    editor.setDecorations(this.deletedBelow, below);
    editor.setDecorations(this.conflictLine, conflicts);
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
        title: `Claude 修改了 ${review.hunks.length} 處（+${review.additions} −${review.deletions}）`,
        command: 'claudeInlineDiff.nextHunk', arguments: [], tooltip: '跳到下一處修改',
      }),
      new vscode.CodeLens(top, { title: '✓ 全部保留', command: 'claudeInlineDiff.acceptFile', arguments: [p] }),
    ];
    if (pending > 0) {
      lenses.push(new vscode.CodeLens(top, { title: '↶ 全部復原', command: 'claudeInlineDiff.rejectFile', arguments: [p] }));
    }
    for (const h of review.hunks) {
      const r = new vscode.Range(Math.min(h.curStart, last), 0, Math.min(h.curStart, last), 0);
      if (h.status === 'conflicted') {
        lenses.push(
          new vscode.CodeLens(r, { title: '⚠ 已被手動修改', command: 'claudeInlineDiff.explainConflict', arguments: [p, h.id] }),
          new vscode.CodeLens(r, { title: '✓ 保留', command: 'claudeInlineDiff.acceptHunk', arguments: [p, h.id] }),
        );
        continue;
      }
      lenses.push(
        new vscode.CodeLens(r, { title: '✓ 保留', command: 'claudeInlineDiff.acceptHunk', arguments: [p, h.id] }),
        new vscode.CodeLens(r, { title: '↶ 復原', command: 'claudeInlineDiff.rejectHunk', arguments: [p, h.id] }),
      );
      const info = removedSummary(h);
      if (info) {
        lenses.push(new vscode.CodeLens(r, {
          title: info, command: 'claudeInlineDiff.showDeleted', arguments: [p, h.id], tooltip: '顯示完整的刪除內容',
        }));
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
      hunks: r.hunks.map(h => ({
        id: h.id, type: h.type, status: h.status, curStart: h.curStart, removed: h.removed, added: h.added,
        summary: removedSummary(h), hover: h.removed.length ? deletedHover(h).value : undefined,
      })),
    }));
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

// diff 編輯器兩側的 TextEditor 沒有 viewColumn；再比對目前顯示中的 diff 分頁，確認右側就是這個檔案
export function inDiffEditor(editor: vscode.TextEditor): boolean {
  if (editor.viewColumn !== undefined) return false;
  const uri = editor.document.uri.toString();
  return vscode.window.tabGroups.all.some(g => {
    const input = g.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri;
  });
}

function shorten(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// CodeLens 上的精簡說明：刪除顯示行數與第一行，修改顯示原本的內容
export function removedSummary(h: ReviewHunk): string | undefined {
  if (h.removed.length === 0) return undefined;
  if (h.type === 'delete') {
    // 優先顯示有實際內容的一行（略過只有括號的行）
    const sample = h.removed.find(l => /[\p{L}\p{N}]/u.test(l)) ?? h.removed.find(l => l.trim()) ?? '';
    return `⊖ 已刪除 ${h.removed.length} 行：${shorten(sample, 40)}${h.removed.length > 1 ? ' …' : ''}`;
  }
  const more = h.removed.length > 1 ? `（共 ${h.removed.length} 行）` : '';
  return `原：${shorten(h.removed[0], 50)}${more}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 被刪除 / 被取代的原始程式碼：等寬字型、保留縮排、紅色背景；修改的字元再加深
export function deletedHover(h: ReviewHunk): vscode.MarkdownString {
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
    const pad = ' '.repeat(width - line.length + 1);
    return `<span style="color:var(--vscode-editor-foreground);background-color:var(--vscode-diffEditor-removedLineBackground);">${inner}${pad}</span>`;
  });
  const title = h.type === 'delete' ? `Claude 刪除了 ${h.removed.length} 行` : '修改前';
  const md = new vscode.MarkdownString(`${title}\n\n<pre>${rows.join('\n')}</pre>`);
  md.supportHtml = true;
  return md;
}
