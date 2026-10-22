import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { stripBom } from './diff';
import {
  SessionStore, FileSession, ReviewHunk, acceptInSession, rejectInSession, isSettled, currentText, openDocument,
} from './session';
import { ReviewManager } from './review';
import { ChangedFilesView, CHANGED_FILES_VIEWS } from './changedFiles';

const HOOK_SCRIPT = 'inline-diff-snapshot.js';
const BASELINE_SCHEME = 'claude-inline-diff-base';

let store: SessionStore;
let reviews: ReviewManager;

// ---------- 文件編輯 ----------

// 以 WorkspaceEdit 把目前文件第 start 行起的 count 行換成 lines（可正常 Undo / Redo）
function replaceLines(edit: vscode.WorkspaceEdit, doc: vscode.TextDocument, start: number, count: number, lines: string[]) {
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const end = start + count;
  if (end < doc.lineCount) {
    edit.replace(doc.uri, new vscode.Range(start, 0, end, 0), lines.map(l => l + eol).join(''));
  } else if (start === 0) {
    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), lines.join(eol));
  } else {
    // 修改觸及檔尾：從上一行行尾開始取代，避免多出或吃掉最後的換行
    const from = doc.lineAt(start - 1).range.end;
    const to = doc.lineAt(doc.lineCount - 1).range.end;
    edit.replace(doc.uri, new vscode.Range(from, to), lines.map(l => eol + l).join(''));
  }
}

async function saveIfWasClean(doc: vscode.TextDocument, wasDirty: boolean) {
  // 原本沒有未儲存內容才自動存檔，讓 Claude Code 下一輪讀到復原後的內容；不替使用者存下他自己的未儲存修改
  if (!wasDirty) await doc.save();
}

function settle(s: FileSession) {
  if (isSettled(s, currentText(s.path))) store.clear(s);
  else store.save(s);
}

// ---------- 單一 hunk ----------

async function acceptHunk(filePath: string, id: string) {
  const s = store.get(filePath);
  const h = reviews.findHunk(filePath, id);
  if (!s || !h) return staleNotice();
  acceptInSession(s, h);
  settle(s);
  reviews.refresh();
}

async function rejectHunk(filePath: string, id: string) {
  const s = store.get(filePath);
  const h = reviews.findHunk(filePath, id);
  if (!s || !h) return staleNotice();
  if (h.status === 'conflicted') return explainConflict();
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.path));
  // 套用前再核對一次，避免文件已變動而還原到錯誤位置
  const fresh = reviews.findHunk(filePath, id);
  if (!fresh || fresh.status !== 'pending' || !linesMatch(doc, fresh)) return explainConflict();
  const wasDirty = doc.isDirty;
  const edit = new vscode.WorkspaceEdit();
  replaceLines(edit, doc, fresh.curStart, fresh.added.length, fresh.removed);
  if (!await vscode.workspace.applyEdit(edit)) return;
  rejectInSession(s, fresh);
  await saveIfWasClean(doc, wasDirty);
  settle(s);
  reviews.refresh();
}

function linesMatch(doc: vscode.TextDocument, h: ReviewHunk): boolean {
  return h.added.every((l, i) => h.curStart + i < doc.lineCount && doc.lineAt(h.curStart + i).text === l);
}

function staleNotice() {
  vscode.window.showInformationMessage('這段修改已經處理過或已過時，畫面已重新整理。');
  reviews.refresh();
}

function explainConflict() {
  vscode.window.showWarningMessage('這段 Claude 的修改之後又被手動編輯過，為避免覆蓋你的修改，無法自動復原。可以選擇保留，或手動調整後再保留。');
}

// ---------- 整個檔案 / 整個 Session ----------

async function acceptFile(filePath?: string) {
  const p = filePath ?? activePath();
  const s = p ? store.get(p) : undefined;
  if (!s) return;
  // 只把 AI 的變更併入 base；使用者的手動修改本來就不在審查範圍
  s.base = s.ai ?? stripBom(currentText(s.path) ?? '');
  store.clear(s);
  reviews.refresh();
}

