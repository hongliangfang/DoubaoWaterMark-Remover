(() => {
  "use strict";

  if (window.__DOUBAO_ORIGINAL_CONTENT__) return;
  window.__DOUBAO_ORIGINAL_CONTENT__ = true;

  const records = new Map();
  const sessionVideos = new Map();
  const visibleImageIds = new Set();
  const urlIndex = new Map();
  const imageRecords = new WeakMap();
  const observer = new MutationObserver(handleMutations);
  let enhanceScheduled = false;
  let enhanceTimer = null;
  let fiberScanTimer = null;
  let status = "listening";
  let lastFiberScanAt = 0;
  let sessionRescanUntil = Date.now() + 2200;
  let sessionConversationId = getConversationMeta().conversation_id;
  let extensionEnabled = true;
  let readyToastTimer = null;
  let readyToastHideTimer = null;
  let readyToastShown = false;

  const SUPPORT_URL = "https://github.com/XiaoYu43002/DoubaoWaterMark-Remover";
  const DIRECTORY_DB_NAME = "doubaoDownloadDirectory_v1";
  const DIRECTORY_STORE_NAME = "settings";

  const mediaPanel = createMediaPanel();
  setStatus("listening");
  bootstrapExtensionEnabled();

  function openDirectoryDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error("当前浏览器不支持本地目录权限保存"));
      const request = indexedDB.open(DIRECTORY_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(DIRECTORY_STORE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("目录权限存储失败"));
    });
  }

  async function loadDirectoryHandle() {
    try {
      const db = await openDirectoryDb();
      return await new Promise((resolve, reject) => {
        const request = db.transaction(DIRECTORY_STORE_NAME, "readonly")
          .objectStore(DIRECTORY_STORE_NAME).get("downloadDirectory");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } catch (_) {
      return null;
    }
  }

  async function saveDirectoryHandle(handle) {
    const db = await openDirectoryDb();
    await new Promise((resolve, reject) => {
      const request = db.transaction(DIRECTORY_STORE_NAME, "readwrite")
        .objectStore(DIRECTORY_STORE_NAME).put(handle, "downloadDirectory");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error || new Error("目录权限保存失败"));
    });
  }

  function sanitizeLocalFilename(value, fallback = "file") {
    return String(value || fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim() || fallback;
  }

  async function getWritableDirectory(handle) {
    if (!handle) return null;
    const permission = await handle.queryPermission?.({ mode: "readwrite" });
    if (permission === "granted") return handle;
    const requested = await handle.requestPermission?.({ mode: "readwrite" });
    return requested === "granted" ? handle : null;
  }

  async function getNestedDirectory(handle, segments) {
    let current = handle;
    for (const segment of segments) {
      const name = sanitizeLocalFilename(segment, "Doubao");
      current = await current.getDirectoryHandle(name, { create: true });
    }
    return current;
  }

  async function writeResponseToFile(directory, filename, response) {
    const fileHandle = await directory.getFileHandle(sanitizeLocalFilename(filename), { create: true });
    const writable = await fileHandle.createWritable();
    try {
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          await writable.write(part.value);
        }
      } else {
        await writable.write(await response.blob());
      }
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  async function makeImageQualityResponse(response, quality) {
    if (quality === "high") return response;
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const maxLongSide = quality === "compact" ? 1600 : 2560;
      const scale = Math.min(1, maxLongSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => canvas.toBlob(resolve, "image/webp", quality === "compact" ? 0.72 : 0.88));
      if (!blob) throw new Error("图片压缩失败");
      return new Response(blob, { headers: { "content-type": "image/webp" } });
    } finally {
      bitmap.close();
    }
  }

  async function writeMediaWithDirectory(handle, type, record, settings, index) {
    const writableHandle = await getWritableDirectory(handle);
    if (!writableHandle) throw new Error("基础文件夹权限未授予");
    let sourceUrl = type === "image"
      ? record.image_ori_raw_url || record.image_ori_url || record.best_url
      : record.url;
    if (type === "video" && record.fallback_api) {
      const refreshed = await sendRuntimeMessage({ type: "REFRESH_VIDEO", video: record });
      sourceUrl = refreshed?.ok !== false ? refreshed?.video?.url || sourceUrl : sourceUrl;
    }
    if (!sourceUrl) throw new Error("无可用媒体地址");
    const response = await fetch(sourceUrl, { credentials: "omit", cache: "no-store" });
    if (!response.ok) throw new Error(`媒体请求失败：HTTP ${response.status}`);
    const extension = type === "image"
      ? (settings.downloadQuality === "high" ? String(record.extension || "jpg").toLowerCase() : "webp")
      : String(record.format || "mp4").toLowerCase();
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const suffix = index ? `_${String(index).padStart(2, "0")}` : "";
    const filename = type === "image"
      ? `doubao_${stamp}${suffix}.${extension}`
      : `${sanitizeLocalFilename(record.video_id || "video")}.${extension}`;
    const baseSegments = String(settings.downloadSubdir || "Doubao").split("/").filter(Boolean);
    const child = type === "image"
      ? await getNestedDirectory(writableHandle, [...baseSegments, "doubao_original_images"])
      : await getNestedDirectory(writableHandle, [...baseSegments, "doubao_original_media", sanitizeLocalFilename(record.conversation_chat_id || "chat")]);
    const outputResponse = type === "image"
      ? await makeImageQualityResponse(response, settings.downloadQuality)
      : response;
    await writeResponseToFile(child, filename, outputResponse);
    return { filename, directory: writableHandle.name || "已选文件夹" };
  }

  function showReadyToast() {
    if (!extensionEnabled || !document.documentElement || readyToastShown) return;
    readyToastShown = true;
    clearTimeout(readyToastTimer);
    clearTimeout(readyToastHideTimer);
    const existing = document.getElementById("doubao-wm-ready-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.id = "doubao-wm-ready-toast";
    toast.setAttribute("role", "status");
    toast.textContent = "插件已就绪 · 数据仅在本地处理";
    toast.style.cssText = [
      "position:fixed",
      "left:50%",
      "top:50%",
      "transform:translate(-50%,-50%)",
      "z-index:2147483647",
      "padding:10px 18px",
      "border-radius:999px",
      "background:rgba(28,28,30,.78)",
      "color:#fff",
      "font:13px/1.4 system-ui,\"PingFang SC\",\"Microsoft YaHei\",sans-serif",
      "letter-spacing:.02em",
      "backdrop-filter:blur(10px)",
      "-webkit-backdrop-filter:blur(10px)",
      "box-shadow:0 8px 28px rgba(0,0,0,.22)",
      "pointer-events:none",
      "opacity:0",
      "transition:opacity .28s ease"
    ].join(";");
    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { toast.style.opacity = "1"; });
    });
    readyToastTimer = setTimeout(() => {
      toast.style.opacity = "0";
      readyToastHideTimer = setTimeout(() => toast.remove(), 320);
    }, 2800);
  }

  function sessionImageRecords() {
    const currentChat = extractChatIdFromLocation();
    if (!currentChat || !isConcreteChatId(currentChat)) return [];
    return Array.from(records.values()).filter((record) => {
      if (!record) return false;
      if (!(record.image_ori_raw_url || record.image_ori_url || record.best_url)) return false;
      // 必须带当前会话 chatId；缺字段或其它会话一律不展示。
      if (record.conversation_chat_id !== currentChat && record.page_chat_id !== currentChat) return false;
      if (record.conversation_id && record.conversation_id !== sessionConversationId) return false;
      return true;
    });
  }

  function createMediaPanel() {
    const host = document.createElement("div");
    host.id = "doubao-original-media-panel";
    host.style.cssText = "position:fixed;right:18px;bottom:24px;top:auto;z-index:2147483645;pointer-events:auto;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:Arial,"Microsoft YaHei",sans-serif}
        button{font:inherit;cursor:pointer}
        #panel{display:flex;flex-direction:column;width:326px;height:280px;min-width:260px;min-height:180px;max-width:calc(100vw - 32px);max-height:calc(100vh - 48px);overflow:hidden;border:1px solid rgba(0,87,255,.18);border-radius:14px;
          background:#fff;color:#27272a;box-shadow:0 16px 40px rgba(20,45,90,.18)}
        header{display:grid;grid-template-columns:28px minmax(0,1fr) 28px 28px;flex:0 0 auto;align-items:center;gap:9px;padding:10px 11px;background:linear-gradient(110deg,#0057ff,#2387ff);color:#fff;cursor:move;user-select:none;touch-action:none}
        header .icon{cursor:pointer}
        .title{min-width:0;text-align:center}.title strong{display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px}.title strong span{display:inline;margin:0;color:#fff;font-size:13px}
        .state-dot{width:7px;height:7px;border-radius:50%;background:#35dc72;box-shadow:0 0 0 2px rgba(255,255,255,.18)}
        .icon{display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:rgba(255,255,255,.18);color:#fff}
        .icon:hover{background:rgba(255,255,255,.28)}.icon svg{width:14px;height:14px;transition:transform .2s}.collapsed #collapse svg{transform:rotate(180deg)}
        #tabs{display:flex;flex:0 0 auto;padding:7px 10px 0;background:#fff;border-bottom:1px solid #e4e4e7}.tab{flex:1;height:32px;border:0;border-bottom:2px solid transparent;background:#fff;color:#71717a;font-size:11px}.tab.active{border-bottom-color:#0057ff;color:#0057ff;font-weight:700}
        #body{min-height:0;flex:1 1 auto;overflow:auto;padding:10px;background:#f7f8fa}#panel.collapsed{height:auto;max-height:none}#panel.collapsed #tabs,#panel.collapsed #body,#panel.collapsed footer{display:none}
        #selection-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;padding:6px 8px;border:1px solid #dbe4f5;border-radius:8px;background:#eff6ff;color:#334155;font-size:10px}
        #selection-toolbar label{display:inline-flex;align-items:center;gap:6px;min-width:0;cursor:pointer;user-select:none}
        #selection-toolbar input{width:14px;height:14px;margin:0;accent-color:#2563eb;cursor:pointer}
        #selection-toolbar input:disabled{cursor:not-allowed}.selection-summary{color:#64748b;white-space:nowrap}
        .empty{padding:28px 10px;text-align:center;color:#71717a;font-size:11px;line-height:1.6}
        .item{display:flex;align-items:center;gap:8px;margin-bottom:7px;padding:7px;border:1px solid #e4e4e7;border-radius:10px;background:#fff}
        .item.selected{border-color:#7aa7ff;background:#f7faff;box-shadow:0 0 0 2px rgba(37,99,235,.08)}
        .select-wrap{display:grid;place-items:center;flex:0 0 18px;width:18px}
        .select-wrap input{width:15px;height:15px;margin:0;accent-color:#2563eb;cursor:pointer}
        .thumb{width:54px;height:54px;flex:0 0 54px;border-radius:8px;object-fit:cover;background:#e4e4e7}.info{min-width:0;flex:1}
        .info strong{display:block;font-size:11px}.info span{display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;
          white-space:nowrap;color:#a1a1aa;font-size:9px}.download{height:29px;padding:0 9px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-size:10px}
        footer{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:7px;padding:9px 11px;border-top:1px solid #e4e4e7;background:#fff;flex-wrap:wrap}
        footer button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:31px;padding:0 12px;border:0;border-radius:9px;font-size:11px;font-weight:600}
        footer button svg{width:14px;height:14px;flex:0 0 auto}
        #support-author{background:#f4f4f5;color:#3f3f46}
        #support-author:hover{background:#e4e4e7}
        #support-author svg{stroke:#ef4444;fill:none}
        #download-all{background:#2563eb;color:#fff}
        #download-all svg{stroke:currentColor;fill:none}
        #download-all:disabled{opacity:.45;cursor:not-allowed}
        #download-selected{background:#0f766e;color:#fff}
        #download-selected:disabled{opacity:.45;cursor:not-allowed}
        #download-selected-folder{background:#7c3aed;color:#fff}
        #download-selected-folder:disabled{opacity:.45;cursor:not-allowed}
        #settings{background:#eff6ff;color:#1d4ed8}
        #settings:hover{background:#dbeafe}
        #settings svg{stroke:currentColor;fill:none}
        #settings-panel{flex:0 0 auto;padding:9px 10px;border-top:1px solid #e4e4e7;background:#fff}
        #settings-panel[hidden]{display:none}
        .settings-title{font-size:11px;font-weight:700;color:#27272a}
        .settings-label{display:block;margin-top:7px;color:#52525b;font-size:10px}
        .settings-input-row{display:flex;gap:6px;margin-top:5px}
        .settings-input-row input{min-width:0;flex:1;height:29px;padding:0 8px;border:1px solid #d4d4d8;border-radius:7px;color:#27272a;font-size:10px;outline:none}
        .settings-input-row input:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.12)}
        .settings-folder-row{display:flex;align-items:center;gap:6px;margin-top:5px}
        .settings-folder-row button{height:29px;padding:0 8px;border:1px solid #c7d6f2;border-radius:7px;background:#eff6ff;color:#1d4ed8;font-size:10px;white-space:nowrap}
        .settings-folder-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#52525b;font-size:10px}
        .settings-check{display:flex;align-items:center;gap:6px;margin-top:8px;color:#52525b;font-size:10px}
        .settings-check input{margin:0}
        .settings-select{width:100%;height:29px;margin-top:5px;padding:0 7px;border:1px solid #d4d4d8;border-radius:7px;color:#27272a;font-size:10px;outline:none;background:#fff}
        .settings-select:focus{border-color:#2563eb;box-shadow:0 0 0 2px rgba(37,99,235,.12)}
        .settings-hint{margin:7px 0 0;color:#71717a;font-size:9px;line-height:1.45}
        .settings-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
        .settings-actions button{height:27px;padding:0 9px;border:0;border-radius:7px;font-size:10px}
        #settings-cancel{background:#f4f4f5;color:#52525b}
        #settings-save{background:#2563eb;color:#fff}
        #resize-handle{position:absolute;right:3px;bottom:3px;width:17px;height:17px;padding:0;border:0;border-radius:5px;background:transparent;cursor:nwse-resize;touch-action:none;opacity:.6}
        #resize-handle:hover{background:#eff6ff;opacity:1}
        #resize-handle::after{content:"";position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid #2563eb;border-bottom:2px solid #2563eb}
        #panel.collapsed #resize-handle{display:none}
        #launcher{display:none;width:46px;height:46px;border:0;border-radius:50%;background:#0057ff;color:#fff;font-size:20px;box-shadow:0 8px 24px rgba(0,87,255,.3)}
        #panel.closed{display:none}#panel.closed+#launcher{display:block}
      </style>
      <section id="panel">
        <header><button id="collapse" class="icon" title="收起面板" aria-label="收起或展开面板"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><div class="title"><strong><span>加载成功</span><i class="state-dot"></i></strong></div><button id="settings" class="icon" title="下载设置" aria-label="下载设置"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Zm0-5.2 1.1 2.1 2.4-.5 1.8-1.4 1.8 1.8-1.4 1.8.5 2.4 2.1 1.1v2.6l-2.1 1.1-.5 2.4 1.4 1.8-1.8 1.8-1.8-1.4-1.1 2.1h-2.6l-1.1-2.1-2.4-.5-1.8 1.4-1.8-1.8 1.4-1.8-.5-2.4-2.1-1.1v-2.6l-2.1-1.1-1.4-1.8 1.8-1.8 1.8 1.4 2.4-.5L9.4 3H12Z" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="close" class="icon" title="关闭">×</button></header>
        <nav id="tabs"><button class="tab active" data-type="image">图片 <b id="image-count">0</b></button><button class="tab" data-type="video">视频 <b id="video-count">0</b></button></nav>
        <div id="body"><div id="selection-toolbar"><label><input id="select-all-current" type="checkbox"><span>全选当前</span></label><span id="selection-summary" class="selection-summary">已选 0 / 0</span></div><div id="list"><div class="empty">当前会话暂未识别到图片</div></div></div>
        <section id="settings-panel" hidden aria-label="下载设置">
          <div class="settings-title">下载设置</div>
          <label class="settings-label">基础文件夹</label>
          <div class="settings-folder-row"><button id="settings-pick-folder" type="button">选择文件夹</button><span id="settings-folder-name">未选择（使用浏览器下载）</span></div>
          <label class="settings-label" for="settings-subdir">保存子目录</label>
          <div class="settings-input-row"><input id="settings-subdir" type="text" placeholder="Doubao" autocomplete="off" spellcheck="false"></div>
          <label class="settings-label" for="settings-quality">下载画质</label>
          <select id="settings-quality" class="settings-select">
            <option value="high">高清原图（无水印）</option>
            <option value="balanced">标准高清（无水印，较小）</option>
            <option value="compact">节省空间（无水印，压缩）</option>
          </select>
          <label class="settings-check"><input id="settings-ask-location" type="checkbox"><span>每次下载前询问保存位置</span></label>
          <div id="settings-hint" class="settings-hint">基础目录由浏览器的下载目录决定；这里设置子目录和画质。</div>
          <div class="settings-actions"><button id="settings-cancel" type="button">取消</button><button id="settings-save" type="button">保存设置</button></div>
        </section>
        <footer>
          <button id="support-author" type="button" title="支持作者十一木">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 5.6a5.1 5.1 0 0 0-7.2 0L12 7.2l-1.6-1.6a5.1 5.1 0 0 0-7.2 7.2l1.6 1.6L12 21.2l7.2-7.2 1.6-1.6a5.1 5.1 0 0 0 0-7.2z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>支持作者</span>
          </button>
          <button id="download-selected" type="button" disabled>
            <span>下载选中 (0)</span>
          </button>
          <button id="download-selected-folder" type="button" disabled title="只影响本次选中的媒体，不改变设置里的默认文件夹">
            <span>选中另存为</span>
          </button>
          <button id="download-all" type="button" disabled>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 18h14" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span>全部下载</span>
          </button>
        </footer>
        <button id="resize-handle" type="button" title="拖拽调整面板大小" aria-label="拖拽调整面板大小"></button>
      </section>
      <button id="launcher" title="打开无水印媒体面板">◈</button>
    `;

    const panel = shadow.getElementById("panel");
    const header = shadow.querySelector("header");
    const list = shadow.getElementById("list");
    const selectAllCurrent = shadow.getElementById("select-all-current");
    const selectionSummary = shadow.getElementById("selection-summary");
    const supportAuthor = shadow.getElementById("support-author");
    const settingsButton = shadow.getElementById("settings");
    const settingsPanel = shadow.getElementById("settings-panel");
    const settingsSubdir = shadow.getElementById("settings-subdir");
    const settingsPickFolder = shadow.getElementById("settings-pick-folder");
    const settingsFolderName = shadow.getElementById("settings-folder-name");
    const settingsQuality = shadow.getElementById("settings-quality");
    const settingsAskLocation = shadow.getElementById("settings-ask-location");
    const settingsHint = shadow.getElementById("settings-hint");
    const settingsCancel = shadow.getElementById("settings-cancel");
    const settingsSave = shadow.getElementById("settings-save");
    const downloadAll = shadow.getElementById("download-all");
    const downloadSelected = shadow.getElementById("download-selected");
    const downloadSelectedFolder = shadow.getElementById("download-selected-folder");
    enablePanelResize(panel, shadow.getElementById("resize-handle"));
    const objectUrls = new Set();
    const selectedKeys = new Set();
    let downloadDirectoryHandle = null;
    let downloadDirectoryName = "";
    let activeType = "image";
    let lastSelectedKey = null;

    const drag = enablePanelDrag(host, header);

    loadDirectoryHandle().then((handle) => {
      if (!handle) return;
      downloadDirectoryHandle = handle;
      downloadDirectoryName = handle.name || "已选文件夹";
      settingsFolderName.textContent = downloadDirectoryName;
      updateSettingsHint();
    });

    shadow.getElementById("collapse").addEventListener("click", (event) => {
      panel.classList.toggle("collapsed");
      event.currentTarget.title = panel.classList.contains("collapsed") ? "展开面板" : "收起面板";
      drag.reanchorAfterCollapse();
    });
    shadow.getElementById("close").addEventListener("click", () => {
      panel.classList.add("closed");
      panel.classList.remove("collapsed");
      drag.dockEdge();
    });
    shadow.getElementById("launcher").addEventListener("click", () => {
      panel.classList.remove("closed");
      drag.dockOpen();
      drag.restorePosition();
    });

    shadow.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", () => {
      activeType = button.dataset.type;
      lastSelectedKey = null;
      render();
    }));

    function updateSettingsHint() {
      if (downloadDirectoryHandle) {
        settingsHint.textContent = `基础文件夹：${downloadDirectoryName}；下载会直接写入该文件夹和子目录。`;
        return;
      }
      settingsHint.textContent = settingsAskLocation.checked
        ? "开启后单项或批量下载会由 Chrome 逐项询问保存位置。"
        : "保存到浏览器默认下载目录下的相对子目录。";
    }

    async function loadDownloadSettings() {
      const response = await sendRuntimeMessage({ type: "GET_DOWNLOAD_SETTINGS" });
      if (response?.ok === false) {
        settingsHint.style.color = "#b91c1c";
        settingsHint.textContent = "读取失败：" + (response.error || "未知错误");
        return;
      }
      settingsHint.style.color = "";
      settingsSubdir.value = response.downloadSubdir || "";
      settingsQuality.value = response.downloadQuality || "high";
      settingsAskLocation.checked = response.downloadAskLocation === true;
      updateSettingsHint();
    }

    settingsButton.addEventListener("click", async () => {
      settingsPanel.hidden = !settingsPanel.hidden;
      if (!settingsPanel.hidden) {
        await loadDownloadSettings();
        settingsSubdir.focus();
      }
    });

    settingsCancel.addEventListener("click", () => {
      settingsPanel.hidden = true;
    });

    settingsPickFolder.addEventListener("click", async () => {
      if (typeof window.showDirectoryPicker !== "function") {
        settingsFolderName.textContent = "当前浏览器不支持文件夹模式";
        return;
      }
      settingsPickFolder.disabled = true;
      try {
        const handle = await window.showDirectoryPicker({ mode: "readwrite" });
        const writable = await getWritableDirectory(handle);
        if (!writable) throw new Error("没有获得文件夹写入权限");
        await saveDirectoryHandle(handle);
        downloadDirectoryHandle = handle;
        downloadDirectoryName = handle.name || "已选文件夹";
        settingsFolderName.textContent = downloadDirectoryName;
        settingsHint.textContent = "已选择基础文件夹；页内面板下载会直接写入该文件夹和子目录。";
      } catch (error) {
        if (error?.name !== "AbortError") settingsFolderName.textContent = `选择失败：${error.message || "未知错误"}`;
      } finally {
        settingsPickFolder.disabled = false;
      }
    });

    settingsSave.addEventListener("click", async () => {
      settingsSave.disabled = true;
      const response = await sendRuntimeMessage({
        type: "SET_DOWNLOAD_SETTINGS",
        downloadSubdir: settingsSubdir.value,
        downloadQuality: settingsQuality.value,
        downloadAskLocation: settingsAskLocation.checked
      });
      settingsSave.disabled = false;
      if (response?.ok === false) {
        settingsHint.style.color = "#b91c1c";
        settingsHint.textContent = "保存失败：" + (response.error || "未知错误");
        return;
      }
      settingsSubdir.value = response.downloadSubdir || "";
      settingsQuality.value = response.downloadQuality || "high";
      settingsAskLocation.checked = response.downloadAskLocation === true;
      updateSettingsHint();
      settingsHint.style.color = "#15803d";
      settingsHint.textContent = `设置已保存：${response.downloadSubdir || "默认下载目录"} · ${response.downloadQuality || "high"}`;
      setTimeout(() => {
        settingsHint.style.color = "";
        settingsPanel.hidden = true;
      }, 900);
      setStatus("captured");
    });

    supportAuthor.addEventListener("click", () => {
      window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
    });

    function activeItems() {
      return activeType === "image" ? sessionImageRecords() : Array.from(sessionVideos.values());
    }

    function orderedActiveItems(items = activeItems()) {
      return [...items].sort((a, b) => (b.captured_at || 0) - (a.captured_at || 0));
    }

    function selectionKey(type, record) {
      return `${type}:${type === "image" ? record.image_id : record.video_record_id}`;
    }

    function updateSelectionUi(items = orderedActiveItems()) {
      const selectedCount = items.reduce((count, record) => count + (selectedKeys.has(selectionKey(activeType, record)) ? 1 : 0), 0);
      const label = downloadSelected.querySelector("span");
      if (label) label.textContent = `下载选中 (${selectedCount})`;
      downloadSelected.disabled = selectedCount === 0;
      downloadSelectedFolder.disabled = selectedCount === 0;
      selectAllCurrent.disabled = items.length === 0;
      selectAllCurrent.checked = items.length > 0 && selectedCount === items.length;
      selectAllCurrent.indeterminate = selectedCount > 0 && selectedCount < items.length;
      selectionSummary.textContent = `已选 ${selectedCount} / ${items.length}`;
      list.querySelectorAll(".item[data-selection-key]").forEach((item) => {
        const selected = selectedKeys.has(item.dataset.selectionKey);
        item.classList.toggle("selected", selected);
        const checkbox = item.querySelector(".select-wrap input");
        if (checkbox) checkbox.checked = selected;
      });
      return selectedCount;
    }

    selectAllCurrent.addEventListener("change", () => {
      const items = orderedActiveItems();
      for (const record of items) {
        const key = selectionKey(activeType, record);
        if (selectAllCurrent.checked) selectedKeys.add(key);
        else selectedKeys.delete(key);
      }
      lastSelectedKey = selectAllCurrent.checked && items.length
        ? selectionKey(activeType, items[items.length - 1])
        : null;
      updateSelectionUi(items);
    });

    async function submitSingleDownload(type, record) {
      if (downloadDirectoryHandle) {
        try {
          const settings = await sendRuntimeMessage({ type: "GET_DOWNLOAD_SETTINGS" });
          await writeMediaWithDirectory(downloadDirectoryHandle, type, record, settings, 0);
          setStatus("captured", `已保存到 ${downloadDirectoryName}`);
          return { ok: true, direct: true };
        } catch (error) {
          setStatus("error", `文件夹写入失败，已改用浏览器下载：${error.message || "未知错误"}`);
        }
      }
      return sendRuntimeMessage(type === "image"
        ? { type: "DOWNLOAD_IMAGE", image: record }
        : { type: "DOWNLOAD_VIDEO", video: record });
    }

    async function submitDownloads(items, labelButton, completeLabel) {
      if (!items.length) return;
      downloadAll.disabled = true;
      downloadSelected.disabled = true;
      downloadSelectedFolder.disabled = true;
      const downloadLabel = labelButton.querySelector("span");
      if (downloadLabel) downloadLabel.textContent = "提交中…";
      if (downloadDirectoryHandle) {
        const settings = await sendRuntimeMessage({ type: "GET_DOWNLOAD_SETTINGS" });
        let success = 0;
        const failed = [];
        for (let index = 0; index < items.length; index += 1) {
          try {
            await writeMediaWithDirectory(downloadDirectoryHandle, activeType, items[index], settings, index + 1);
            success += 1;
          } catch (_) {
            failed.push(items[index]);
          }
        }
        if (failed.length) {
          const fallback = activeType === "image"
            ? { type: "BATCH_DOWNLOAD", images: failed }
            : { type: "BATCH_VIDEO_DOWNLOAD", videos: failed };
          await sendRuntimeMessage(fallback);
        }
        downloadAll.disabled = false;
        updateSelectionUi();
        if (downloadLabel) downloadLabel.textContent = completeLabel;
        setStatus(failed.length ? "error" : "captured", `已直接保存 ${success} 项${failed.length ? `，另有 ${failed.length} 项交给浏览器下载` : ""}`);
        return;
      }
      const response = await sendRuntimeMessage(activeType === "image"
        ? { type: "BATCH_DOWNLOAD", images: items }
        : { type: "BATCH_VIDEO_DOWNLOAD", videos: items });
      downloadAll.disabled = false;
      updateSelectionUi();
      if (downloadLabel) downloadLabel.textContent = completeLabel;
      setStatus(response?.ok === false ? "error" : "captured", response?.ok === false ? response.error : `已提交 ${items.length} 项下载`);
    }

    async function submitSelectedToFolder() {
      const items = orderedActiveItems().filter((record) => selectedKeys.has(selectionKey(activeType, record)));
      if (!items.length) return;
      if (typeof window.showDirectoryPicker !== "function") {
        setStatus("error", "当前浏览器不支持一次选择文件夹，请使用设置里的基础文件夹或浏览器下载");
        return;
      }
      const label = downloadSelectedFolder.querySelector("span");
      downloadAll.disabled = true;
      downloadSelected.disabled = true;
      downloadSelectedFolder.disabled = true;
      if (label) label.textContent = "选择文件夹…";
      try {
        const pickerOptions = { mode: "readwrite" };
        if (downloadDirectoryHandle) pickerOptions.startIn = downloadDirectoryHandle;
        const handle = await window.showDirectoryPicker(pickerOptions);
        const writable = await getWritableDirectory(handle);
        if (!writable) throw new Error("没有获得文件夹写入权限");
        if (label) label.textContent = "保存中…";
        const settings = await sendRuntimeMessage({ type: "GET_DOWNLOAD_SETTINGS" });
        let success = 0;
        const failed = [];
        for (let index = 0; index < items.length; index += 1) {
          try {
            await writeMediaWithDirectory(handle, activeType, items[index], settings, index + 1);
            success += 1;
          } catch (error) {
            failed.push(error);
          }
        }
        setStatus(failed.length ? "error" : "captured", `已另存 ${success} 项${failed.length ? `，${failed.length} 项保存失败` : ""}`);
      } catch (error) {
        if (error?.name !== "AbortError") setStatus("error", `另存失败：${error.message || "未知错误"}`);
      } finally {
        if (label) label.textContent = "选中另存为";
        updateSelectionUi();
        downloadAll.disabled = activeItems().length === 0;
      }
    }

    downloadAll.addEventListener("click", () => submitDownloads(activeItems(), downloadAll, "全部下载"));
    downloadSelected.addEventListener("click", () => {
      const items = activeItems().filter((record) => selectedKeys.has(selectionKey(activeType, record)));
      submitDownloads(items, downloadSelected, `下载选中 (${items.length})`);
    });
    downloadSelectedFolder.addEventListener("click", submitSelectedToFolder);

    function formatMeta(record, type) {
      const width = record.width || "?";
      const height = record.height || "?";
      const ext = String(type === "image" ? record.extension || "jpg" : record.format || "mp4").toUpperCase();
      return `${width} × ${height} · ${ext}`;
    }

    function appendItem(type, record) {
      const item = document.createElement("div");
      item.className = "item";
      const key = selectionKey(type, record);
      item.dataset.selectionKey = key;
      item.classList.toggle("selected", selectedKeys.has(key));
      const selectWrap = document.createElement("label");
      selectWrap.className = "select-wrap";
      selectWrap.title = "选择下载";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedKeys.has(key);
      checkbox.setAttribute("aria-label", `选择${type === "image" ? "图片" : "视频"}`);
      checkbox.addEventListener("click", (event) => {
        const items = orderedActiveItems();
        const currentIndex = items.findIndex((recordItem) => selectionKey(type, recordItem) === key);
        const previousIndex = lastSelectedKey
          ? items.findIndex((recordItem) => selectionKey(type, recordItem) === lastSelectedKey)
          : -1;
        if (event.shiftKey && currentIndex >= 0 && previousIndex >= 0) {
          event.preventDefault();
          const nextChecked = !selectedKeys.has(key);
          const start = Math.min(currentIndex, previousIndex);
          const end = Math.max(currentIndex, previousIndex);
          for (let index = start; index <= end; index += 1) {
            const rangeKey = selectionKey(type, items[index]);
            if (nextChecked) selectedKeys.add(rangeKey);
            else selectedKeys.delete(rangeKey);
          }
          lastSelectedKey = key;
          updateSelectionUi(items);
          return;
        }
        // Normal clicks and Ctrl/Command clicks use the native checkbox toggle.
        // The change handler below applies that one-item toggle to selectedKeys.
        lastSelectedKey = key;
      });
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedKeys.add(key); else selectedKeys.delete(key);
        updateSelectionUi(orderedActiveItems());
      });
      selectWrap.appendChild(checkbox);
      const image = document.createElement("img");
      image.className = "thumb";
      image.alt = type === "image" ? "图片缩略图" : "视频封面";
      image.loading = "lazy";
      image.decoding = "async";
      if (record.thumbnail_blob instanceof Blob) {
        const url = URL.createObjectURL(record.thumbnail_blob);
        objectUrls.add(url);
        image.src = url;
      } else if (type === "image") {
        image.src = record.image_thumb_url || record.image_preview_url || record.image_ori_url || record.image_ori_raw_url || "";
      } else if (record.poster_url) image.src = record.poster_url;
      const info = document.createElement("div");
      info.className = "info";
      const name = document.createElement("strong");
      name.textContent = type === "image" ? "无水印图片" : "无水印视频";
      const meta = document.createElement("span");
      meta.textContent = formatMeta(record, type);
      if (type === "image" && (!record.width || !record.height)) {
        image.addEventListener("load", () => {
          if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
          if (!record.width || !record.height) {
            record.width = image.naturalWidth;
            record.height = image.naturalHeight;
            records.set(record.image_id, record);
          }
          meta.textContent = formatMeta(record, type);
        }, { once: true });
      }
      info.append(name, meta);
      const download = document.createElement("button");
      download.className = "download";
      download.textContent = "下载";
      download.addEventListener("click", async () => {
        download.disabled = true;
        download.textContent = "提交…";
        const response = await submitSingleDownload(type, record);
        download.disabled = false;
        download.textContent = "下载";
        setStatus(response?.ok === false ? "error" : "captured", response?.ok === false ? response.error : "下载任务已提交");
      });
      item.append(selectWrap, image, info, download);
      list.appendChild(item);
    }

    function render() {
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      list.replaceChildren();
      const images = sessionImageRecords();
      const videos = Array.from(sessionVideos.values());
      shadow.getElementById("image-count").textContent = String(images.length);
      shadow.getElementById("video-count").textContent = String(videos.length);
      shadow.querySelectorAll(".tab").forEach((button) => button.classList.toggle("active", button.dataset.type === activeType));
      const items = orderedActiveItems(activeType === "image" ? images : videos);
      const visibleKeys = new Set(items.map((record) => selectionKey(activeType, record)));
      for (const key of selectedKeys) {
        if (key.startsWith(`${activeType}:`) && !visibleKeys.has(key)) selectedKeys.delete(key);
      }
      downloadAll.disabled = items.length === 0;
      const downloadLabel = downloadAll.querySelector("span");
      if (downloadLabel) downloadLabel.textContent = "全部下载";
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = activeType === "image" ? "当前会话暂未识别到图片" : "当前会话暂未识别到视频";
        list.appendChild(empty);
      } else items.forEach((record) => appendItem(activeType, record));
      updateSelectionUi(items);
    }

    const append = () => {
      if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
    };
    append();
    if (!host.isConnected) document.addEventListener("DOMContentLoaded", append, { once: true });
    return {
      host,
      refresh: render,
      reset: () => { activeType = "image"; selectedKeys.clear(); lastSelectedKey = null; render(); },
      showVideo: (record) => {
        if (!record?.video_record_id) return;
        sessionVideos.set(record.video_record_id, record);
        if (!records.size && sessionVideos.size === 1) activeType = "video";
        render();
      },
      revoke: () => objectUrls.forEach((url) => URL.revokeObjectURL(url))
    };
  }

  function broadcastEnabledToPage() {
    window.postMessage({ type: "DOUBAO_SET_ENABLED", enabled: extensionEnabled }, location.origin);
  }

  function applyExtensionEnabled() {
    broadcastEnabledToPage();
    if (mediaPanel?.host) mediaPanel.host.style.display = extensionEnabled ? "" : "none";
    if (!extensionEnabled) {
      const toast = document.getElementById("doubao-wm-ready-toast");
      if (toast) toast.remove();
      readyToastShown = false;
      setStatus("listening");
      return;
    }
    scheduleEnhance();
    requestFiberScan(false, 260);
    mediaPanel.refresh();
    showReadyToast();
  }

  function bootstrapExtensionEnabled() {
    chrome.storage.local.get({ extensionEnabled: true }, (stored) => {
      extensionEnabled = stored.extensionEnabled !== false;
      applyExtensionEnabled();
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.extensionEnabled) return;
    extensionEnabled = changes.extensionEnabled.newValue !== false;
    applyExtensionEnabled();
  });

  function enablePanelResize(panel, handle) {
    const SIZE_KEY = "doubaoMediaPanelSize_v1";
    const MIN_WIDTH = 260;
    const MIN_HEIGHT = 180;
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;

    function limits() {
      return {
        maxWidth: Math.max(MIN_WIDTH, Math.min(720, window.innerWidth - 32)),
        maxHeight: Math.max(MIN_HEIGHT, Math.min(Math.floor(window.innerHeight * 0.82), window.innerHeight - 48))
      };
    }

    function applySize(width, height) {
      const { maxWidth, maxHeight } = limits();
      const nextWidth = Math.min(maxWidth, Math.max(MIN_WIDTH, Math.round(width)));
      const nextHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, Math.round(height)));
      panel.style.width = nextWidth + "px";
      panel.style.height = nextHeight + "px";
    }

    function restoreSize() {
      try {
        const saved = JSON.parse(localStorage.getItem(SIZE_KEY) || "null");
        if (Number.isFinite(saved?.width) && Number.isFinite(saved?.height)) {
          applySize(saved.width, saved.height);
        }
      } catch (_) {
        // ignore malformed local settings
      }
    }

    function saveSize() {
      const rect = panel.getBoundingClientRect();
      try {
        localStorage.setItem(SIZE_KEY, JSON.stringify({
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }));
      } catch (_) {
        // ignore private mode / quota failures
      }
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      resizing = true;
      const rect = panel.getBoundingClientRect();
      startX = event.clientX;
      startY = event.clientY;
      startWidth = rect.width;
      startHeight = rect.height;
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!resizing) return;
      applySize(startWidth + event.clientX - startX, startHeight + event.clientY - startY);
      event.preventDefault();
    });

    function endResize(event) {
      if (!resizing) return;
      resizing = false;
      try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
      saveSize();
    }

    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
    window.addEventListener("resize", () => {
      const rect = panel.getBoundingClientRect();
      applySize(rect.width, rect.height);
    });
    restoreSize();
  }

  function enablePanelDrag(host, handle) {
    const POSITION_KEY = "doubaoMediaPanelPosition_v3";
    const OPEN_CSS = "position:fixed;right:18px;bottom:24px;left:auto;top:auto;z-index:2147483645;pointer-events:auto;";
    const EDGE_CSS = "position:fixed;right:8px;bottom:24px;left:auto;top:auto;z-index:2147483645;pointer-events:auto;";
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let moved = false;

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function dockOpen() {
      host.style.cssText = OPEN_CSS;
    }

    function dockEdge() {
      host.style.cssText = EDGE_CSS;
    }

    function applyPosition(left, top) {
      const rect = host.getBoundingClientRect();
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
      const nextLeft = clamp(left, 8, maxLeft);
      const nextTop = clamp(top, 8, maxTop);
      host.style.left = `${nextLeft}px`;
      host.style.top = `${nextTop}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
      return { left: nextLeft, top: nextTop };
    }

    function restorePosition() {
      try {
        const raw = localStorage.getItem(POSITION_KEY);
        if (!raw) return false;
        const saved = JSON.parse(raw);
        if (!Number.isFinite(saved?.left) || !Number.isFinite(saved?.top)) return false;
        applyPosition(saved.left, saved.top);
        return true;
      } catch (_) {
        return false;
      }
    }

    function savePosition() {
      const rect = host.getBoundingClientRect();
      try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
      } catch (_) {
        // ignore quota / private mode failures
      }
    }

    /** 收缩后高度变矮时保持底边不动，避免关掉后悬浮球漂到画面中间 */
    function reanchorAfterCollapse() {
      if (!host.style.left || host.style.left === "auto") return;
      const rect = host.getBoundingClientRect();
      const bottomGap = Math.max(8, window.innerHeight - rect.bottom);
      requestAnimationFrame(() => {
        const next = host.getBoundingClientRect();
        const nextTop = Math.max(8, window.innerHeight - bottomGap - next.height);
        applyPosition(next.left, nextTop);
      });
    }

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (event.target.closest("button")) return;
      const rect = host.getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      applyPosition(originLeft, originTop);
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      applyPosition(originLeft + dx, originTop + dy);
    });

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture?.(event.pointerId); } catch (_) {}
      if (moved) savePosition();
    }

    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    window.addEventListener("resize", () => {
      const rect = host.getBoundingClientRect();
      if (host.style.left && host.style.left !== "auto") applyPosition(rect.left, rect.top);
    });

    restorePosition();
    return { dockOpen, dockEdge, restorePosition, reanchorAfterCollapse };
  }

  function isAllowedUrl(value) {
    if (typeof value !== "string" || value.length > 8192) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        (url.hostname === "byteimg.com" || url.hostname.endsWith(".byteimg.com"));
    } catch (_) {
      return false;
    }
  }

  function normalizeUrl(value) {
    if (!isAllowedUrl(value)) return null;
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.href;
  }

  function pathKey(value) {
    if (!isAllowedUrl(value)) return null;
    try {
      return decodeURIComponent(new URL(value).pathname)
        .replace(/\.(?:jpe?g|png|webp|avif|gif)$/i, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .slice(-180);
    } catch (_) {
      return null;
    }
  }

  function extractChatIdFromLocation() {
    const url = new URL(location.href);
    const pathMatch = url.pathname.match(/\/(?:chat|conversation)\/([^/?#]+)/i);
    const queryId = url.searchParams.get("conversation_id") || url.searchParams.get("conversationId") ||
      url.searchParams.get("chat_id") || url.searchParams.get("chatId");
    const hashMatch = url.hash.match(/(?:conversation|chat)[_/-]?(?:id)?[=/:-]([^&/?#]+)/i);
    return String(queryId || pathMatch?.[1] || hashMatch?.[1] || "").trim();
  }

  function isConcreteChatId(chatId) {
    const id = String(chatId || "").trim();
    if (!id) return false;
    if (/^(home|chat|conversation|new|index|explore|discover|bot|agent)?$/i.test(id)) return false;
    // 豆包真实会话 ID 通常是较长数字/字母串；过短的多半是路由占位。
    if (id.length < 10) return false;
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  function isConcreteChatPage() {
    return isConcreteChatId(extractChatIdFromLocation());
  }

  function getConversationMeta() {
    const url = new URL(location.href);
    const pathId = extractChatIdFromLocation() || "home";
    const conversationId = `${url.origin}:${pathId}`.slice(0, 500);
    let rawTitle = String(document.title || "")
      .replace(/\s*[-|｜]\s*豆包.*$/i, "")
      .replace(/^豆包\s*[-|｜]?\s*/i, "")
      .replace(/字节跳动旗下.*$/i, "")
      .trim();
    if (!rawTitle || rawTitle === "豆包" || /智能助手/i.test(rawTitle)) rawTitle = "";
    const shortId = pathId.length > 16 ? pathId.slice(-10) : pathId;
    return {
      conversation_id: conversationId,
      conversation_chat_id: pathId.slice(0, 200),
      conversation_title: rawTitle ? rawTitle.slice(0, 120) : (isConcreteChatId(pathId) ? `对话 ${shortId}` : "未进入会话"),
      page_url: `${url.origin}${url.pathname}`
    };
  }

  function syncPageSession() {
    const nextId = getConversationMeta().conversation_id;
    if (nextId === sessionConversationId) return;
    sessionConversationId = nextId;
    records.clear();
    sessionVideos.clear();
    visibleImageIds.clear();
    urlIndex.clear();
    mediaPanel.reset();
    setStatus("listening");
    sessionRescanUntil = Date.now() + 8000;
    requestFiberScan(true, 80);
    scheduleConversationTitleSync();
  }

  let titleSyncTimer = null;
  function scheduleConversationTitleSync() {
    clearTimeout(titleSyncTimer);
    titleSyncTimer = setTimeout(() => {
      if (!isConcreteChatPage()) return;
      const meta = getConversationMeta();
      const title = String(meta.conversation_title || "").trim();
      if (!title || /^(未分类历史|未命名会话|未进入会话|当前会话)$/.test(title)) return;
      if (/^对话\s+\S+$/.test(title) || /智能助手|字节跳动旗下/.test(title)) return;
      sendRuntimeMessage({
        type: "UPDATE_CONVERSATION_TITLE",
        conversation_id: meta.conversation_id,
        conversation_chat_id: meta.conversation_chat_id,
        conversation_title: title
      }).catch(() => {});
    }, 1600);
  }

  function validateRecord(value) {
    if (!value || typeof value !== "object") return null;
    const urls = {
      image_ori_raw_url: isAllowedUrl(value.image_ori_raw_url) ? value.image_ori_raw_url : null,
      image_ori_url: isAllowedUrl(value.image_ori_url) ? value.image_ori_url : null,
      image_preview_url: isAllowedUrl(value.image_preview_url) ? value.image_preview_url : null,
      image_thumb_url: isAllowedUrl(value.image_thumb_url) ? value.image_thumb_url : null
    };
    // 必须有无水印原图，避免把搜索/文档截图等干扰图入库。
    if (!urls.image_ori_raw_url) return null;
    const bestUrl = urls.image_ori_raw_url || urls.image_ori_url ||
      urls.image_preview_url || urls.image_thumb_url;
    if (!bestUrl) return null;

    const rawId = typeof value.image_id === "string" ? value.image_id : pathKey(bestUrl);
    const imageId = String(rawId || pathKey(bestUrl))
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 200);
    if (!imageId) return null;

    const width = Number(value.width || value.image_width || 0);
    const height = Number(value.height || value.image_height || 0);
    let extension = typeof value.extension === "string" ? value.extension.toLowerCase() : null;
    if (!extension) {
      try {
        const match = decodeURIComponent(new URL(bestUrl).pathname).match(/\.([a-z0-9]{2,5})$/i);
        extension = match?.[1]?.toLowerCase() === "jpeg" ? "jpg" : match?.[1]?.toLowerCase() || null;
      } catch (_) {
        extension = null;
      }
    }

    return {
      image_id: imageId,
      ...urls,
      best_url: bestUrl,
      width: width > 0 ? width : 0,
      height: height > 0 ? height : 0,
      extension,
      captured_at: Number.isFinite(value.captured_at) ? value.captured_at : Date.now(),
      page_chat_id: typeof value.page_chat_id === "string" ? value.page_chat_id.slice(0, 200) : "",
      ...getConversationMeta()
    };
  }

  function isComposerOrInputImage(img) {
    if (!img?.isConnected) return false;
    if (img.closest([
      "footer",
      "form",
      '[class*="composer" i]',
      '[class*="input" i]',
      '[class*="editor" i]',
      '[class*="textarea" i]',
      '[class*="prompt" i]',
      '[data-testid*="composer" i]',
      '[data-testid*="input" i]',
      '[aria-label*="输入" i]',
      '[placeholder*="输入" i]'
    ].join(","))) {
      return true;
    }
    const rect = img.getBoundingClientRect();
    return rect.bottom > window.innerHeight * 0.72 && rect.height < 220;
  }

  function assetKeyFromUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return "";
      let path = decodeURIComponent(url.pathname);
      path = path.replace(/~[^/]+$/i, "");
      path = path.replace(/\.(?:jpe?g|png|webp|avif|gif)$/i, "");
      return path.toLowerCase();
    } catch (_) {
      return "";
    }
  }

  function resolveImageIdByRawUrl(url) {
    if (!url) return null;
    const normalized = normalizeUrl(url);
    const key = pathKey(url);
    const id = (normalized && urlIndex.get(`url:${normalized}`)) ||
      (key && urlIndex.get(`path:${key}`));
    if (id && records.has(id)) return id;
    const assetKey = assetKeyFromUrl(url);
    if (assetKey) {
      const assetId = urlIndex.get(`asset:${assetKey}`);
      if (assetId && records.has(assetId)) return assetId;
    }
    return null;
  }

  function registerRecord(next) {
    const rawUrl = next.image_ori_raw_url || next.best_url;
    const existingId = resolveImageIdByRawUrl(rawUrl);
    if (existingId) next.image_id = existingId;

    const previous = records.get(next.image_id) || {};
    const merged = {
      ...previous,
      ...next,
      image_ori_raw_url: next.image_ori_raw_url || previous.image_ori_raw_url || null,
      image_ori_url: next.image_ori_url || previous.image_ori_url || null,
      image_preview_url: next.image_preview_url || previous.image_preview_url || null,
      image_thumb_url: next.image_thumb_url || previous.image_thumb_url || null
    };
    merged.best_url = merged.image_ori_raw_url || merged.image_ori_url ||
      merged.image_preview_url || merged.image_thumb_url;
    merged.width = next.width || previous.width || 0;
    merged.height = next.height || previous.height || 0;
    merged.extension = next.extension || previous.extension || null;
    records.set(merged.image_id, merged);

    for (const url of [merged.image_ori_raw_url, merged.image_ori_url,
      merged.image_preview_url, merged.image_thumb_url]) {
      const normalized = normalizeUrl(url);
      const key = pathKey(url);
      const assetKey = assetKeyFromUrl(url);
      if (normalized) urlIndex.set(`url:${normalized}`, merged.image_id);
      if (key) urlIndex.set(`path:${key}`, merged.image_id);
      if (assetKey) urlIndex.set(`asset:${assetKey}`, merged.image_id);
    }
    return merged;
  }

  function findRecordForImage(img) {
    const remembered = imageRecords.get(img);
    if (remembered && records.has(remembered)) return records.get(remembered);

    const candidates = [img.currentSrc, img.src, img.getAttribute("src")].filter(Boolean);
    for (const value of candidates) {
      const normalized = normalizeUrl(value);
      const key = pathKey(value);
      const assetKey = assetKeyFromUrl(value);
      const id = (normalized && urlIndex.get(`url:${normalized}`)) ||
        (key && urlIndex.get(`path:${key}`)) ||
        (assetKey && urlIndex.get(`asset:${assetKey}`));
      if (id && records.has(id)) {
        imageRecords.set(img, id);
        return records.get(id);
      }
    }
    return null;
  }

  function setStatus(next) {
    status = next;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: true });
      });
    });
  }

  async function handleCapturedImages(values) {
    if (!extensionEnabled) return;
    syncPageSession();
    // 首页 / 未进入具体会话时不入库，避免把推荐位、示例图扫进「未命名会话」。
    if (!isConcreteChatPage()) return;
    const capturedForConversation = sessionConversationId;
    const currentChat = extractChatIdFromLocation();
    const valid = values.slice(0, 200)
      .filter((raw) => {
        const pageChat = typeof raw?.page_chat_id === "string" ? raw.page_chat_id.trim() : "";
        // 必须带当前会话 ID，拒绝 pending / 空 / 其它会话，避免冲进「未命名会话」。
        return Boolean(pageChat) && pageChat === currentChat;
      })
      .map(validateRecord)
      .filter(Boolean);
    if (!valid.length) return;
    const changed = [];
    for (const next of valid) {
      const previous = records.get(next.image_id);
      const merged = registerRecord(next);
      if (!previous ||
          previous.image_ori_raw_url !== merged.image_ori_raw_url ||
          previous.image_ori_url !== merged.image_ori_url ||
          previous.image_preview_url !== merged.image_preview_url ||
          previous.image_thumb_url !== merged.image_thumb_url ||
          previous.conversation_id !== merged.conversation_id ||
          previous.conversation_title !== merged.conversation_title) {
        changed.push(merged);
      }
    }
    setStatus("loading");
    scheduleEnhance(0);
    mediaPanel.refresh();
    // 多图流式后两张常晚到：入库后继续补扫一段时间。
    sessionRescanUntil = Math.max(sessionRescanUntil, Date.now() + 5000);
    requestFiberScan(true, 200);
    setTimeout(() => {
      if (Date.now() < sessionRescanUntil) requestFiberScan(true, 0);
    }, 800);
    setTimeout(() => {
      if (Date.now() < sessionRescanUntil) {
        requestFiberScan(true, 0);
        scheduleEnhance(0);
      }
    }, 1800);

    if (!changed.length) {
      setStatus("captured");
      scheduleEnhance(0);
      mediaPanel.refresh();
      return;
    }

    const response = await sendRuntimeMessage({ type: "DOUBAO_IMAGES", images: changed });
    if (capturedForConversation !== sessionConversationId) return;
    if (response?.ok === false) setStatus("error", `原图处理失败：${response.error || "未知错误"}`);
    else {
      for (const result of response.results || []) {
        if (!result?.ok || !result.image?.image_id || !records.has(result.image.image_id)) continue;
        // 背景若保留了其它会话归属，不要覆盖进当前页面板。
        if (result.image.conversation_id &&
            result.image.conversation_id !== sessionConversationId &&
            result.image.conversation_chat_id &&
            result.image.conversation_chat_id !== currentChat) {
          records.delete(result.image.image_id);
          continue;
        }
        registerRecord(result.image);
      }
      setStatus("captured");
    }
    scheduleEnhance(0);
    mediaPanel.refresh();
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "DOUBAO_CHAT_CHANGED") {
      syncPageSession();
      if (extensionEnabled && isConcreteChatPage()) {
        sessionRescanUntil = Date.now() + 8000;
        requestFiberScan(true, 30);
        scheduleEnhance(20);
      }
      return;
    }
    if (event.data?.type === "DOUBAO_ORIGINAL_IMAGES" && Array.isArray(event.data.images)) {
      handleCapturedImages(event.data.images);
    }
    if (event.data?.type === "DOUBAO_VIDEO_FALLBACKS" && Array.isArray(event.data.items) && event.data.items.length) {
      if (!extensionEnabled || !isConcreteChatPage()) return;
      const currentChat = extractChatIdFromLocation();
      const items = event.data.items
        .slice(0, 50)
        .filter((item) => {
          const pageChat = typeof item?.page_chat_id === "string" ? item.page_chat_id.trim() : "";
          return Boolean(pageChat) && pageChat === currentChat;
        });
      if (!items.length) return;
      sendRuntimeMessage({
        type: "DOUBAO_VIDEO_FALLBACKS",
        items
      }).catch(() => {});
    }
    if (event.data?.type === "DOUBAO_ORIGINAL_STATUS" &&
        event.data.status === "listening" && !records.size) {
      setStatus("listening");
    }
  });

  function nodeContainsImage(node) {
    if (!(node instanceof Element)) return false;
    const selector = "img";
    return node.matches(selector) || Boolean(node.querySelector(selector));
  }

  function handleMutations(mutations) {
    syncPageSession();
    const touchesMedia = mutations.some((mutation) => {
      if (mutation.type === "attributes") return mutation.target instanceof HTMLImageElement;
      return Array.from(mutation.addedNodes).some(nodeContainsImage) ||
        Array.from(mutation.removedNodes).some(nodeContainsImage);
    });
    if (touchesMedia) {
      scheduleEnhance(45);
      if (Date.now() < sessionRescanUntil) requestFiberScan(true, 90);
    }
  }

  function scheduleEnhance(delay = 35) {
    if (!extensionEnabled) return;
    syncPageSession();
    // 允许用更短 delay 抢跑，避免「看板已有图、会话内还卡在水印」时被旧定时器拖住。
    clearTimeout(enhanceTimer);
    enhanceScheduled = true;
    enhanceTimer = setTimeout(() => {
      enhanceScheduled = false;
      enhanceTimer = null;
      enhanceImages();
    }, Math.max(0, delay));
  }

  function requestFiberScan(force = false, delay = 120) {
    if (!extensionEnabled) return;
    if (!isConcreteChatPage()) return;
    const minGap = force ? 100 : 700;
    if (!force && (fiberScanTimer || Date.now() - lastFiberScanAt < minGap)) return;
    if (force && Date.now() - lastFiberScanAt < 80 && fiberScanTimer) return;
    clearTimeout(fiberScanTimer);
    fiberScanTimer = setTimeout(() => {
      fiberScanTimer = null;
      lastFiberScanAt = Date.now();
      window.postMessage({ type: "DOUBAO_ORIGINAL_FIBER_SCAN", force }, location.origin);
    }, force ? Math.min(delay, 40) : delay);
  }

  function enhanceImages() {
    if (!extensionEnabled || !document.body) return;
    const images = document.querySelectorAll('img[src*="byteimg.com"], img[srcset*="byteimg.com"]');
    const nextVisibleIds = new Set();
    let unmatched = 0;
    let metaUpdated = false;
    for (const img of images) {
      if (img.naturalWidth && img.naturalWidth < 96) continue;
      if (!isConversationMediaImage(img)) continue;
      const record = findRecordForImage(img);
      if (!record) {
        unmatched += 1;
        continue;
      }
      // 面板与增强只处理当前会话记录，避免其它会话图片串进来。
      if (record.conversation_id && record.conversation_id !== sessionConversationId) continue;
      if (record.conversation_chat_id) {
        const currentChat = extractChatIdFromLocation();
        if (currentChat && record.conversation_chat_id !== currentChat) continue;
      }
      imageRecords.set(img, record.image_id);
      nextVisibleIds.add(record.image_id);

      if (img.naturalWidth > 0 && img.naturalHeight > 0 &&
          (record.width !== img.naturalWidth || record.height !== img.naturalHeight)) {
        record.width = img.naturalWidth;
        record.height = img.naturalHeight;
        records.set(record.image_id, record);
        metaUpdated = true;
      }

      const displayUrl = record.image_ori_raw_url || record.image_ori_url;
      if (displayUrl && img.src !== displayUrl) {
        img.removeAttribute("srcset");
        img.src = displayUrl;
      }
      retargetNearbyDownloadLinks(img, record);
    }

    const visibilityChanged = nextVisibleIds.size !== visibleImageIds.size ||
      Array.from(nextVisibleIds).some((imageId) => !visibleImageIds.has(imageId));
    visibleImageIds.clear();
    nextVisibleIds.forEach((imageId) => visibleImageIds.add(imageId));
    if (visibilityChanged || metaUpdated) mediaPanel.refresh();

    // 页面已出图但尚未匹配：只要还有未匹配图就强制 Fiber，避免四图只扫到前两张。
    if (unmatched) {
      sessionRescanUntil = Math.max(sessionRescanUntil, Date.now() + 5000);
      requestFiberScan(true, 40);
    }
  }

  function isConversationMediaImage(img) {
    if (!img?.isConnected) return false;
    if (img.closest('nav, aside, header, [role="navigation"], [aria-label*="导航"], [class*="sidebar" i], [class*="side-bar" i]')) {
      return false;
    }

    const linkedChat = img.closest('a[href*="/chat/"]');
    if (linkedChat) {
      try {
        const linkedId = new URL(linkedChat.href, location.href).pathname.match(/\/chat\/([^/?#]+)/)?.[1];
        const currentId = location.pathname.match(/\/chat\/([^/?#]+)/)?.[1];
        if (linkedId && currentId && linkedId !== currentId) return false;
      } catch (_) {
        return false;
      }
    }

    const main = document.querySelector('main, [role="main"]');
    if (main && !main.contains(img)) return false;

    const rect = img.getBoundingClientRect();
    if (rect.width < 110 || rect.height < 110) return false;

    const leftGuard = Math.min(180, window.innerWidth * 0.14);
    if (rect.right <= leftGuard) return false;
    if (isComposerOrInputImage(img)) return false;
    return true;
  }

  function retargetNearbyDownloadLinks(img, record) {
    const rawUrl = record.image_ori_raw_url || record.image_ori_url;
    if (!rawUrl) return;
    let container = img.parentElement;
    for (let level = 0; container && level < 5; level += 1, container = container.parentElement) {
      const links = container.querySelectorAll('a[download], a[href*="byteimg.com"]');
      for (const link of links) {
        if (looksLikeDownloadControl(link) && link.href !== rawUrl) link.href = rawUrl;
      }
      if (links.length) break;
    }
  }

  function controlLabel(control) {
    return [
      control.getAttribute("aria-label"),
      control.getAttribute("title"),
      control.getAttribute("data-testid"),
      control.getAttribute("data-e2e"),
      control.getAttribute("download"),
      control.textContent
    ].filter(Boolean).join(" ").trim().toLowerCase();
  }

  function looksLikeDownloadControl(control) {
    return /下载|保存|download|save/.test(controlLabel(control));
  }

  function matchedImagesInside(container) {
    const candidates = container.querySelectorAll?.('img[src*="byteimg.com"], img[srcset*="byteimg.com"]') || [];
    const matched = [];
    for (const img of candidates) {
      const record = findRecordForImage(img);
      if (record?.image_ori_raw_url || record?.image_ori_url) matched.push({ img, record });
    }
    return matched;
  }

  function findImageForControl(control) {
    const controlRect = control.getBoundingClientRect();
    let container = control.parentElement;

    for (let level = 0; container && level < 7; level += 1, container = container.parentElement) {
      const matched = matchedImagesInside(container);
      if (!matched.length) continue;
      if (matched.length === 1) return matched[0];

      matched.sort((a, b) => {
        const rectA = a.img.getBoundingClientRect();
        const rectB = b.img.getBoundingClientRect();
        const distanceA = Math.abs(rectA.left - controlRect.left) + Math.abs(rectA.bottom - controlRect.top);
        const distanceB = Math.abs(rectB.left - controlRect.left) + Math.abs(rectB.bottom - controlRect.top);
        return distanceA - distanceB;
      });
      return matched[0];
    }
    return null;
  }

  document.addEventListener("click", async (event) => {
    if (!extensionEnabled) return;
    const control = event.target.closest?.('button, a, [role="button"]');
    if (!control || !looksLikeDownloadControl(control)) return;
    const matched = findImageForControl(control);
    if (!matched) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const response = await sendRuntimeMessage({ type: "DOWNLOAD_IMAGE", image: matched.record });
    if (response?.ok === false) setStatus("error", response.error || "原图下载失败");
    else setStatus("captured", "已提交无水印原图下载");
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "EXTENSION_ENABLED_CHANGED") {
      extensionEnabled = message.enabled !== false;
      applyExtensionEnabled();
      sendResponse?.({ ok: true });
      return false;
    }
    if (message?.type === "DOUBAO_SESSION_VIDEO") {
      if (!extensionEnabled) return false;
      syncPageSession();
      if (message.video?.conversation_id === sessionConversationId) mediaPanel.showVideo(message.video);
      return false;
    }
    if (message?.type === "GET_STATUS") {
      sendResponse({
        ok: true,
        status,
        total: records.size,
        hookActive: extensionEnabled,
        enabled: extensionEnabled,
        ...getConversationMeta()
      });
      return false;
    }
    if (message?.type === "COLLECT_IMAGES") {
      sendResponse({ ok: true, images: extensionEnabled ? Array.from(records.values()) : [] });
      return false;
    }
    return false;
  });

  function start() {
    if (document.documentElement) {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcset"]
      });
    }
    broadcastEnabledToPage();
    window.postMessage({ type: "DOUBAO_ORIGINAL_BRIDGE_READY" }, location.origin);
    if (extensionEnabled) {
      requestFiberScan(false, 260);
      scheduleEnhance();
      mediaPanel.refresh();
    }
    scheduleConversationTitleSync();
    const titleEl = document.querySelector("title");
    if (titleEl) {
      new MutationObserver(() => scheduleConversationTitleSync())
        .observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  window.addEventListener("pagehide", () => {
    clearTimeout(enhanceTimer);
    clearTimeout(fiberScanTimer);
    mediaPanel.revoke();
  }, { once: true });

  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();

