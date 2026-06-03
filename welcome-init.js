// Wire the welcome-modal dismiss button immediately so cold-start PWA taps
// register before app.js has parsed. app.js attaches its own handler on top —
// both are idempotent. Split out of an inline <script> so the CSP can drop
// 'unsafe-inline' for scripts.
(function () {
    var btn = document.getElementById("welcome-dismiss");
    var modal = document.getElementById("welcome-modal");
    if (!btn || !modal) return;
    function dismiss() {
        modal.classList.add("hidden");
        try { localStorage.setItem("lw:welcomed", "1"); } catch (e) {}
    }
    btn.addEventListener("click", dismiss);
    modal.addEventListener("click", function (e) {
        if (e.target === modal) dismiss();
    });
})();
