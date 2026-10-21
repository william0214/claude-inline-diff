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
const baselineDocEmitter = new vscode.EventEmitter<vscode.Uri>();
// 已自動開啟過檢視的檔案，避免重複開分頁
const reviewOpened = new Set<string>();

const realPathCache = new Map<string, string>();

// 轉成真實完整路徑再比對（Windows 8.3 短檔名、symlink），與 hook 記錄的路徑一致
function key(p: string): string {
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

function stripBom(s: string): string {
  return s.replace(/^﻿/, '');
}

function sameText(a: string, b: string): boolean {
  return splitLines(stripBom(a)).join('\n') === splitLines(stripBom(b)).join('\n');
}

function eolOf(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

function baseUri(filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: vscode.Uri.file(filePath).path, query: filePath });
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
    for (const [k, b] of baselines) if (b.snapshotFile === file) baselines.delete(k);
    baselines.set(key(data.path), {
      path: data.path,
      existed: data.existed !== false,
      content: stripBom(String(data.content ?? '')),
      snapshotFile: file,
    });
    baselineDocEmitter.fire(baseUri(data.path));
  } catch {
    // hook 可能還在寫入中，等下一次 change 事件
  }
}

function dropSnapshot(file: string) {
  for (const [k, b] of baselines) {
    if (b.snapshotFile !== file) continue;
    baselines.delete(k);
    reviewOpened.delete(k);
    closeReviewTabs(b.path);
  }
}

function saveBaseline(b: Baseline) {
  fs.writeFileSync(b.snapshotFile, JSON.stringify({ path: b.path, existed: b.existed, content: b.content }));
  baselineDocEmitter.fire(baseUri(b.path));
}

function clearBaseline(b: Baseline) {
  baselines.delete(key(b.path));
  reviewOpened.delete(key(b.path));
  try { fs.unlinkSync(b.snapshotFile); } catch { /* 已不存在 */ }
  closeReviewTabs(b.path);
}

function scanFolder(folder: vscode.WorkspaceFolder) {
  const dir = path.join(folder.uri.fsPath, BASELINE_DIR);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) loadSnapshot(path.join(dir, f));
}

// ---------- 行內 diff 檢視（刪除的行以真正的紅色區塊顯示） ----------

function isReviewTab(tab: vscode.Tab, filePath?: string): boolean {
  const input = tab.input;
  return input instanceof vscode.TabInputTextDiff
    && input.original.scheme === BASELINE_SCHEME
    && (filePath === undefined || key(input.modified.fsPath) === key(filePath));
}

function closeReviewTabs(filePath: string) {
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => isReviewTab(t, filePath));
  if (tabs.length > 0) void vscode.window.tabGroups.close(tabs);
}

// 編輯器是否正位於本擴充套件開的 diff 檢視中（diff 自己會畫紅綠，不需再加裝飾）
function inReviewDiff(editor: vscode.TextEditor): boolean {
  const group = vscode.window.tabGroups.all.find(g => g.viewColumn === editor.viewColumn);
  return !!group?.activeTab && isReviewTab(group.activeTab, editor.document.uri.fsPath);
}

let extContext: vscode.ExtensionContext;

// diff 檢視預設是左右對照，且不顯示 CodeLens；第一次使用時詢問是否切成行內模式
async function ensureInlineSettings() {
  const cfg = vscode.workspace.getConfiguration('diffEditor');
  if (cfg.get('renderSideBySide') === false && cfg.get('codeLens') === true) return;
  if (extContext.globalState.get('inlineSettingsAsked')) return;
  await extContext.globalState.update('inlineSettingsAsked', true);
  const pick = await vscode.window.showInformationMessage(
    'Claude Inline Diff：要把 VS Code 的 diff 檢視改為「行內模式」並顯示接受 / 拒絕按鈕嗎？（會套用到所有 diff 檢視）',
    '套用', '保持原樣');
  if (pick !== '套用') return;
  await cfg.update('renderSideBySide', false, vscode.ConfigurationTarget.Global);
  await cfg.update('codeLens', true, vscode.ConfigurationTarget.Global);
}

async function openReview(filePath: string, preserveFocus = false) {
  void ensureInlineSettings();
  const file = vscode.Uri.file(filePath);
  await vscode.commands.executeCommand(
    'vscode.diff', baseUri(filePath), file,
    `${path.basename(filePath)}（Claude 的修改）`,
    { preview: false, preserveFocus },
  );
}

function currentText(b: Baseline): string | undefined {
  const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && key(d.uri.fsPath) === key(b.path));
  if (doc) return doc.getText();
  try { return fs.readFileSync(b.path, 'utf8'); } catch { return undefined; }
}

// Claude 一改完檔案就自動開啟行內 diff
function autoOpenReviews() {
  if (!vscode.workspace.getConfiguration('claudeInlineDiff').get('autoOpen', true)) return;
  for (const [k, b] of baselines) {
    if (reviewOpened.has(k)) continue;
    const text = currentText(b);
    if (text === undefined || sameText(b.content, text)) continue;
    reviewOpened.add(k);
    void openReview(b.path, true);
  }
}

// ---------- 一般編輯器中的提示（未開 diff 時） ----------

const addedDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

const removedMarkerDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  borderStyle: 'solid',
  borderWidth: '2px 0 0 0',
  borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});

function removedHover(h: Hunk): vscode.MarkdownString {
  const md = new vscode.MarkdownString(`**Claude 刪除了 ${h.removed.length} 行：**`);
  md.appendCodeblock(h.removed.join('\n'));
  return md;
}

function refreshEditor(editor: vscode.TextEditor) {
  const doc = editor.document;
  const hunks = inReviewDiff(editor) ? [] : hunksFor(doc);
  const added: vscode.DecorationOptions[] = [];
  const markers: vscode.DecorationOptions[] = [];
  const last = Math.max(0, doc.lineCount - 1);

  for (const h of hunks) {
    for (let k = 0; k < h.added.length && h.cStart + k <= last; k++) {
      added.push({ range: doc.lineAt(h.cStart + k).range });
    }
    if (h.removed.length > 0) {
      markers.push({ range: doc.lineAt(Math.min(h.cStart, last)).range, hoverMessage: removedHover(h) });
    }
  }
  editor.setDecorations(addedDeco, added);
  editor.setDecorations(removedMarkerDeco, markers);
}

let statusItem: vscode.StatusBarItem;

function refreshAll() {
  autoOpenReviews();
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
      new vscode.CodeLens(top, { title: `$(sparkle) Claude 修改了 ${hunks.length} 處（行內檢視）`, command: 'claudeInlineDiff.openReview', arguments: [uri] }),
      new vscode.CodeLens(top, { title: '$(check-all) 全部接受', command: 'claudeInlineDiff.acceptFile', arguments: [uri] }),
      new vscode.CodeLens(top, { title: '$(close-all) 全部拒絕', command: 'claudeInlineDiff.rejectFile', arguments: [uri] }),
    ];
    hunks.forEach((h, idx) => {
      const line = Math.min(h.cStart, last);
      const r = new vscode.Range(line, 0, line, 0);
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

async function settleIfDone(doc: vscode.TextDocument, b: Baseline) {
  if (!sameText(b.content, doc.getText())) return;
  clearBaseline(b);
  // 審完後回到一般編輯器
  await vscode.window.showTextDocument(doc, { preview: false });
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
  await settleIfDone(doc, b);
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
  await settleIfDone(doc, b);
  refreshAll();
}

async function acceptFile(uriStr?: string) {
  const doc = await resolveDoc(uriStr);
  const b = doc && baselineFor(doc);
  if (!doc || !b) return;
  clearBaseline(b);
  await vscode.window.showTextDocument(doc, { preview: false });
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
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputText && key(t.input.uri.fsPath) === key(b.path));
    await vscode.window.tabGroups.close(tabs);
    await vscode.workspace.fs.delete(doc.uri, { useTrash: true });
  } else {
    await replaceDoc(doc, splitLines(b.content).join(eolOf(doc)));
    clearBaseline(b);
    await vscode.window.showTextDocument(doc, { preview: false });
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
  if (pick) await openReview(pick.path);
}

async function openReviewCommand(uriStr?: string) {
  const doc = await resolveDoc(uriStr);
  if (doc && baselineFor(doc)) await openReview(doc.uri.fsPath);
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
      settings = JSON.parse(stripBom(fs.readFileSync(settingsPath, 'utf8')));
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
  extContext = context;
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
  // 已在檢視中的檔案不再自動重開
  for (const t of vscode.window.tabGroups.all.flatMap(g => g.tabs)) {
    if (isReviewTab(t)) reviewOpened.add(key((t.input as vscode.TabInputTextDiff).modified.fsPath));
  }

  context.subscriptions.push(
    statusItem,
    addedDeco, removedMarkerDeco,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new HunkCodeLens()),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      onDidChange: baselineDocEmitter.event,
      provideTextDocumentContent: uri => baselines.get(key(uri.query))?.content ?? '',
    }),
    vscode.workspace.onDidChangeTextDocument(e => { if (baselineFor(e.document)) scheduleRefresh(); }),
    vscode.window.onDidChangeVisibleTextEditors(scheduleRefresh),
    vscode.window.tabGroups.onDidChangeTabs(scheduleRefresh),
    vscode.commands.registerCommand('claudeInlineDiff.installHook', () => installHook(context)),
    vscode.commands.registerCommand('claudeInlineDiff.acceptHunk', acceptHunk),
    vscode.commands.registerCommand('claudeInlineDiff.rejectHunk', rejectHunk),
    vscode.commands.registerCommand('claudeInlineDiff.acceptFile', acceptFile),
    vscode.commands.registerCommand('claudeInlineDiff.rejectFile', rejectFile),
    vscode.commands.registerCommand('claudeInlineDiff.nextHunk', () => jumpHunk(1)),
    vscode.commands.registerCommand('claudeInlineDiff.prevHunk', () => jumpHunk(-1)),
    vscode.commands.registerCommand('claudeInlineDiff.listFiles', listFiles),
    vscode.commands.registerCommand('claudeInlineDiff.openReview', openReviewCommand),
  );
  refreshAll();
}

export function deactivate() {}
