import { freshData } from '../../core.js';

// Only this in-memory fixture receives requests. No real GitHub credentials or
// repository writes are involved, even though the app uses its normal API URL.
export function fakeGithub(today = '2026-10-19') {
  const initial = { ...freshData(), schema: 2, protocol: 2, cutoff: today, archives: {}, legacyHomes: {} };
  const files = new Map([['ledger.json', { sha: '1', data: initial }]]);
  const calls = [];
  let revision = 1, conflictOnce = false, preflights = 0;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version, Accept, Cache-Control, Pragma',
  };
  async function install(context, driver) {
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === 'http://127.0.0.1:4173') return route.continue();
      if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith('/repos/liziyaaa/dashi-shuttle-data')) return route.abort('blockedbyclient');
      if (request.method() === 'OPTIONS') { preflights++; return route.fulfill({ status: 204, headers }); }
      const path = decodeURIComponent(url.pathname.split('/contents/')[1] || '');
      const entry = { driver, method: request.method(), path, status: 200 }; calls.push(entry);
      if (!path && request.method() === 'GET') return route.fulfill({ headers, json: { private: true, default_branch: 'main', archived: false } });
      const file = files.get(path);
      if (request.method() === 'GET') {
        if (!file) { entry.status = 404; return route.fulfill({ headers, status: 404, json: {} }); }
        return route.fulfill({ headers, json: { sha: file.sha, content: Buffer.from(JSON.stringify(file.data)).toString('base64') } });
      }
      if (request.method() !== 'PUT' || !path) { entry.status = 405; return route.fulfill({ headers, status: 405, json: {} }); }
      const body = request.postDataJSON();
      if (conflictOnce || body.sha !== file?.sha) {
        conflictOnce = false; entry.status = 409;
        return route.fulfill({ headers, status: 409, json: { message: 'Simulated SHA conflict' } });
      }
      files.set(path, { sha: String(++revision), data: JSON.parse(Buffer.from(body.content, 'base64').toString()) });
      return route.fulfill({ headers, json: {} });
    });
  }
  return {
    install, files, calls,
    injectConflictOnce() { conflictOnce = true; },
    get ledger() { return files.get('ledger.json').data; },
    metrics() {
      return {
        apiRequests: calls.length, preflightRequests: preflights,
        repositoryChecks: calls.filter(row => !row.path).length,
        ledgerReads: calls.filter(row => row.method === 'GET' && row.path === 'ledger.json').length,
        writeAttempts: calls.filter(row => row.method === 'PUT').length,
        successfulWrites: calls.filter(row => row.method === 'PUT' && row.status === 200).length,
        shaConflicts: calls.filter(row => row.status === 409).length,
        ledgerBytes: Buffer.byteLength(JSON.stringify(files.get('ledger.json').data)),
      };
    },
  };
}
