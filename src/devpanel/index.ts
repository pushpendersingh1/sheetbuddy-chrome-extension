// Dev Panel popup — primitive testing harness (built in issue #16)
document.addEventListener('DOMContentLoaded', () => {
  const status = document.getElementById('status');
  if (status) status.textContent = 'Dev Panel ready — primitives coming in issue #16';
  console.log('[SheetBuddy] Dev Panel ready');
});
