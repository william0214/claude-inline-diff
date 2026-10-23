// macOS 版截圖（JXA，用法：osascript -l JavaScript screenshot-mac.js <標題> <輸出路徑>）
// 擷取標題含 <標題> 的最大視窗（即使被其他視窗擋住也能擷取）
// 執行的終端機 / 應用程式需要「螢幕錄製」權限，否則讀不到視窗標題
ObjC.import('CoreGraphics');
ObjC.import('Foundation');

function run(argv) {
  const [title, out] = argv;
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID));
  const windows = ObjC.deepUnwrap(list) || [];
  let best = null, bestArea = 0;
  for (const w of windows) {
    if (w.kCGWindowLayer !== 0 || !w.kCGWindowName) continue;
    if (w.kCGWindowName.toLowerCase().indexOf(title.toLowerCase()) < 0) continue;
    const area = w.kCGWindowBounds.Width * w.kCGWindowBounds.Height;
    if (area > bestArea) { bestArea = area; best = w; }
  }
  if (!best) throw new Error('找不到標題含 ' + title + ' 的視窗（確認已給「螢幕錄製」權限）');
  const app = Application.currentApplication();
  app.includeStandardAdditions = true;
  // -l 指定視窗 ID、-o 不要陰影、-x 不要快門聲
  app.doShellScript('/usr/sbin/screencapture -o -x -l ' + best.kCGWindowNumber + ' ' + quoted(out));
}

function quoted(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
