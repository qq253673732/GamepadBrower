const { app, BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');

let win, view;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // 创建 BrowserView（用于加载网页）
  view = new BrowserView({
    webPreferences: {
      contextIsolation: false, // 为了方便在页面内执行注入脚本（executeJavaScript 可用）
      sandbox: false,
      nodeIntegration: false
    }
  });
  win.setBrowserView(view);
  const toolbarHeight = 56;
  view.setBounds({ x: 0, y: toolbarHeight, width: 1280, height: 820 - toolbarHeight });
  view.setAutoResize({ width: true, height: true });

  win.loadFile('index.html');

  // 默认加载一个页面
  view.webContents.loadURL('https://www.google.com');

  // 在主进程监听渲染进程的日志消息
  ipcMain.on('log', (event, message) => {
    console.log('Log from renderer: ', message);  // 输出日志到主进程控制台
  });
}

// 注入脚本：扫描页面并展示标签
async function injectScanAndLabel() {
  if (!view || !view.webContents) return { success: false, message: 'no view' };

  // 注入 JS：搜索可点击元素、生成短标签并插入到 DOM，返回 labels map
  const js = `
(function(){
  try {
    // 清理旧标签
    if (window.__gp_cleanup_labels) {
      try { window.__gp_cleanup_labels(); } catch(e) {}
    }

    // 生成短码字符集 - 对应手柄上的按钮字母（单字符 token）
    const tokens = ['a','b','x','y','l','r']; // A,B,X,Y,LB,RB

    // 给定序列长度（2 推荐，能表示 6^2=36 个目标），可以改成 1/2/3
    const codeLen = 2;

    // helper: generate codes with base-N tokens
    function genCodes(n, len) {
      const out = [];
      function rec(prefix, depth) {
        if (depth === 0) { out.push(prefix); return; }
        for (let t of tokens) rec(prefix + t, depth - 1);
      }
      rec('', len);
      return out;
    }
    const codes = genCodes(tokens.length, codeLen);

    // find clickable elements
    const selector = [
      'a[href]:not([data-gp-ignore])',
      'button:not([data-gp-ignore])',
      '[role="button"]:not([data-gp-ignore])',
      'input[type="button"]:not([data-gp-ignore])',
      'input[type="submit"]:not([data-gp-ignore])',
      '[onclick]:not([data-gp-ignore])',
      'area[href]:not([data-gp-ignore])'
    ].join(',');

    const els = Array.from(document.querySelectorAll(selector))
      // filter invisible / tiny
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8 && r.top + r.height >= 0 && r.left + r.width >= 0;
      });

    // limit to reasonable number (codes length)
    const max = Math.min(codes.length, els.length);
    const chosen = els.slice(0, max);

    // Prepare container for labels (fixed on top)
    let container = document.getElementById('__gp_label_container');
    if (!container) {
      container = document.createElement('div');
      container.id = '__gp_label_container';
      container.style.position = 'fixed';
      container.style.left = '0';
      container.style.top = '0';
      container.style.width = '100%';
      container.style.height = '100%';
      container.style.pointerEvents = 'none';
      container.style.zIndex = 2147483646; // very high
      document.documentElement.appendChild(container);
    }
    container.innerHTML = '';

    // store mapping
    window.__gp_label_map = window.__gp_label_map || {};

    // assign ids & labels
    for (let i = 0; i < chosen.length; i++) {
      const el = chosen[i];
      const code = codes[i];
      const gid = 'gp-' + Date.now() + '-' + i;
      el.setAttribute('data-gp-id', gid);

      // create label element positioned above the element
      const rect = el.getBoundingClientRect();
      const label = document.createElement('div');
      label.className = '__gp_label';
      label.setAttribute('data-gp-label', code);
      label.setAttribute('data-gp-for', gid);
      label.style.position = 'absolute';
      // position slightly above the element, but ensure in viewport
      const left = Math.max(2, rect.left + rect.width / 2 - 20);
      const top = Math.max(2, rect.top - 24);
      label.style.left = left + 'px';
      label.style.top = top + 'px';
      label.style.padding = '3px 6px';
      label.style.borderRadius = '4px';
      label.style.background = 'rgba(0,0,0,0.75)';
      label.style.color = 'white';
      label.style.fontSize = '12px';
      label.style.fontFamily = 'monospace';
      label.style.pointerEvents = 'none';
      label.style.zIndex = 2147483647;
      label.textContent = code;

      container.appendChild(label);

      // store reference mapping
      window.__gp_label_map[code] = { gid: gid };
    }

    // cleanup function to remove labels & mapping later
    window.__gp_cleanup_labels = function() {
      const c = document.getElementById('__gp_label_container');
      if (c) c.remove();
      window.__gp_label_map = {};
      delete window.__gp_cleanup_labels;
    };

    return { success: true, count: chosen.length, codes: Object.keys(window.__gp_label_map) };
  } catch (err) {
    return { success: false, message: String(err) };
  }
})();
  `;

  try {
    const res = await view.webContents.executeJavaScript(js, true);
    return res;
  } catch (err) {
    return { success: false, message: String(err) };
  }
}

// 激活（点击）对应短码
async function activateCode(code) {
  if (!view || !view.webContents) return { success: false, message: 'no view' };

  // 执行脚本找到 data-gp-id 的元素并触发 click + 带过渡效果
  const js = `
(function(){
  try {
    const map = window.__gp_label_map || {};
    const entry = map["${code}"];
    if (!entry) return { success: false, message: 'code not found' };
    const gid = entry.gid;
    const el = document.querySelector('[data-gp-id="'+gid+'"]');
    if (!el) return { success: false, message: 'element not found' };
    // highlight briefly
    const old = el.style.outline;
    el.style.outline = '3px solid orange';
    setTimeout(()=> el.style.outline = old, 600);
    // dispatch events
    el.scrollIntoView({behavior:'smooth', block:'center'});
    try {
      el.click();
    } catch(e) {
      // fallback dispatch events
      const evOpts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new MouseEvent('mousedown', evOpts));
      el.dispatchEvent(new MouseEvent('mouseup', evOpts));
      el.dispatchEvent(new MouseEvent('click', evOpts));
    }
    // remove labels after activation
    if (window.__gp_cleanup_labels) window.__gp_cleanup_labels();
    return { success: true };
  } catch (err) {
    return { success: false, message: String(err) };
  }
})();
  `;
  try {
    const res = await view.webContents.executeJavaScript(js, true);
    return res;
  } catch (err) {
    return { success: false, message: String(err) };
  }
}

// IPC handlers exposed to renderer
ipcMain.handle('view-load-url', async (_, url) => {
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    await view.webContents.loadURL(url);
    return { success: true };
  } catch (e) {
    return { success: false, message: String(e) };
  }
});

ipcMain.handle('view-scan-labels', async () => {
  return await injectScanAndLabel();
});

ipcMain.handle('view-activate-code', async (_, code) => {
  return await activateCode(code);
});

ipcMain.on('open-devtools-view', () => {
  if (view && view.webContents) view.webContents.openDevTools({ mode: 'detach' });
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
