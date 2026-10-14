/* ============================================================
   VideoFlow — shared UI helpers (used by index.html and player.html)
   ============================================================ */
(function () {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  // Escape anything interpolated into innerHTML (file names, error messages, URLs)
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hr ago`;
    if (seconds < 86400 * 30) return `${Math.round(seconds / 86400)} d ago`;
    return formatDate(iso);
  }

  // 83.4 -> "1:23", 3725 -> "1:02:05"
  function formatDuration(totalSeconds) {
    if (!totalSeconds || totalSeconds < 0) return '0:00';
    const s = Math.round(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '';
    if (seconds < 60) return `${Math.ceil(seconds)}s left`;
    return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s left`;
  }

  // ─── Toasts ─────────────────────────────────────────────────
  function toast(message, type = 'info', duration = 4000) {
    let host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const icons = { success: '✓', error: '!', info: 'i' };
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'i'}</span><span>${esc(message)}</span>`;
    host.appendChild(el);
    const remove = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 250);
    };
    el.addEventListener('click', remove);
    setTimeout(remove, duration);
  }

  // ─── Confirm dialog (replaces window.confirm) ───────────────
  function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-msg">
          <h3 id="modal-title">${esc(title)}</h3>
          <p id="modal-msg">${esc(message)}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-act="cancel">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${esc(confirmText)}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const okBtn = overlay.querySelector('[data-act="ok"]');
      const cancelBtn = overlay.querySelector('[data-act="cancel"]');
      cancelBtn.focus();

      const close = (result) => {
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
        resolve(result);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); close(false); }
        if (e.key === 'Tab') { // keep focus inside the dialog
          e.preventDefault();
          (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
        }
      };
      document.addEventListener('keydown', onKey, true);
      okBtn.addEventListener('click', () => close(true));
      cancelBtn.addEventListener('click', () => close(false));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    });
  }

  // ─── Generic dialog (job details etc.) ──────────────────────
  function dialog({ title, html, wide = false }) {
    const previouslyFocused = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
        <div class="modal-body">${html}</div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
    overlay.querySelector('[data-close]').focus();
    return { el: overlay, close };
  }

  // Keyed list reconciliation: only rows whose HTML changed are replaced, so live progress
  // updates don't re-create thumbnails or restart animations on every event.
  function reconcile(container, items, { key, html }) {
    const existing = new Map([...container.children].filter((c) => c.__key !== undefined).map((c) => [c.__key, c]));
    const parent = document.createElement(container.tagName === 'TBODY' ? 'tbody' : 'div');
    const ordered = [];
    for (const item of items) {
      const k = key(item);
      const markup = html(item).trim();
      let el = existing.get(k);
      if (el && el.__sig === markup) {
        existing.delete(k);
      } else {
        parent.innerHTML = markup;
        const fresh = parent.firstElementChild;
        fresh.__key = k;
        fresh.__sig = markup;
        if (el) { el.replaceWith(fresh); existing.delete(k); }
        el = fresh;
      }
      ordered.push(el);
    }
    existing.forEach((el) => el.remove());
    ordered.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null); });
  }

  async function copyText(text, successMessage = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      toast(successMessage, 'success', 2000);
    } catch {
      toast('Could not copy. Copy it manually instead.', 'error');
    }
  }

  // The player library loads with `defer`, so it can arrive after the page script has started. Wait for it
  // (up to 4 s) instead of falling back to the browser's own HLS, which has no audio or quality menus.
  function whenHls() {
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => (window.Hls || Date.now() - started > 4000 ? resolve() : setTimeout(check, 40));
      check();
    });
  }

  window.VF = {
    esc, formatBytes, formatDate, timeAgo, formatDuration, formatEta,
    toast, confirmDialog, dialog, reconcile, copyText, whenHls,
  };
})();
