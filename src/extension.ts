import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { diffLines, splitLines, Hunk } from './diff';

// hook 在 Claude 修改檔案前存下的原始內容
interface Baseline {
  path: string;
  existed: boolean;
  content: string;
  snapshotFile: string;
}

const BASELINE_DIR = path.join('.claude', 'inline-diff');
const HOOK_SCRIPT = 'inline-diff-snapshot.js';
const BASELINE_SCHEME = 'claude-inline-diff-base';

const baselines = new Map<string, Baseline>();
const codeLensEmitter = new vscode.EventEmitter<void>();

function key(p: string): string {
  const n = path.normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function eolOf(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function baselineFor(doc: vscode.TextDocument): Baseline | undefined {
  return doc.uri.scheme === 'file' ? baselines.get(key(doc.uri.fsPath)) : undefined;
}

function hunksFor(doc: vscode.TextDocument): Hunk[] {
  const b = baselineFor(doc);
  return b ? diffLines(splitLines(b.content), splitLines(doc.getText())) : [];
}

// ---------- baseline 檔案的讀寫 ----------

function loadSnapshot(file: string) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data.path !== 'string') return;
    // 清掉同一個 snapshot 舊的對應（理論上不會變，但保險）
    for (const [k, b] of baselines) if (b.snapshotFile === file) baselines.delete(k);
    baselines.set(key(data.path), {
      path: data.path,
      existed: data.existed !== false,
      content: String(data.content ?? ''),
      snapshotFile: file,
    });
  } catch {
    // hook 可能還在寫入中，等下一次 change 事件
  }
}

function dropSnapshot(file: string) {
  for (const [k, b] of baselines) if (b.snapshotFile === file) baselines.delete(k);
}

function saveBaseline(b: Baseline) {
  fs.writeFileSync(b.snapshotFile, JSON.stringify({ path: b.path, existed: b.existed, content: b.content }));
}

function clearBaseline(b: Baseline) {
  baselines.delete(key(b.path));
  try { fs.unlinkSync(b.snapshotFile); } catch { /* 已不存在 */ }
}

function scanFolder(folder: vscode.WorkspaceFolder) {
  const dir = path.join(folder.uri.fsPath, BASELINE_DIR);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) loadSnapshot(path.join(dir, f));
}

// ---------- 裝飾（紅綠標示） ----------

const addedDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
  borderStyle: 'solid',
  borderWidth: '0 0 0 3px',
  borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
});

// 被刪除的行無法真的插入編輯器，以紅色刪除線 ghost text 附在相鄰行顯示
const removedDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

const removedMarkerDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  borderStyle: 'solid',
  borderWidth: '2px 0 0 0',
  borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
});

function truncate(s: string, n = 100): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function ghost(text: string): vscode.DecorationInstanceRenderOptions {
  return {
    after: {
      contentText: text,
      color: new vscode.ThemeColor('editorError.foreground'),
      backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
      textDecoration: 'line-through; opacity: 0.85',
      margin: '0 0 0 2em',
    },
  };
}

function removedHover(h: Hunk): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`**Claude 刪除了 ${h.removed.length} 行：**`);
  md.appendCodeblock(h.removed.join('\n'));
  return md;
}

function refreshEditor(editor: vscode.TextEditor) {
  const doc = editor.document;
  const hunks = hunksFor(doc);
  const added: vscode.DecorationOptions[] = [];
  const removed: vscode.DecorationOptions[] = [];
  const markers: vscode.DecorationOptions[] = [];
  const last = Math.max(0, doc.lineCount - 1);

  for (const h of hunks) {
    for (let k = 0; k < h.added.length; k++) {
      const line = h.cStart + k;
      if (line > last) break;
      const range = doc.lineAt(line).range;
      // 一對一替換的行：在新行後面附上原本那一行
      if (k < h.removed.length) {
        const extra = k === h.added.length - 1 && h.removed.length > h.added.length
          ? `  (+${h.removed.length - h.added.length} 行已刪除)` : '';
        removed.push({ range, renderOptions: ghost(`⟵ ${truncate(h.removed[k])}${extra}`), hoverMessage: removedHover(h) });
      }
      added.push({ range });
    }
    // 純刪除：在刪除位置畫紅線並顯示被刪的內容
    if (h.added.length === 0 && h.removed.length > 0) {
      const line = Math.min(h.cStart, last);
      const range = doc.lineAt(line).range;
      const label = h.removed.length === 1
        ? `⊖ ${truncate(h.removed[0])}`
        : `⊖ 刪除 ${h.removed.length} 行：${truncate(h.removed[0], 60)}`;
      markers.push({ range, hoverMessage: removedHover(h) });
      removed.push({ range, renderOptions: ghost(label), hoverMessage: removedHover(h) });
    }
  }
  editor.setDecorations(addedDeco, added);
  editor.setDecorations(removedDeco, removed);
  editor.setDecorations(removedMarkerDeco, markers);
}

