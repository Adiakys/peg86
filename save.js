/*
 * peg86 save add-on.
 *
 * Persists progress with save_state()/restore_state(): the disk is a raw IDE
 * image (no 9p filesystem), so the per-file Peggle saves can't be touched — the
 * full machine snapshot is the only handle. Snapshots are gzipped into IndexedDB,
 * one slot per variant. Requires window.PEG86 = { emulator, stateFile, stateUrl }.
 */
(function () {
  "use strict";

  var emulator = window.PEG86.emulator;
  var stateFile = window.PEG86.stateFile; // also the IndexedDB slot key
  var stateUrl = window.PEG86.stateUrl;

  var STATUS = document.getElementById("status");
  var FFWD = document.getElementById("ffwd_btn");
  var isTouchDevice = window.matchMedia("(pointer: coarse)").matches;

  var spinner = document.createElement("span");
  spinner.className = "peg86-spin";

  function setStatus(text, busy) {
    STATUS.textContent = "";
    if (busy) STATUS.appendChild(spinner);
    STATUS.appendChild(document.createTextNode(text));
  }

  // Let the browser paint the spinner before save_state() ties up the thread.
  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
  }

  var DB_NAME = "peg86";
  var STORE = "saves";

  var saving = false;

  var hasCompression = typeof CompressionStream !== "undefined" &&
                       typeof DecompressionStream !== "undefined";

  async function gzip(arrayBuffer) {
    if (!hasCompression) return new Blob([arrayBuffer]);
    var cs = new CompressionStream("gzip");
    var stream = new Blob([arrayBuffer]).stream().pipeThrough(cs);
    return await new Response(stream).blob();
  }

  async function gunzip(blob) {
    if (!hasCompression) return await blob.arrayBuffer();
    var ds = new DecompressionStream("gzip");
    var stream = blob.stream().pipeThrough(ds);
    return await new Response(stream).arrayBuffer();
  }

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function idbGet(key) {
    var db = await openDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readonly");
      var req = tx.objectStore(STORE).get(key);
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function idbPut(key, blob) {
    var db = await openDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  async function idbDelete(key) {
    var db = await openDB();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  }

  emulator.add_listener("emulator-ready", async function () {
    try {
      var local = await idbGet(stateFile);
      var buf;
      if (local) {
        setStatus("Loading save...", true);
        buf = await gunzip(local);
      } else {
        setStatus("Loading state...", true);
        buf = await fetch(stateUrl).then(function (r) { return r.arrayBuffer(); });
      }
      await emulator.restore_state(buf);
      setStatus("Running.", false);
      if (isTouchDevice && FFWD) FFWD.style.display = "flex";
    } catch (e) {
      setStatus("State load failed: " + e.message, false);
      console.error(e);
    }
  });

  async function captureBlob() {
    var state = await emulator.save_state();
    return await gzip(state);
  }

  async function saveProgress() {
    if (saving) return;
    saving = true;
    var prev = STATUS.textContent;
    try {
      setStatus("Saving...", true);
      await nextFrame();
      var blob = await captureBlob();
      await idbPut(stateFile, blob);
      setStatus("Saved.", false);
      setTimeout(function () {
        if (STATUS.textContent === "Saved.") setStatus(prev, false);
      }, 1500);
    } catch (e) {
      if (e && e.name === "QuotaExceededError") {
        setStatus("Save failed: storage full — use Export instead.", false);
      } else {
        setStatus("Save failed: " + e.message, false);
      }
      console.error(e);
    } finally {
      saving = false;
    }
  }

  // visibilitychange fires while the page is still alive (tab switch / iOS
  // backgrounding), so the async save can complete; pagehide is best-effort.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) saveProgress();
  });
  window.addEventListener("pagehide", function () { saveProgress(); });

  async function exportSave() {
    try {
      setStatus("Exporting...", true);
      await nextFrame();
      var blob = await captureBlob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "peg86-" + stateFile + ".peg86";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus("Running.", false);
    } catch (e) {
      setStatus("Export failed: " + e.message, false);
      console.error(e);
    }
  }

  async function importSave(file) {
    try {
      setStatus("Importing...", true);
      await nextFrame();
      var buf = await gunzip(file);
      await emulator.restore_state(buf); // also validates the file before persisting
      await idbPut(stateFile, file);
      setStatus("Running.", false);
    } catch (e) {
      setStatus("Import failed: " + e.message, false);
      console.error(e);
    }
  }

  async function resetSave() {
    try {
      await idbDelete(stateFile);
    } catch (e) {
      console.error(e);
    }
    location.reload();
  }

  function button(label, handler) {
    var b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "background:#1a1a1a;border:1px solid #333;color:#ccc;font-family:monospace;" +
      "font-size:13px;padding:6px 12px;border-radius:4px;cursor:pointer;";
    b.addEventListener("click", handler);
    return b;
  }

  function injectUI() {
    var style = document.createElement("style");
    style.textContent =
      ".peg86-spin{display:inline-block;width:10px;height:10px;margin-right:6px;" +
      "border:2px solid #444;border-top-color:#ccc;border-radius:50%;vertical-align:-1px;" +
      "animation:peg86-spin .7s linear infinite}" +
      "@keyframes peg86-spin{to{transform:rotate(360deg)}}";
    document.head.appendChild(style);

    var bar = document.createElement("div");
    bar.id = "save_controls";
    bar.style.cssText = "margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;";

    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".peg86";
    fileInput.style.display = "none";
    fileInput.addEventListener("change", function () {
      if (fileInput.files && fileInput.files[0]) importSave(fileInput.files[0]);
      fileInput.value = "";
    });

    bar.appendChild(button("Save", saveProgress));
    bar.appendChild(button("Export", exportSave));
    bar.appendChild(button("Import", function () { fileInput.click(); }));
    bar.appendChild(button("Reset", resetSave));
    bar.appendChild(fileInput);

    var anchor = document.getElementById("buttons");
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(bar, anchor.nextSibling);
    } else {
      document.body.appendChild(bar);
    }
  }

  // Opt out of IndexedDB eviction (matters most on iOS Safari).
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(function () {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectUI);
  } else {
    injectUI();
  }
})();
