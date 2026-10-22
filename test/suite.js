// 在測試用 VS Code 的 extension host 內執行：依需求文件的 Test 1–10 模擬 Claude 修改並驗證
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const ws = fs.realpathSync.native(process.env.INLINE_DIFF_E2E_WS);
const out = process.env.INLINE_DIFF_E2E_OUT;
const hook = process.env.INLINE_DIFF_HOOK;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const real = p => {
  try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.normalize(p).toLowerCase(); }
};
const file = name => path.join(ws, name);
const readNoBom = f => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');

async function waitFor(fn, what, ms = 10000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < ms) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`逾時：${what}${last instanceof Error ? '（' + last.message + '）' : ''}`);
}

function runHook(event, f) {
  cp.execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: ws, hook_event_name: event, session_id: 'e2e', tool_name: 'Edit', tool_input: { file_path: f } }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_PROJECT_DIR: ws },
  });
}

// 模擬 Claude Code 的一次 Edit：PreToolUse hook → 寫入磁碟 → PostToolUse hook
async function aiEdit(f, text) {
  runHook('PreToolUse', f);
  fs.writeFileSync(f, text);
  runHook('PostToolUse', f);
  // 等 VS Code 重新載入（未修改過的）文件
  const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === f.toLowerCase());
  if (doc && !doc.isDirty) await waitFor(() => doc.getText() === text, `${path.basename(f)} 重新載入`);
}

async function state() {
  return vscode.commands.executeCommand('claudeInlineDiff._debugState');
}

async function fileState(f) {
  return (await state()).reviews.find(r => real(r.path) === real(f));
}

async function waitFile(f, pred, what) {
  return waitFor(async () => { const s = await fileState(f); return pred(s) && s; }, what);
}

async function waitCleared(f) {
  await waitFor(async () => !(await fileState(f)), `${path.basename(f)} 審查完成`);
}

async function screenshot(name) {
  await sleep(1200);
  const req = path.join(out, 'shot-request');
  fs.writeFileSync(req, name);
  await waitFor(() => fs.existsSync(req + '.done'), '截圖', 20000);
  fs.unlinkSync(req + '.done');
}

async function edit(f, fn) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
  const we = new vscode.WorkspaceEdit();
  fn(we, doc);
  assert.ok(await vscode.workspace.applyEdit(we));
  return doc;
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (e) {
    results.push(`✘ ${name}：${e.message}`);
    console.error(e);
  }
}

const exec = (cmd, ...args) => vscode.commands.executeCommand(cmd, ...args);

