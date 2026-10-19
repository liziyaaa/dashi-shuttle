export const APP_VERSION = '1.3.3';
export function newerVersion(candidate, current = APP_VERSION) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate)) return false;
  const a = candidate.split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

export function startUpdates({ notify, canReload, onStatus }) {
  const banner = document.querySelector('#update-banner');
  let registration, availableVersion = '', dismissed = false, checking, applying = false;
  const show = () => {
    // A waiting worker may be the same release as this page (iOS can load the
    // new page before activating its worker). Only a newer version is an update.
    if (!newerVersion(availableVersion)) { banner.hidden = true; return; }
    banner.querySelector('[data-update-version]').textContent = `v${availableVersion}`;
    if (!dismissed) banner.hidden = false;
    onStatus('发现新版本，可立即更新');
  };
  const watch = worker => {
    if (!worker) return;
    worker.addEventListener('statechange', () => { if (worker.state === 'installed') check(); });
  };
  const ready = 'serviceWorker' in navigator ? navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
    registration = reg;
    reg.addEventListener('updatefound', () => watch(reg.installing));
    watch(reg.installing);
    if (reg.waiting) show();
    return reg;
  }).catch(() => null) : Promise.resolve(null);
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (applying) location.reload();
    // Never reload a form because another tab accepted an update.
  });
  async function check(manual = false) {
    if (checking) return checking;
    if (!navigator.onLine) { onStatus('当前离线，联网后自动检查'); if (manual) notify('当前离线，仍可继续记账'); return; }
    if (manual) dismissed = false;
    onStatus('正在检查更新…');
    checking = (async () => {
      try {
        await ready;
        const response = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('版本检查失败');
        const release = await response.json();
        availableVersion = newerVersion(release.version) ? release.version : '';
        show();
        await registration?.update().catch(() => {});
        if (!availableVersion) { onStatus(`当前已是最新版本 v${APP_VERSION}`); if (manual) notify('当前已是最新版本'); }
      } catch { onStatus('暂时无法检查更新，稍后重试'); if (manual) notify('暂时无法检查更新，请稍后重试'); }
      finally { checking = null; }
    })();
    return checking;
  }
  banner.querySelector('[data-update-later]').addEventListener('click', () => { banner.hidden = true; dismissed = true; });
  banner.querySelector('[data-update-now]').addEventListener('click', async () => {
    if (!canReload()) return notify('请先保存或关闭正在填写的表单，再更新');
    if (applying) return;
    await ready;
    if (registration && !registration.waiting) {
      await check(true);
      if (!registration.waiting) return notify('新版本正在准备，请稍后再点更新');
    }
    if (!availableVersion) return;
    if (registration?.waiting) {
      const worker = registration.waiting;
      const workerVersion = await new Promise(resolve => {
        const channel = new MessageChannel();
        const finish = version => { clearTimeout(timeout); channel.port1.close(); resolve(version); };
        const timeout = setTimeout(() => finish(null), 1500);
        channel.port1.onmessage = event => finish(event.data?.version);
        worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
      });
      if (worker !== registration.waiting || workerVersion !== availableVersion) {
        return notify('新版本正在准备，请稍后再点更新');
      }
    }
    if (!canReload()) return notify('请先保存或关闭正在填写的表单，再更新');
    applying = true;
    if (registration?.waiting) {
      banner.querySelector('[data-update-now]').disabled = true;
      banner.querySelector('[data-update-now]').textContent = '正在更新…';
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    } else location.reload();
  });
  window.addEventListener('online', () => check());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { dismissed = false; check(); } });
  check();
  return { check };
}
