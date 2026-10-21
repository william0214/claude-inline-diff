// 端對端測試：開一個獨立的 VS Code（獨立的使用者資料夾），載入本擴充套件，模擬 Claude 修改檔案
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const { runTests } = require('@vscode/test-electron');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'hooks', 'inline-diff-snapshot.js');

function runHook(ws, file) {
  cp.execFileSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: ws, tool_name: 'Edit', tool_input: { file_path: file } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: ws },
  });
}

async function main() {
  const ws = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'inline-diff-e2e-')));
  const out = path.join(root, 'test-output');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(path.join(ws, '.vscode'));
  fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({
    'diffEditor.renderSideBySide': false,
    'diffEditor.codeLens': true,
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
  }));

  // 情境 1：VS Code 啟動前 Claude 已改過檔案（帶 BOM 的 appsettings.json，刪掉一個區塊）
  const demo = path.join(ws, 'appsettings.json');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'appsettings.json'), demo);
  runHook(ws, demo);
  const text = fs.readFileSync(demo, 'utf8');
  fs.writeFileSync(demo, text.replace(/ {6}\{\r\n {8}"Title": "快速入口",[\s\S]*?\r\n {6}\},\r\n/, ''));

  // 測試端要求截圖時，由這裡（一般 Node 程序）擷取測試視窗
  const req = path.join(out, 'shot-request');
  const timer = setInterval(() => {
    if (!fs.existsSync(req)) return;
    const name = fs.readFileSync(req, 'utf8');
    fs.unlinkSync(req);
    try {
      cp.execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'screenshot.ps1'), '-Title', path.basename(ws), '-Out', path.join(out, name)]);
    } catch (e) {
      console.error('截圖失敗：', String(e.stderr || e));
    }
    fs.writeFileSync(req + '.done', '');
  }, 200);

  const vscodeExecutablePath = process.env.VSCODE_EXE
    || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [ws, '--disable-extensions', '--user-data-dir', path.join(os.tmpdir(), 'inline-diff-e2e-user'),
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
      extensionTestsEnv: { INLINE_DIFF_E2E_WS: ws, INLINE_DIFF_E2E_OUT: out, INLINE_DIFF_HOOK: hook },
    });
  } finally {
    clearInterval(timer);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