let statusItem: vscode.StatusBarItem;

function refreshAll() {
  for (const e of vscode.window.visibleTextEditors) refreshEditor(e);
  codeLensEmitter.fire();
  const n = baselines.size;
  if (n > 0) {
    statusItem.text = `$(diff) Claude：${n} 個檔案待審`;
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

let refreshTimer: NodeJS.Timeout | undefined;
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, 80);
}

// ---------- CodeLens：接受 / 拒絕 ----------

class HunkCodeLens implements vscode.CodeLensProvider {
  onDidChangeCodeLenses = codeLensEmitter.event;

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const hunks = hunksFor(doc);
    if (hunks.length === 0) return [];
    const uri = doc.uri.toString();
    const last = Math.max(0, doc.lineCount - 1);
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, { title: `$(sparkle) Claude 修改了 ${hunks.length} 處`, command: 'claudeInlineDiff.openSideBySide', arguments: [uri] }),
      new vscode.CodeLens(top, { title: '$(check-all) 全部接受', command: 'claudeInlineDiff.acceptFile', arguments: [uri] }),
      new vscode.CodeLens(top, { title: '$(close-all) 全部拒絕', command: 'claudeInlineDiff.rejectFile', arguments: [uri] }),
    ];
    hunks.forEach((h, idx) => {
      const r = new vscode.Range(Math.min(h.cStart, last), 0, Math.min(h.cStart, last), 0);
      lenses.push(
        new vscode.CodeLens(r, { title: '$(check) 接受', command: 'claudeInlineDiff.acceptHunk', arguments: [uri, idx] }),
        new vscode.CodeLens(r, { title: '$(close) 拒絕', command: 'claudeInlineDiff.rejectHunk', arguments: [uri, idx] }),
      );
    });
    return lenses;
  }
}

// ---------- 指令 ----------

async function resolveDoc(uriStr?: string): Promise<vscode.TextDocument | undefined> {
  if (uriStr) return vscode.workspace.openTextDocument(vscode.Uri.parse(uriStr));
  return vscode.window.activeTextEditor?.document;
}

async function replaceDoc(doc: vscode.TextDocument, text: string) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
  // 存檔，讓 Claude Code 下一輪讀到的是拒絕後的內容
  await doc.save();
}

function settleIfDone(doc: vscode.TextDocument, b: Baseline) {
  if (splitLines(b.content).join('\n') === splitLines(doc.getText()).join('\n')) clearBaseline(b);
}

async function acceptHunk(uriStr: string, idx: number) {
  const doc = await resolveDoc(uriStr);
  const b = doc && baselineFor(doc);
  const h = doc && hunksFor(doc)[idx];
  if (!doc || !b || !h) return;
  // 接受 = 把這段修改併入 baseline
  const lines = splitLines(b.content);
  lines.splice(h.bStart, h.removed.length, ...h.added);
  b.content = lines.join(eolOf(doc));
  saveBaseline(b);
  settleIfDone(doc, b);
  refreshAll();
}

async function rejectHunk(uriStr: string, idx: number) {
  const doc = await resolveDoc(uriStr);
  const b = doc && baselineFor(doc);
  const h = doc && hunksFor(doc)[idx];
  if (!doc || !b || !h) return;
  // 拒絕 = 把檔案這段還原成 baseline
  const lines = splitLines(doc.getText());
  lines.splice(h.cStart, h.added.length, ...h.removed);
  await replaceDoc(doc, lines.join(eolOf(doc)));
  settleIfDone(doc, b);
  refreshAll();
}

async function acceptFile(uriStr?: string) {
  const doc = await resolveDoc(uriStr);
  const b = doc && baselineFor(doc);
  if (!b) return;
  clearBaseline(b);
  refreshAll();
}

async function rejectFile(uriStr?: string) {
  const doc = await resolveDoc(uriStr);
  const b = doc && baselineFor(doc);
  if (!doc || !b) return;
  if (!b.existed) {
    const ok = await vscode.window.showWarningMessage(
      `${path.basename(b.path)} 是 Claude 新建的檔案，拒絕會將它移到資源回收筒。`, { modal: true }, '移除檔案');
    if (ok !== '移除檔案') return;
    clearBaseline(b);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.workspace.fs.delete(doc.uri, { useTrash: true });
  } else {
    await replaceDoc(doc, splitLines(b.content).join(eolOf(doc)));
    clearBaseline(b);
  }
  refreshAll();
}