// 復原檔案中所有待審查的變更；有衝突的區塊跳過並回報筆數
async function rejectFile(filePath?: string, opts: { quiet?: boolean } = {}): Promise<number> {
  const p = filePath ?? activePath();
  const s = p ? store.get(p) : undefined;
  const review = p ? reviews.review(p) : undefined;
  if (!s || !review) return 0;

  if (review.missing) {
    // 檔案已被刪除：用 AI 修改前的內容重建
    if (s.existed) await vscode.workspace.fs.writeFile(vscode.Uri.file(s.path), Buffer.from(s.base, 'utf8'));
    store.clear(s);
    reviews.refresh();
    return 0;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(s.path));
  const pending = review.hunks.filter(h => h.status === 'pending' && linesMatch(doc, h));
  const conflicted = review.hunks.length - pending.length;
  const wasDirty = doc.isDirty;
  if (pending.length) {
    const edit = new vscode.WorkspaceEdit();
    for (const h of pending) replaceLines(edit, doc, h.curStart, h.added.length, h.removed);
    if (!await vscode.workspace.applyEdit(edit)) return conflicted;
    // 由後往前更新 ai，避免位移
    for (const h of [...pending].sort((a, b) => b.aiStart - a.aiStart)) rejectInSession(s, h);
    await saveIfWasClean(doc, wasDirty);
  }

  if (!s.existed && conflicted === 0 && doc.getText().trim() === '') {
    // Claude 新建的檔案全部復原後是空的：詢問是否刪除檔案
    const ok = opts.quiet ? '保留空檔案' : await vscode.window.showWarningMessage(
      `${path.basename(s.path)} 是 Claude 新建的檔案，已復原為空白。要移到資源回收筒嗎？`, '移除檔案', '保留空檔案');
    if (ok === '移除檔案') {
      store.clear(s);
      await vscode.workspace.fs.delete(doc.uri, { useTrash: true });
      reviews.refresh();
      return 0;
    }
  }
  settle(s);
  reviews.refresh();
  if (conflicted && !opts.quiet) {
    vscode.window.showWarningMessage(`${path.basename(s.path)} 有 ${conflicted} 處修改之後被手動編輯過，已略過未復原。`);
  }
  return conflicted;
}

async function acceptAll() {
  for (const r of reviews.reviews()) await acceptFile(r.session.path);
}

async function rejectAll(opts: { confirm?: boolean } = {}) {
  const files = reviews.reviews();
  if (!files.length) return;
  if (opts.confirm !== false) {
    const ok = await vscode.window.showWarningMessage(
      `要復原 Claude 在 ${files.length} 個檔案中的所有待審查修改嗎？（之後被手動編輯過的區塊會略過）`, { modal: true }, '全部復原');
    if (ok !== '全部復原') return;
  }
  let conflicted = 0;
  for (const r of files) conflicted += await rejectFile(r.session.path, { quiet: true });
  if (conflicted) vscode.window.showWarningMessage(`共有 ${conflicted} 處修改之後被手動編輯過，已略過未復原，請手動處理。`);
}

// ---------- 開檔與導覽 ----------

