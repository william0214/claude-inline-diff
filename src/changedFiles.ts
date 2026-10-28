import * as vscode from 'vscode';
import * as path from 'path';
import { ReviewManager } from './review';
import { fileKey } from './session';

// 「已變更 N 個檔案」清單（仿 Copilot Chat 下方的清單）
// 公開 API 無法把內容嵌進 Claude Code 的聊天 Webview，所以以 contributes.views 把本擴充套件自己的 Webview View
// 註冊到 Claude Code 的側邊欄容器中，顯示在 Claude Code 聊天視窗的下方（同一個容器、獨立的 View）。
// 沒裝 Claude Code 時改顯示在本擴充套件自己的活動列容器。
export const CHANGED_FILES_VIEWS = [
  'claudeInlineDiff.changedFiles',
  'claudeInlineDiff.changedFilesInClaude',
  'claudeInlineDiff.changedFilesInClaudeLegacy',
];

export class ChangedFilesView implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly views = new Set<vscode.WebviewView>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastCount = 0;

  constructor(private readonly reviews: ReviewManager) {
    this.disposables.push(
      reviews.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.views.add(view);
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage(msg => {
      switch (msg?.type) {
        case 'ready': this.update(); break;
        case 'open': vscode.commands.executeCommand('claudeInlineDiff.openChangedFile', msg.path); break;
        case 'acceptFile': vscode.commands.executeCommand('claudeInlineDiff.acceptFile', msg.path); break;
        case 'rejectFile': vscode.commands.executeCommand('claudeInlineDiff.rejectFile', msg.path); break;
        case 'acceptAll': vscode.commands.executeCommand('claudeInlineDiff.acceptAll'); break;
        case 'rejectAll': vscode.commands.executeCommand('claudeInlineDiff.rejectAll'); break;
      }
    }, undefined, this.disposables);
    view.onDidChangeVisibility(() => { if (view.visible) this.update(); }, undefined, this.disposables);
    view.onDidDispose(() => { this.views.delete(view); }, undefined, this.disposables);
  }

  // 測試用：目前已顯示的清單 View
  resolvedViews(): string[] {
    return [...this.views].map(v => v.viewType);
  }

  state() {
    const active = vscode.window.activeTextEditor?.document.uri;
    const activeKey = active?.scheme === 'file' ? fileKey(active.fsPath) : undefined;
    const files = this.reviews.reviews().map(r => {
      const p = r.session.path;
      const relative = vscode.workspace.asRelativePath(p);
      return {
        path: p,
        name: path.basename(p),
        dir: path.dirname(relative) === '.' ? '' : path.dirname(relative),
        relative,
        additions: r.additions,
        deletions: r.deletions,
        pending: r.hunks.filter(h => h.status === 'pending').length,
        conflicted: r.hunks.filter(h => h.status === 'conflicted').length,
        missing: r.missing,
        isNew: !r.session.existed,
        active: fileKey(p) === activeKey,
      };
    }).sort((a, b) => a.relative.localeCompare(b.relative));
    return {
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  }

  private update() {
    const state = this.state();
    const grew = state.files.length > this.lastCount;
    this.lastCount = state.files.length;
    for (const view of this.views) {
      view.badge = state.files.length
        ? { value: state.files.length, tooltip: `已變更 ${state.files.length} 個檔案待審查` }
        : undefined;
      view.description = state.files.length ? `${state.files.length} 個檔案待審查` : undefined;
      // 有新的檔案被修改時把清單展開到看得見（不搶走焦點）
      if (grew && !view.visible) view.show(true);
      void view.webview.postMessage({ type: 'state', state });
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }
}

function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return /* html */ `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { padding: 0; margin: 0; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .box { margin: 8px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 6px; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--vscode-sideBarSectionHeader-background, transparent); }
  .head .title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; user-select: none; }
  .head button { flex: none; padding: 2px 7px; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  button { font: inherit; border: 1px solid transparent; border-radius: 3px; padding: 2px 10px; cursor: pointer; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  ul { list-style: none; margin: 0; padding: 2px 0; }
  li { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 14px; cursor: pointer; }
  li:hover { background: var(--vscode-list-hoverBackground); }
  li.active { background: var(--vscode-list-inactiveSelectionBackground); }
  .icon { width: 16px; text-align: center; font-weight: 700; font-size: 10px; font-family: var(--vscode-editor-font-family); flex: none; }
  .name { white-space: nowrap; }
  .dir { opacity: .65; font-size: 90%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .stats { white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: 90%; }
  .pending { opacity: .6; font-size: 85%; white-space: nowrap; }
  li:hover .pending { display: none; }
  .tag { font-size: 85%; padding: 0 5px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
  .tag.warn { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-foreground); }
  .actions { display: none; gap: 2px; }
  li:hover .actions { display: flex; }
  li:hover .stats { display: none; }
  .actions button { padding: 0 6px; background: transparent; color: var(--vscode-foreground); }
  .actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .empty { padding: 12px 10px; opacity: .7; }
  .collapsed ul { display: none; }
  .chev { display: inline-block; transition: transform .1s; }
  .collapsed .chev { transform: rotate(-90deg); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let collapsed = (vscode.getState() || {}).collapsed || false;

  const ICONS = {
    json: ['{}', '#cbcb41'], ts: ['TS', '#3178c6'], tsx: ['TS', '#3178c6'], js: ['JS', '#cbcb41'], jsx: ['JS', '#cbcb41'],
    cs: ['C#', '#a074c4'], py: ['PY', '#3572a5'], java: ['J', '#cc3e44'], html: ['<>', '#e37933'], css: ['#', '#519aba'],
    scss: ['#', '#f55385'], md: ['M', '#519aba'], xml: ['<>', '#e37933'], yml: ['Y', '#a074c4'], yaml: ['Y', '#a074c4'],
    sql: ['DB', '#f55385'], go: ['GO', '#519aba'], rs: ['RS', '#e37933'], vue: ['V', '#8dc149'], cshtml: ['@', '#a074c4'],
  };
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function icon(name) {
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    const [text, color] = ICONS[ext] || ['•', 'var(--vscode-foreground)'];
    return '<span class="icon" style="color:' + color + '">' + esc(text) + '</span>';
  }

  function render(state) {
    if (!state.files.length) {
      root.innerHTML = '<div class="empty">沒有待審查的修改。</div>';
      return;
    }
    const rows = state.files.map(f => {
      const tags = [];
      if (f.missing) tags.push('<span class="tag warn">已刪除</span>');
      else if (f.isNew) tags.push('<span class="tag">新檔案</span>');
      if (f.conflicted) tags.push('<span class="tag warn" title="有 ' + f.conflicted + ' 處在修改後又被手動編輯">衝突 ' + f.conflicted + '</span>');
      return '<li class="' + (f.active ? 'active' : '') + '" data-path="' + esc(f.path) + '" title="' + esc(f.relative) + '\\n待審查 ' + f.pending + ' 處">'
        + icon(f.name)
        + '<span class="name">' + esc(f.name) + '</span>'
        + '<span class="dir">' + esc(f.dir) + '</span>'
        + tags.join('')
        + '<span class="pending" title="待審查的修改處數">' + f.pending + ' 處</span>'
        + '<span class="stats"><span class="add">+' + f.additions + '</span> <span class="del">-' + f.deletions + '</span></span>'
        + '<span class="actions">'
        + '<button data-act="acceptFile" title="保留此檔案的修改">✓</button>'
        + '<button data-act="rejectFile" title="復原此檔案的修改">↶</button>'
        + '</span></li>';
    }).join('');
    root.innerHTML = '<div class="box ' + (collapsed ? 'collapsed' : '') + '">'
      + '<div class="head"><span class="title" id="toggle"><span class="chev">⌄</span> 已變更 ' + state.files.length + ' 個檔案 '
      + '<span class="add">+' + state.additions + '</span> <span class="del">-' + state.deletions + '</span></span>'
      + '<button class="primary" data-act="acceptAll" title="全部保留：保留所有待審查的修改">✓ 保留</button>'
      + '<button class="secondary" data-act="rejectAll" title="全部復原：復原所有待審查的修改">↶ 復原</button></div>'
      + '<ul>' + rows + '</ul></div>';
  }

  root.addEventListener('click', e => {
    const btn = e.target.closest('button');
    const li = e.target.closest('li');
    if (e.target.closest('#toggle')) {
      collapsed = !collapsed;
      vscode.setState({ collapsed });
      root.querySelector('.box').classList.toggle('collapsed', collapsed);
      return;
    }
    if (btn) {
      vscode.postMessage({ type: btn.dataset.act, path: li ? li.dataset.path : undefined });
      e.stopPropagation();
      return;
    }
    if (li) vscode.postMessage({ type: 'open', path: li.dataset.path });
  });
  window.addEventListener('message', e => { if (e.data.type === 'state') render(e.data.state); });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
