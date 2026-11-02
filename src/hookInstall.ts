import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripBom } from './diff';

export const HOOK_SCRIPT = 'inline-diff-snapshot.js';
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'];
const MATCHER = 'Edit|Write|MultiEdit';

// hook 腳本放在固定位置（不含版本號）。擴充套件更新後 VS Code 會刪掉舊版本的資料夾，
// 若 hook 指向 ~/.vscode/extensions/<id>-<版本>/，更新一次就會失效，看起來就像「用久了失靈」
export function stableHookDir(): string {
  return process.env.INLINE_DIFF_REVIEW_HOME || path.join(os.homedir(), '.inline-diff-review');
}

function copyAtomic(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const tmp = `${to}.${process.pid}.tmp`;
  fs.copyFileSync(from, tmp);
  fs.renameSync(tmp, to);
}

// 每次啟動都把目前版本的 hook（以及它用到的 diff.js）複製到固定位置，回傳 hook 腳本路徑
export function deployHook(extensionPath: string): string {
  const dir = stableHookDir();
  const script = path.join(dir, 'hooks', HOOK_SCRIPT);
  copyAtomic(path.join(extensionPath, 'hooks', HOOK_SCRIPT), script);
  copyAtomic(path.join(extensionPath, 'out', 'diff.js'), path.join(dir, 'out', 'diff.js'));
  return script.replace(/\\/g, '/');
}

export function hookCommand(script: string): string {
  return `node "${script}"`;
}

export type PatchResult = 'unchanged' | 'updated' | 'added' | 'invalid';

// 讓 settings 中本擴充套件的 hook 指向 script，其他 hook 一律不動。
// addIfMissing=false 時只修正已經裝過的專案，不會替沒裝過的專案新增 hook
export function patchSettings(settingsPath: string, script: string, addIfMissing: boolean): PatchResult {
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(stripBom(fs.readFileSync(settingsPath, 'utf8')));
    } catch {
      return 'invalid';
    }
  }
  const command = hookCommand(script);
  const ours = (h: any) => String(h?.command ?? '').includes(HOOK_SCRIPT);
  const oursIn = (e: string) => (settings.hooks?.[e] ?? []).flatMap((m: any) => (m.hooks ?? []).filter(ours));
  const found = HOOK_EVENTS.flatMap(oursIn);
  if (found.length === 0 && !addIfMissing) return 'unchanged';
  // 每個事件剛好一筆、而且就是目前的指令 → 不用改
  if (HOOK_EVENTS.every(e => { const h = oursIn(e); return h.length === 1 && h[0].command === command; })) return 'unchanged';

  settings.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    settings.hooks[event] = (settings.hooks[event] ?? [])
      .map((m: any) => ({ ...m, hooks: (m.hooks ?? []).filter((h: any) => !ours(h)) }))
      .filter((m: any) => m.hooks.length > 0);
    settings.hooks[event].push({ matcher: MATCHER, hooks: [{ type: 'command', command }] });
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return found.length ? 'updated' : 'added';
}
