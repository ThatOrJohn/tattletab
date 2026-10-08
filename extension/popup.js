chrome.runtime.sendMessage("status", s => {
  const dot = document.getElementById("dot");
  const state = document.getElementById("state");
  if (!s || s.ok === null) { state.textContent = "No traffic forwarded yet"; }
  else if (s.ok) { dot.classList.add("ok"); state.textContent = "Daemon reachable"; }
  else { dot.classList.add("bad"); state.textContent = "Daemon not running"; }
  if (s) document.getElementById("counts").textContent = `${s.sent} sent · ${s.dropped} dropped`;
});
