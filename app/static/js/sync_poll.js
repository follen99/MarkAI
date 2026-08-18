(function () {
  const cfg = window.MARKAI;
  const POLL_INTERVAL_MS = 5000;

  async function pullStatus() {
    try {
      const res = await fetch(cfg.syncStatusUrl);
      if (!res.ok) return;
      const data = await res.json();
      if (data.changed && window.MarkAIApplyExternalNotes) {
        window.MarkAIApplyExternalNotes(data.notes);
      }
    } catch (e) {
      // network hiccup - just try again on the next tick
    }
  }

  if (cfg.hasSourceFolder) {
    setInterval(pullStatus, POLL_INTERVAL_MS);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("refresh-btn");
    if (btn) {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Refreshing…";
        await pullStatus();
        btn.disabled = false;
        btn.textContent = "Refresh";
      });
    }
  });
})();
