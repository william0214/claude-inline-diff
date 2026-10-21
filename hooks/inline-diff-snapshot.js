#!/usr/bin/env node
// Claude Code PreToolUse hook：在 Edit / Write / MultiEdit 執行前，存下檔案的原始內容。
// 同一檔案只存第一次（之後的連續修改都與這份 baseline 比較），直到在 VS Code 中接受或拒絕。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;

// 轉成真實的完整路徑（Windows 8.3 短檔名、symlink），讓 VS Code 端能對得上
function realPath(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const filePath = input.tool_input && input.tool_input.file_path;
    if (!filePath) return;

    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const abs = realPath(path.resolve(input.cwd || root, filePath));
    const dir = path.join(root, '.claude', 'inline-diff');
    fs.mkdirSync(dir, { recursive: true });
    const gitignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');

    const id = crypto
      .createHash('sha1')
      .update(process.platform === 'win32' ? abs.toLowerCase() : abs)
      .digest('hex')
      .slice(0, 16);
    const out = path.join(dir, id + '.json');
    if (fs.existsSync(out)) return;

    const existed = fs.existsSync(abs);
    if (existed && fs.statSync(abs).size > MAX_BYTES) return;
    const content = existed ? fs.readFileSync(abs, 'utf8') : '';
    // 先寫暫存檔再改名，避免擴充套件讀到寫到一半的 JSON
    fs.writeFileSync(out + '.tmp', JSON.stringify({ path: abs, existed, content }));
    fs.renameSync(out + '.tmp', out);
  } catch (e) {
    process.stderr.write('[inline-diff] ' + e + '\n');
  } finally {
    // 永遠回 0，不阻擋 Claude 的工具呼叫
    process.exitCode = 0;
  }
});
