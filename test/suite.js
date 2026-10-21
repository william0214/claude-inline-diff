// 在測試用 VS Code 的 extension host 內執行
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const ws = fs.realpathSync.native(process.env.INLINE_DIFF_E2E_WS);
const out = process.env.INLINE_DIFF_E2E_OUT;
const hook = process.env.INLINE_DIFF_HOOK;
const baseDir = path.join(ws, '.claude', 'inline-diff');

const real = p => fs.realpathSync.native(p).toLowerCase();
const sleep = ms =>new Promise(r => setTimeout(r, ms));

async function waitFor(fn, what, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`逾時：${what}`);
}

function runHook(file) {
  cp.execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: ws, tool_name: 'Edit', tool_input: { file_path: file } }),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_PROJECT_DIR: ws },
  });
}

function reviewTab(file) {
  return vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t =>
    t.input instanceof vscode.TabInputTextDiff
    && t.input.original.scheme === 'claude-inline-diff-base'
    && real(t.input.modified.fsPath) === real(file));
}

const snapshots = () => fs.existsSync(baseDir) ? fs.readdirSync(baseDir).filter(f => f.endsWith('.json')) : [];
const readNoBom = f => fs.readFileSync(f, 'utf8').replace(/^﻿/, '');

async function lensTitles(uri) {
  const lenses = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
  return lenses.map(l => l.command && l.command.title).filter(Boolean);
}

async function screenshot(name) {
  await sleep(1500);
  const req = path.join(out, 'shot-request');
  fs.writeFileSync(req, name);
  await waitFor(() => fs.existsSync(req + '.done'), '截圖', 20000);
  fs.unlinkSync(req + '.done');
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push(`✔ ${name}`);
  } catch (e) {
    results.push(`✘ ${name}：${e.message}\n${e.stack}`);
    throw e;
  }
}

async function run() {
  try {
    await vscode.extensions.getExtension('local.claude-inline-diff').activate();
    const demo = path.join(ws, 'appsettings.json');
    const demoUri = vscode.Uri.file(demo);
    const original = readNoBom(path.join(__dirname, 'fixtures', 'appsettings.json'));

    // ---- 情境 1：啟動時已有 Claude 的刪除 ----
    await step('啟動後自動開啟行內 diff', () => waitFor(() => reviewTab(demo), '自動開啟 diff 分頁'));
    await step('只有 1 處修改（BOM 不會造成第一行誤判）', async () => {
      const titles = await waitFor(async () => {
        const t = await lensTitles(demoUri);
        return t.length > 0 && t;
      }, 'CodeLens');
      assert.ok(titles.some(t => t.includes('修改了 1 處')), titles.join(' | '));
      assert.strictEqual(titles.filter(t => t.includes('接受') && !t.includes('全部')).length, 1);
    });
    await screenshot('1-deletion.png');
    await step('拒絕：檔案還原、baseline 清除、分頁關閉', async () => {
      await vscode.commands.executeCommand('claudeInlineDiff.rejectHunk', demoUri.toString(), 0);
      assert.strictEqual(readNoBom(demo), original);
      await waitFor(() => snapshots().length === 0, 'baseline 刪除');
      await waitFor(() => !reviewTab(demo), 'diff 分頁關閉');
    });
    await step('拒絕後保留檔案的 BOM', async () => {
      const head = fs.readFileSync(demo).subarray(0, 3);
      assert.deepStrictEqual([...head], [0xef, 0xbb, 0xbf]);
    });

    // ---- 情境 2：VS Code 開著時 Claude 修改檔案（測 watcher） ----
    const code = path.join(ws, 'calc.js');
    const before = 'function add(a, b) {\n  return a + b;\n}\n\nfunction sub(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, sub };\n';
    const after = 'function add(a, b) {\n  return a + b;\n}\n\n// 乘法\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n';
    fs.writeFileSync(code, before);
    await sleep(500);
    runHook(code);
    fs.writeFileSync(code, after);
    await step('Claude 修改後即時開啟行內 diff', () => waitFor(() => reviewTab(code), '即時開啟 diff 分頁'));
    await screenshot('2-modify.png');
    await step('逐段接受全部修改：檔案內容不變、baseline 清除', async () => {
      const uri = vscode.Uri.file(code);
      for (let i = 0; i < 10 && snapshots().length > 0; i++) {
        await vscode.commands.executeCommand('claudeInlineDiff.acceptHunk', uri.toString(), 0);
        await sleep(200);
      }
      assert.strictEqual(snapshots().length, 0);
      assert.strictEqual(fs.readFileSync(code, 'utf8'), after);
      await waitFor(() => !reviewTab(code), 'diff 分頁關閉');
    });
  } finally {
    fs.writeFileSync(path.join(out, 'results.txt'), results.join('\n') + '\n');
    console.log('\n' + results.join('\n'));
  }
}

module.exports = { run };
