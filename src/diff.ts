// 一段修改：baseline 的 removed 行（從 bStart 起）被換成目前檔案的 added 行（從 cStart 起）
export interface Hunk {
  bStart: number;
  removed: string[];
  cStart: number;
  added: string[];
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function stripBom(text: string): string {
  return text.replace(/^﻿/, '');
}

export function eolOf(...texts: (string | undefined)[]): string {
  return texts.some(t => t?.includes('\r\n')) ? '\r\n' : '\n';
}

// 以 LCS 做逐行比對；先去掉相同的頭尾以加快速度
export function diffLines(base: string[], cur: string[]): Hunk[] {
  let pre = 0;
  while (pre < base.length && pre < cur.length && base[pre] === cur[pre]) pre++;
  let suf = 0;
  while (
    suf < base.length - pre &&
    suf < cur.length - pre &&
    base[base.length - 1 - suf] === cur[cur.length - 1 - suf]
  ) suf++;

  const A = base.slice(pre, base.length - suf);
  const B = cur.slice(pre, cur.length - suf);
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];
  // 差異區塊過大時直接視為一整段，避免 O(n*m) 記憶體爆掉
  if (n === 0 || m === 0 || n * m > 4_000_000) {
    return normalize([{ bStart: pre, removed: A, cStart: pre, added: B }], base, cur);
  }

  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const hunks: Hunk[] = [];
  let cur_: Hunk | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      if (cur_) { hunks.push(cur_); cur_ = null; }
      i++; j++;
      continue;
    }
    if (!cur_) cur_ = { bStart: pre + i, removed: [], cStart: pre + j, added: [] };
    // 先刪後增，讓同一段的 removed / added 能對齊顯示
    if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      cur_.removed.push(A[i++]);
    } else {
      cur_.added.push(B[j++]);
    }
  }
  if (cur_) hunks.push(cur_);
  return normalize(hunks, base, cur);
}

function normalize(hunks: Hunk[], base: string[], cur: string[]): Hunk[] {
  return slideUp(splitLeadingDeletion(hunks, base), base);
}

// 「刪掉一整個區塊 + 修改下一行」常被 LCS 合成一大段。
// 若前一行（相同的那一行）能改與區塊內的同內容行對齊，就拆成「純刪除」與「一對一修改」兩段，
// 讓使用者可以分別保留 / 復原。例：`{ 快速入口 }, {` 刪除 與 `"我的差勤"` → `"我的差勤差勤"`
function splitLeadingDeletion(hunks: Hunk[], base: string[]): Hunk[] {
  const out: Hunk[] = [];
  let prevBEnd = 0;
  let prevCEnd = 0;
  for (const h of hunks) {
    const k = h.removed.length - h.added.length - 1;
    const canSplit = h.added.length > 0 && k >= 0
      && h.bStart - 1 >= prevBEnd && h.cStart - 1 >= prevCEnd
      && h.removed[k] === base[h.bStart - 1];
    if (canSplit) {
      out.push({ bStart: h.bStart - 1, removed: [base[h.bStart - 1], ...h.removed.slice(0, k)], cStart: h.cStart - 1, added: [] });
      out.push({ bStart: h.bStart + k + 1, removed: h.removed.slice(k + 1), cStart: h.cStart, added: h.added });
    } else {
      out.push(h);
    }
    const last = out[out.length - 1];
    prevBEnd = last.bStart + last.removed.length;
    prevCEnd = last.cStart + last.added.length;
  }
  return out;
}

// 純新增 / 純刪除的區塊若可上下平移（例如 `{ ... },` 兩端都是 `{`），
// 盡量往上對齊，與 VS Code diff 檢視的切法一致
function slideUp(hunks: Hunk[], base: string[]): Hunk[] {
  let prevBEnd = 0;
  let prevCEnd = 0;
  for (const h of hunks) {
    const pureDel = h.added.length === 0 && h.removed.length > 0;
    const pureAdd = h.removed.length === 0 && h.added.length > 0;
    const lines = pureDel ? h.removed : pureAdd ? h.added : undefined;
    while (lines && h.bStart > prevBEnd && h.cStart > prevCEnd
      && base[h.bStart - 1] === lines[lines.length - 1]) {
      lines.unshift(lines.pop()!);
      h.bStart--;
      h.cStart--;
    }
    prevBEnd = h.bStart + h.removed.length;
    prevCEnd = h.cStart + h.added.length;
  }
  return hunks;
}

// 兩個行區間 [aS, aE)、[bS, bE) 是否互相影響；空區間代表「插入點」
export function overlaps(aS: number, aE: number, bS: number, bE: number): boolean {
  if (aS === aE && bS === bE) return aS === bS;
  if (aS === aE) return bS < aS && aS < bE;
  if (bS === bE) return aS < bS && bS < aE;
  return aS < bE && bS < aE;
}

// 區間 [s, e) 之前的修改造成的行數位移；d 的座標以 d.bStart / d.removed 為準
export function shiftBefore(changes: Hunk[], s: number, e: number): number {
  let offset = 0;
  for (const d of changes) {
    const dS = d.bStart;
    const dE = d.bStart + d.removed.length;
    if (!overlaps(s, e, dS, dE) && dE <= s) offset += d.added.length - d.removed.length;
  }
  return offset;
}

// AI 兩次修改之間，使用者手動改了檔案：把「不碰到 AI 修改」的手動修改也套用到 baseline，
// 這樣手動修改就不會被算成 AI 的修改。碰到 AI 修改區塊的手動修改無法分離，維持併入 AI 修改。
export function rebase(base: string[], ai: string[], cur: string[]): string[] {
  const aiHunks = diffLines(base, ai);
  const userChanges = diffLines(ai, cur);
  const out = base.slice();
  for (const u of [...userChanges].reverse()) {
    const uS = u.bStart;
    const uE = u.bStart + u.removed.length;
    if (aiHunks.some(h => overlaps(h.cStart, h.cStart + h.added.length, uS, uE))) continue;
    // ai 座標 → base 座標：減去前面 AI 修改造成的位移
    const offset = shiftBefore(aiHunks.map(h => ({ bStart: h.cStart, removed: h.added, cStart: h.bStart, added: h.removed })), uS, uE);
    out.splice(uS + offset, u.removed.length, ...u.added);
  }
  return out;
}

// 單行內的字元差異（共同前綴 / 後綴之外的部分）
export function charDiff(a: string, b: string): { aStart: number; aEnd: number; bStart: number; bEnd: number } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { aStart: p, aEnd: a.length - s, bStart: p, bEnd: b.length - s };
}

export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