function activePath(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

// 開啟原始檔案（已開啟就切過去，不重複開分頁）並定位到第一個待審查的修改
async function openChangedFile(filePath: string) {
  const review = reviews.review(filePath);
  if (review?.missing) {
    const pick = await vscode.window.showWarningMessage(`${path.basename(filePath)} 已被刪除。`, '復原檔案', '確認刪除');
    if (pick === '復原檔案') await rejectFile(filePath);
    if (pick === '確認刪除') await acceptFile(filePath);
    return;
  }
  const doc = openDocument(filePath) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const first = reviews.review(filePath)?.hunks.find(h => h.status === 'pending') ?? reviews.review(filePath)?.hunks[0];
  if (first) reveal(editor, first);
}

function reveal(editor: vscode.TextEditor, h: ReviewHunk) {
  const line = Math.min(h.curStart, editor.document.lineCount - 1);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  // 往上多留幾行，讓上方的刪除區塊也在畫面內
  const top = new vscode.Position(Math.max(0, line - h.removed.length - 3), 0);
  editor.revealRange(new vscode.Range(top, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// 在刪除標示處開啟 hover，顯示完整的刪除 / 修改前內容
async function showDeleted(filePath: string, id: string) {
  const h = reviews.findHunk(filePath, id);
  if (!h) return staleNotice();
  const doc = openDocument(filePath) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const line = reviews.markerLine(h, doc.lineCount);
  const pos = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await vscode.commands.executeCommand('editor.action.showHover');
}

function jumpHunk(dir: 1 | -1) {
  const editor = vscode.window.activeTextEditor;
  const hunks = editor && reviews.review(editor.document.uri.fsPath)?.hunks;
  if (!editor || !hunks?.length) return;
  const cur = editor.selection.active.line;
  const sorted = [...hunks].sort((a, b) => a.curStart - b.curStart);
  const target = dir === 1
    ? sorted.find(h => h.curStart > cur) ?? sorted[0]
    : [...sorted].reverse().find(h => h.curStart < cur) ?? sorted[sorted.length - 1];
  reveal(editor, target);
}

async function listFiles() {
  const items = reviews.reviews().map(r => ({
    label: path.basename(r.session.path),
    description: `+${r.additions} -${r.deletions}  ${vscode.workspace.asRelativePath(r.session.path)}`,
    path: r.session.path,
  }));
  if (!items.length) {
    vscode.window.showInformationMessage('目前沒有待審查的 Claude 修改。');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: '選擇要審查的檔案' });
  if (pick) await openChangedFile(pick.path);
}

// 輔助：以 VS Code diff 檢視比對修改前與目前內容
async function compareFile(filePath?: string) {
  const p = filePath ?? activePath();
  if (!p || !store.get(p)) return;
  const base = vscode.Uri.from({ scheme: BASELINE_SCHEME, path: vscode.Uri.file(p).path, query: p });
  await vscode.commands.executeCommand('vscode.diff', base, vscode.Uri.file(p), `${path.basename(p)}（Claude 修改前 ↔ 目前）`);
}

async function startManualReview() {
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.uri.scheme !== 'file') return;
  store.startManual(doc.uri.fsPath, doc.getText());
  vscode.window.showInformationMessage(
    `已從目前內容開始追蹤 ${path.basename(doc.uri.fsPath)}。手動模式無法分辨 AI 與手動修改，之後此檔案的所有變更都會列入審查。`);
}

// ---------- hook 安裝 ----------

// 把 PreToolUse / PostToolUse hook 寫進工作區的 .claude/settings.local.json
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
  for (const event of ['PreToolUse', 'PostToolUse']) {
    // 移除舊版本留下的設定（擴充套件路徑會隨版本變動）
    settings.hooks[event] = (settings.hooks[event] ?? [])
      .map((m: any) => ({ ...m, hooks: (m.hooks ?? []).filter((h: any) => !String(h.command ?? '').includes(HOOK_SCRIPT)) }))
      .filter((m: any) => m.hooks.length > 0);
    settings.hooks[event].push({
      matcher: 'Edit|Write|MultiEdit',
      hooks: [{ type: 'command', command: `node "${script}"` }],
    });
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  vscode.window.showInformationMessage('已安裝 hook。請重新開始 Claude Code 對話以套用設定。');
}

// ---------- 自動開啟 ----------

const announced = new Map<string, string>();

// 選用：Claude 改完檔案後自動開啟該檔案並定位到修改處（預設關閉，改由「已變更檔案」清單開啟）
function autoOpen() {
  const live = new Set<string>();
  for (const r of reviews.reviews()) {
    const s = r.session;
    live.add(s.snapshotFile);
    const sig = `${s.ai?.length}:${r.hunks.length}`;
    if (announced.get(s.snapshotFile) === sig) continue;
    announced.set(s.snapshotFile, sig);
    if (!vscode.workspace.getConfiguration('claudeInlineDiff').get('autoOpen', false) || r.missing) continue;
    void vscode.window.showTextDocument(vscode.Uri.file(s.path), { preview: false, preserveFocus: true })
      .then(editor => { const h = r.hunks[0]; if (h) reveal(editor, h); });
  }
  for (const k of announced.keys()) if (!live.has(k)) announced.delete(k);
}

export function activate(context: vscode.ExtensionContext) {
  // 有裝 Claude Code 時，清單顯示在 Claude Code 側邊欄（聊天視窗下方）；否則顯示在本擴充套件自己的容器
  void vscode.commands.executeCommand('setContext', 'claudeInlineDiff.hasClaudeCode',
    !!vscode.extensions.getExtension('anthropic.claude-code'));
  store = new SessionStore();
  reviews = new ReviewManager(store);
  const view = new ChangedFilesView(reviews);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'claudeInlineDiff.listFiles';
  const updateStatus = () => {
    const n = reviews.reviews().length;
    status.text = `$(diff) Claude：${n} 個檔案待審查`;
    if (n) status.show(); else status.hide();
  };

  context.subscriptions.push(
    store, reviews, view, status,
    reviews.onDidChange(() => { updateStatus(); autoOpen(); }),
    ...CHANGED_FILES_VIEWS.map(id => vscode.window.registerWebviewViewProvider(id, view)),
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      provideTextDocumentContent: uri => store.get(uri.query)?.base ?? '',
    }),
    vscode.commands.registerCommand('claudeInlineDiff.installHook', () => installHook(context)),
    vscode.commands.registerCommand('claudeInlineDiff.acceptHunk', acceptHunk),
    vscode.commands.registerCommand('claudeInlineDiff.rejectHunk', rejectHunk),
    vscode.commands.registerCommand('claudeInlineDiff.showDeleted', showDeleted),
    vscode.commands.registerCommand('claudeInlineDiff.explainConflict', explainConflict),
    vscode.commands.registerCommand('claudeInlineDiff.acceptFile', (p?: string) => acceptFile(typeof p === 'string' ? p : undefined)),
    vscode.commands.registerCommand('claudeInlineDiff.rejectFile', (p?: string) => rejectFile(typeof p === 'string' ? p : undefined)),
    vscode.commands.registerCommand('claudeInlineDiff.acceptAll', acceptAll),
    vscode.commands.registerCommand('claudeInlineDiff.rejectAll', rejectAll),
    vscode.commands.registerCommand('claudeInlineDiff.openChangedFile', openChangedFile),
    vscode.commands.registerCommand('claudeInlineDiff.nextHunk', () => jumpHunk(1)),
    vscode.commands.registerCommand('claudeInlineDiff.prevHunk', () => jumpHunk(-1)),
    vscode.commands.registerCommand('claudeInlineDiff.listFiles', listFiles),
    vscode.commands.registerCommand('claudeInlineDiff.compareFile', compareFile),
    vscode.commands.registerCommand('claudeInlineDiff.startManualReview', startManualReview),
    vscode.commands.registerCommand('claudeInlineDiff._debugState', () => ({ reviews: reviews.debugState(), view: view.state(), resolvedViews: view.resolvedViews() })),
  );
  reviews.refresh();
  updateStatus();
}

export function deactivate() {}