async function run() {
  try {
    await vscode.extensions.getExtension('local.claude-inline-diff').activate();
    const fixture = readNoBom(path.join(__dirname, 'fixtures', 'appsettings.json'));

    // ---- Test 0 + 4：重新載入後恢復；參考圖片的 appsettings.json（刪除 + 修改） ----
    const app = file('appsettings.json');
    await step('Reload 後恢復審查狀態，appsettings 拆成「刪除」與「修改」兩段', async () => {
      const s = await waitFile(app, s => s && s.hunks.length === 2, 'appsettings 兩段修改');
      assert.deepStrictEqual(s.hunks.map(h => h.type), ['delete', 'modify']);
      assert.strictEqual(s.additions, 1);
      assert.strictEqual(s.deletions, 6);
    });
    await step('原始檔案編輯器：精簡 CodeLens、刪除內容在 hover、沒有大型區塊', async () => {
      await exec('claudeInlineDiff.openChangedFile', app);
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor && real(editor.document.uri.fsPath) === real(app), '開啟的是原始檔案');
      assert.ok(!(vscode.window.tabGroups.activeTabGroup.activeTab.input instanceof vscode.TabInputTextDiff), '不是 diff 編輯器');
      const s = await fileState(app);
      assert.strictEqual(editor.selection.active.line, s.hunks[0].curStart, '定位到第一個修改');
      const [del, mod] = s.hunks;
      assert.ok(del.summary.startsWith('⊖ 已刪除 5 行'), del.summary);
      assert.ok(del.hover.includes('快速入口') && del.hover.includes('Permissions'), '完整刪除內容');
      assert.ok(mod.summary.includes('原：') && mod.summary.includes('我的差勤'), mod.summary);
      const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', editor.document.uri);
      const titles = lenses.map(l => l.command && l.command.title);
      assert.strictEqual(titles.filter(t => t === '✓ 保留').length, 2);
      assert.strictEqual(titles.filter(t => t === '↶ 復原').length, 2);
      assert.strictEqual(editor.document.getText(), readNoBom(app), '沒有寫入任何虛擬內容');
      if (process.env.INLINE_DIFF_WITH_CLAUDE) {
        await exec('workbench.view.extension.claude-sidebar-secondary');
        await waitFor(async () => (await state()).resolvedViews.includes('claudeInlineDiff.changedFilesInClaude'),
          '清單顯示在 Claude Code 側邊欄');
      } else {
        await exec('workbench.view.extension.claudeInlineDiff');
        await waitFor(async () => (await state()).resolvedViews.length > 0, '清單已顯示');
      }
      await vscode.window.showTextDocument(editor.document);
      await screenshot('1-appsettings.png');
      await exec('claudeInlineDiff.showDeleted', app, del.id);
      await screenshot('2-deleted-hover.png');
      await exec('editor.action.hideHover').then(undefined, () => undefined);
    });
    await step('Test 4｜保留修改、復原刪除，JSON 結構正確', async () => {
      let s = await fileState(app);
      await exec('claudeInlineDiff.acceptHunk', app, s.hunks.find(h => h.type === 'modify').id);
      s = await waitFile(app, s => s && s.hunks.length === 1, '剩 1 段');
      await exec('claudeInlineDiff.rejectHunk', app, s.hunks[0].id);
      await waitCleared(app);
      const text = readNoBom(app);
      const json = JSON.parse(text);
      const titles = json.SiteMenu.MenuItems.map(m => m.Title);
      assert.deepStrictEqual(titles, ['快速入口', '我的差勤差勤']);
      assert.strictEqual(text, fixture.replace('"我的差勤"', '"我的差勤差勤"'), '排版完全一致');
      assert.deepStrictEqual([...fs.readFileSync(app).subarray(0, 3)], [0xef, 0xbb, 0xbf], '保留 BOM');
    });

    // ---- Test 1：只新增 ----
    await step('Test 1｜只新增 3 行：+3、可復原', async () => {
      const f = file('add.js');
      const before = 'function a() {\n  return 1;\n}\n';
      fs.writeFileSync(f, before);
      await aiEdit(f, 'function a() {\n  return 1;\n}\n// x\n// y\n// z\n');
      const s = await waitFile(f, s => s && s.hunks.length === 1, '新增 hunk');
      assert.strictEqual(s.additions, 3);
      assert.strictEqual(s.deletions, 0);
      assert.strictEqual(s.hunks[0].type, 'add');
      assert.strictEqual(s.hunks[0].summary, undefined, '純新增沒有刪除說明');
      await exec('claudeInlineDiff.rejectHunk', f, s.hunks[0].id);
      await waitCleared(f);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
    });

    // ---- Test 2：只刪除 ----
    await step('Test 2｜刪除完整 JSON 物件：看得到原內容、可復原且 JSON 正確', async () => {
      const f = file('menu.json');
      const before = '[\n  {\n    "Title": "A",\n    "Page": "a"\n  },\n  {\n    "Title": "B",\n    "Page": "b"\n  }\n]\n';
      fs.writeFileSync(f, before);
      await aiEdit(f, '[\n  {\n    "Title": "B",\n    "Page": "b"\n  }\n]\n');
      const s = await waitFile(f, s => s && s.hunks.length === 1, '刪除 hunk');
      assert.strictEqual(s.hunks[0].type, 'delete');
      assert.strictEqual(s.deletions, 4);
      assert.ok(s.hunks[0].hover.includes('"A"'), 'hover 顯示被刪的物件');
      await exec('claudeInlineDiff.rejectHunk', f, s.hunks[0].id);
      await waitCleared(f);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
      JSON.parse(fs.readFileSync(f, 'utf8'));
    });

    // ---- Test 3：修改單行 ----
    await step('Test 3｜修改單行：保留後是新文字、復原後是原文字', async () => {
      const f = file('title.json');
      const before = '{\n  "Title": "我的差勤"\n}\n';
      const after = '{\n  "Title": "我的差勤差勤"\n}\n';
      fs.writeFileSync(f, before);
      await aiEdit(f, after);
      let s = await waitFile(f, s => s && s.hunks.length === 1, '修改 hunk');
      assert.strictEqual(s.hunks[0].type, 'modify');
      assert.deepStrictEqual(s.hunks[0].removed, ['  "Title": "我的差勤"']);
      assert.deepStrictEqual(s.hunks[0].added, ['  "Title": "我的差勤差勤"']);
      await exec('claudeInlineDiff.acceptHunk', f, s.hunks[0].id);
      await waitCleared(f);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), after);

      await aiEdit(f, before);
      s = await waitFile(f, s => s && s.hunks.length === 1, '第二次修改');
      await exec('claudeInlineDiff.rejectHunk', f, s.hunks[0].id);
      await waitCleared(f);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), after);
    });

    // ---- Test 5：多檔案 ----
    await step('Test 5｜三個檔案：清單列出三個、點擊開啟原始檔案並定位', async () => {
      const files = ['one.ts', 'two.ts', 'three.ts'].map(file);
      for (const [i, f] of files.entries()) {
        fs.writeFileSync(f, `export const a = 1;\nexport const b = 2;\nexport const c = ${i};\n`);
      }
      for (const [i, f] of files.entries()) {
        await aiEdit(f, `export const a = 1;\nexport const b = 20;\nexport const c = ${i};\nexport const d = ${i};\n`);
      }
      const st = await waitFor(async () => { const s = await state(); return s.view.files.length === 3 && s; }, '清單 3 個檔案');
      assert.deepStrictEqual(st.view.files.map(f => f.name).sort(), ['one.ts', 'three.ts', 'two.ts']);
      for (const f of st.view.files) {
        assert.strictEqual(f.additions, 2);
        assert.strictEqual(f.deletions, 1);
      }
      for (const f of files) {
        await exec('claudeInlineDiff.openChangedFile', f);
        const ed = vscode.window.activeTextEditor;
        assert.ok(real(ed.document.uri.fsPath) === real(f));
        assert.strictEqual(ed.selection.active.line, 1);
      }
      // 再開一次同一個檔案不會多開分頁
      await exec('claudeInlineDiff.openChangedFile', files[0]);
      const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
        .filter(t => t.input instanceof vscode.TabInputText && real(t.input.uri.fsPath) === real(files[0]));
      assert.strictEqual(tabs.length, 1);
      await screenshot('3-changed-files.png');
      await exec('claudeInlineDiff.rejectAll', { confirm: false });
      for (const [i, f] of files.entries()) {
        await waitCleared(f);
        assert.strictEqual(fs.readFileSync(f, 'utf8'), `export const a = 1;\nexport const b = 2;\nexport const c = ${i};\n`);
      }
    });

    // ---- Test 6：沒有 AI session 時的手動編輯 ----
    await step('Test 6｜手動編輯不產生審查項目', async () => {
      const f = file('manual.txt');
      fs.writeFileSync(f, 'a\nb\n');
      const doc = await edit(f, (we, d) => we.insert(d.uri, new vscode.Position(1, 0), 'typed by user\n'));
      await doc.save();
      await sleep(400);
      assert.ok(!(await fileState(f)));
      assert.strictEqual((await state()).view.files.length, 0);
    });

    // ---- Test 7：行號位移 ----
    await step('Test 7｜AI 修改後在前面插入多行：位置正確、復原到正確位置', async () => {
      const f = file('shift.txt');
      const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
      fs.writeFileSync(f, lines.join('\n') + '\n');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
      await vscode.window.showTextDocument(doc);
      const ai = lines.slice();
      ai[8] = 'line 8 changed by AI';
      await aiEdit(f, ai.join('\n') + '\n');
      let s = await waitFile(f, s => s && s.hunks.length === 1, 'hunk');
      assert.strictEqual(s.hunks[0].curStart, 8);
      await edit(f, (we, d) => we.insert(d.uri, new vscode.Position(0, 0), 'u1\nu2\nu3\n'));
      s = await waitFile(f, s => s.hunks[0].curStart === 11, '位移 +3');
      assert.strictEqual(s.hunks[0].status, 'pending');
      await exec('claudeInlineDiff.rejectHunk', f, s.hunks[0].id);
      await waitCleared(f);
      assert.strictEqual(doc.getText(), ['u1', 'u2', 'u3', ...lines].join('\n') + '\n');
      await doc.save();

      // 使用者改到 AI 修改的那一行 → 衝突，拒絕不得覆蓋
      const ai2 = ['u1', 'u2', 'u3', ...lines];
      ai2[5] = 'AI again';
      await aiEdit(f, ai2.join('\n') + '\n');
      s = await waitFile(f, s => s && s.hunks.length === 1, '第二次修改');
      await edit(f, (we, d) => we.replace(d.uri, d.lineAt(5).range, 'user rewrote it'));
      s = await waitFile(f, s => s.hunks[0].status === 'conflicted', '標示衝突');
      await exec('claudeInlineDiff.rejectHunk', f, s.hunks[0].id);
      await sleep(300);
      assert.strictEqual(doc.lineAt(5).text, 'user rewrote it', '衝突時不復原');
      await exec('claudeInlineDiff.acceptFile', f);
      await waitCleared(f);
      await doc.save();
    });

    // ---- Test 8：部分接受 / 拒絕 ----
    await step('Test 8｜三段修改：第一段保留、第二段復原、第三段待審', async () => {
      const f = file('three.txt');
      const lines = Array.from({ length: 15 }, (_, i) => `row ${i}`);
      fs.writeFileSync(f, lines.join('\n') + '\n');
      const ai = lines.slice();
      ai[1] = 'row 1 AI';
      ai[7] = 'row 7 AI';
      ai[13] = 'row 13 AI';
      await aiEdit(f, ai.join('\n') + '\n');
      let s = await waitFile(f, s => s && s.hunks.length === 3, '三段');
      const [h1, h2, h3] = s.hunks;
      await exec('claudeInlineDiff.acceptHunk', f, h1.id);
      s = await waitFile(f, s => s.hunks.length === 2, '剩兩段');
      await exec('claudeInlineDiff.rejectHunk', f, h2.id);
      s = await waitFile(f, s => s.hunks.length === 1, '剩一段');
      assert.strictEqual(s.hunks[0].id, h3.id);
      assert.strictEqual(s.hunks[0].status, 'pending');
      const now = readNoBom(f).split('\n');
      assert.strictEqual(now[1], 'row 1 AI');
      assert.strictEqual(now[7], 'row 7');
      assert.strictEqual(now[13], 'row 13 AI');
      await exec('claudeInlineDiff.acceptFile', f);
      await waitCleared(f);
    });

    // ---- Test 9：文件有未儲存修改 ----
    await step('Test 9｜未儲存的手動修改不被算成 AI 修改、不遺失', async () => {
      const f = file('dirty.txt');
      fs.writeFileSync(f, 'one\ntwo\nthree\n');
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(f));
      await vscode.window.showTextDocument(doc);
      await edit(f, (we, d) => we.insert(d.uri, new vscode.Position(0, 0), 'unsaved user line\n'));
      assert.ok(doc.isDirty);
      await aiEdit(f, 'one\ntwo AI\nthree\n');
      const s = await waitFile(f, s => s && s.hunks.length === 1, 'AI hunk');
      assert.ok(s.hunks.every(h => !h.added.includes('unsaved user line')), '手動修改不是 AI 修改');
      assert.ok(doc.getText().startsWith('unsaved user line\n'), '未儲存內容還在');
      await exec('claudeInlineDiff.acceptFile', f);
      await waitCleared(f);
      await exec('workbench.action.files.revert');
    });

    await step('多次 AI 修改之間的手動修改不被算成 AI 修改', async () => {
      const f = file('between.txt');
      fs.writeFileSync(f, 'a\nb\nc\nd\n');
      await aiEdit(f, 'a\nB\nc\nd\n');
      fs.writeFileSync(f, 'a\nB\nc\nd\nuser line\n');
      await aiEdit(f, 'a\nB\nc\nD\nuser line\n');
      const s = await waitFile(f, s => s && s.hunks.length === 2, '兩段 AI 修改');
      assert.ok(s.hunks.every(h => !h.added.includes('user line')));
      await exec('claudeInlineDiff.rejectFile', f);
      await waitCleared(f);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), 'a\nb\nc\nd\nuser line\n');
    });

    // ---- Test 10：特殊檔案狀態 ----
    await step('Test 10｜空檔案、新檔案、刪除、重新命名、重複區塊', async () => {
      const empty = file('empty.txt');
      fs.writeFileSync(empty, '');
      await aiEdit(empty, 'hello\n');
      let s = await waitFile(empty, s => s && s.hunks.length === 1, '空檔案');
      await exec('claudeInlineDiff.rejectHunk', empty, s.hunks[0].id);
      await waitCleared(empty);
      assert.strictEqual(fs.readFileSync(empty, 'utf8'), '');

      const created = file('created.txt');
      await aiEdit(created, 'new file\n');
      s = await waitFile(created, s => s && s.additions === 1, '新檔案');
      assert.ok((await state()).view.files.find(f => f.name === 'created.txt').isNew);
      await exec('claudeInlineDiff.acceptFile', created);
      await waitCleared(created);

      const gone = file('gone.txt');
      fs.writeFileSync(gone, 'keep me\n');
      await aiEdit(gone, 'keep me\nAI\n');
      await waitFile(gone, s => s && s.hunks.length === 1, 'gone hunk');
      fs.unlinkSync(gone);
      await waitFile(gone, s => s && s.missing, '標示已刪除');
      await exec('claudeInlineDiff.rejectFile', gone);
      await waitCleared(gone);
      assert.strictEqual(fs.readFileSync(gone, 'utf8'), 'keep me\n');

      const ren = file('ren-old.txt');
      fs.writeFileSync(ren, 'x\n');
      await aiEdit(ren, 'x\ny\n');
      await waitFile(ren, s => s && s.hunks.length === 1, 'ren hunk');
      const we = new vscode.WorkspaceEdit();
      we.renameFile(vscode.Uri.file(ren), vscode.Uri.file(file('ren-new.txt')));
      assert.ok(await vscode.workspace.applyEdit(we));
      await waitFile(file('ren-new.txt'), s => s && s.hunks.length === 1, '重新命名後跟著走');
      await exec('claudeInlineDiff.acceptFile', file('ren-new.txt'));
      await waitCleared(file('ren-new.txt'));

      const dup = file('dup.txt');
      const block = ['begin', '  same', 'end'];
      const before = [...block, 'mid', ...block].join('\n') + '\n';
      fs.writeFileSync(dup, before);
      await aiEdit(dup, [...block, 'mid'].join('\n') + '\n');
      s = await waitFile(dup, s => s && s.hunks.length === 1, '重複區塊刪除');
      await exec('claudeInlineDiff.rejectHunk', dup, s.hunks[0].id);
      await waitCleared(dup);
      assert.strictEqual(fs.readFileSync(dup, 'utf8'), before);
    });

    await step('結束時沒有殘留的審查項目', async () => {
      const st = await state();
      assert.strictEqual(st.reviews.length, 0, JSON.stringify(st.reviews.map(r => r.path)));
    });
  } finally {
    fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n') + '\n');
    console.log('\n' + results.join('\n'));
  }
  if (results.some(r => r.startsWith('✘'))) throw new Error('有測試失敗');
}

module.exports = { run };
