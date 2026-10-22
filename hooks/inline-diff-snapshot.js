#!/usr/bin/env node
// Claude Code hook（PreToolUse + PostToolUse，matcher：Edit|Write|MultiEdit）
//   PreToolUse ：第一次修改某檔案時存下修改前內容（base）；若兩次 AI 修改之間使用者手動改過檔案，
//                把這些手動修改併入 base，避免被算成 AI 的修改
//   PostToolUse：存下 AI 修改後的內容（ai）。VS Code 端只把 diff(base, ai) 當成 AI 修改
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

// 去掉 UTF-8 BOM：VS Code 顯示文件時不含 BOM，留著會讓第一行被誤判為修改
const stripBom = s => s.replace(/^﻿/, '');

function readText(file) {
  if (!fs.existsSync(file)) return undefined;
  if (fs.statSync(file).size > MAX_BYTES) return null;
  return stripBom(fs.readFileSync(file, 'utf8'));
}

// 先寫暫存檔再改名，避免擴充套件讀到寫到一半的 JSON
function writeSnapshot(out, data) {
  fs.writeFileSync(out + '.tmp', JSON.stringify({ version: 2, ...data, updatedAt: new Date().toISOString() }));
  fs.renameSync(out + '.tmp', out);
}

function rebase(snap, content) {
  try {
    const { rebase, splitLines, eolOf } = require(path.join(__dirname, '..', 'out', 'diff.js'));
    return rebase(splitLines(snap.base), splitLines(snap.ai), splitLines(content)).join(eolOf(snap.base, content));
  } catch {
    return snap.base; // 無法分離時，手動修改會併入 AI 修改
  }
}

let raw = '';
process.stdin.on('data', d => (raw += d));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(stripBom(raw));
    const filePath = input.tool_input && input.tool_input.file_path;
    if (!filePath) return;
    const event = input.hook_event_name || 'PreToolUse';

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
    const content = readText(abs);
    if (content === null) return; // 檔案太大，不追蹤

    let snap;
    try { snap = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { snap = undefined; }
    if (snap && typeof snap.base !== 'string') snap.base = String(snap.content || ''); // 0.1 / 0.2 版格式

    if (event === 'PostToolUse') {
      if (!snap) return;
      writeSnapshot(out, { ...snap, ai: content === undefined ? '' : content });
      return;
    }

    const current = content === undefined ? '' : content;
    if (!snap) {
      writeSnapshot(out, {
        path: abs, existed: content !== undefined, base: current, ai: current, sessionId: input.session_id,
      });
    } else if (typeof snap.ai === 'string' && snap.ai !== current) {
      writeSnapshot(out, { ...snap, base: rebase(snap, current), ai: current, sessionId: input.session_id || snap.sessionId });
    }
  } catch (e) {
    process.stderr.write('[inline-diff] ' + e + '\n');
  } finally {
    // 永遠回 0，不阻擋 Claude 的工具呼叫
    process.exitCode = 0;
  }
});
