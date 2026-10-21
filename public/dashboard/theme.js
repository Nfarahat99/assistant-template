// Applied synchronously in <head> to avoid a theme flash. No inline script (CSP-friendly).
try { const t = localStorage.getItem('dash-theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t } catch (e) {}
