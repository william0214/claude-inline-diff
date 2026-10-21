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
    return [{ bStart: pre, removed: A, cStart: pre, added: B }];
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
  return hunks;
}