function jumpHunk(dir: 1 | -1) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const starts = hunksFor(editor.document).map(h => Math.min(h.cStart, editor.document.lineCount - 1));
  if (starts.length === 0) return;
  const cur = editor.selection.active.line;
  const target = dir === 1
    ? starts.find(s => s > cur) ?? starts[0]
    : [...starts].reverse().find(s => s < cur) ?? starts[starts.length - 1];
  const pos = new vscode.Position(target, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

async function listFiles() {
  const items = [...baselines.values()].map(b => ({
    label: path.basename(b.path),
    description: vscode.workspace.asRelativePath(b.path),
    path: b.path,
  }));
  if (items.length === 0) {
    vscode.window.showInformationMessage('目前沒有待審的 Claude 修改。');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: '選擇要檢視的檔案' });
  if (pick) await vscode.window.showTextDocument(vscode.Uri.file(pick.path));
}

async function openSideBySide(uriStr?: string) {
  const doc = await resolveDoc(uriStr);
  if (!doc || !baselineFor(doc)) return;
  const base = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: doc.uri.path, query: doc.uri.fsPath });
  await vscode.commands.executeCommand('vscode.diff', base, doc.uri, `${path.basename(doc.uri.fsPath)}（Claude 修改前 ↔ 目前）`);
}

// 把 PreToolUse hook 寫進工作區的 .claude/settings.local.json
async function installHook(context: vscode.ExtensionContext) {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage('請先開啟一個資料夾。');
    return;
  }
  const settingsPath = path.join(folder.uri.fsPath, '.claude', 'settings.local.json');
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      vscode.window.showErrorMessage(`${settingsPath} 不是合法的 JSON，請先修正。`);
      return;
    }
  }
  const script = path.join(context.extensionPath, 'hooks', HOOK_SCRIPT).replace(/\\/g, '/');
  settings.hooks ??= {};
  // 移除舊版本留下的設定（擴充套件路徑會隨版本變動）
  settings.hooks.PreToolUse = (settings.hooks.PreToolUse ?? [])
    .map((m: any) => ({ ...m, hooks: (m.hooks ?? []).filter((h: any) => !String(h.command ?? '').includes(HOOK_SCRIPT)) }))
    .filter((m: any) => m.hooks.length > 0);
  settings.hooks.PreToolUse.push({
    matcher: 'Edit|Write|MultiEdit',
    hooks: [{ type: 'command', command: `node "${script}"` }],
  });
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  vscode.window.showInformationMessage('已安裝 hook。請重新啟動 Claude Code 對話以套用設定。');
}

export function activate(context: vscode.ExtensionContext) {
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = 'claudeInlineDiff.listFiles';

  for (const f of vscode.workspace.workspaceFolders ?? []) {
    scanFolder(f);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '.claude/inline-diff/*.json'));
    watcher.onDidCreate(u => { loadSnapshot(u.fsPath); scheduleRefresh(); });
    watcher.onDidChange(u => { loadSnapshot(u.fsPath); scheduleRefresh(); });
    watcher.onDidDelete(u => { dropSnapshot(u.fsPath); scheduleRefresh(); });
    context.subscriptions.push(watcher);
  }

  context.subscriptions.push(
    statusItem,
    addedDeco, removedDeco, removedMarkerDeco,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new HunkCodeLens()),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      provideTextDocumentContent: uri => baselines.get(key(uri.query))?.content ?? '',
    }),
    vscode.workspace.onDidChangeTextDocument(e => { if (baselineFor(e.document)) scheduleRefresh(); }),
    vscode.window.onDidChangeVisibleTextEditors(scheduleRefresh),
    vscode.commands.registerCommand('claudeInlineDiff.installHook', () => installHook(context)),
    vscode.commands.registerCommand('claudeInlineDiff.acceptHunk', acceptHunk),
    vscode.commands.registerCommand('claudeInlineDiff.rejectHunk', rejectHunk),
    vscode.commands.registerCommand('claudeInlineDiff.acceptFile', acceptFile),
    vscode.commands.registerCommand('claudeInlineDiff.rejectFile', rejectFile),
    vscode.commands.registerCommand('claudeInlineDiff.nextHunk', () => jumpHunk(1)),
    vscode.commands.registerCommand('claudeInlineDiff.prevHunk', () => jumpHunk(-1)),
    vscode.commands.registerCommand('claudeInlineDiff.listFiles', listFiles),
    vscode.commands.registerCommand('claudeInlineDiff.openSideBySide', openSideBySide),
  );
  refreshAll();
}

export function deactivate() {}
