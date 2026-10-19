// A documented, configurable approximation, not GitHub's undisclosed abuse detector.
// Every driver uses the same simulated PAT owner; other-project traffic is steady.
export function createQuotaModel(config, now) {
  const started = now(); let reset = started + config.primaryResetSeconds * 1000;
  let windowStart = started, own = 0, initial = config.primaryUsed;
  const attempts = [], writes = [];
  const totals = { primaryLimitHits: 0, secondaryLimitHits: 0 };
  const background = (rate, span) => Math.floor(Math.max(0, now() - started) * rate / 3600000) - Math.floor(Math.max(0, now() - started - span) * rate / 3600000);
  function state() {
    if (now() >= reset) {
      const windows = Math.floor((now() - reset) / 3600000);
      windowStart = reset + windows * 3600000; reset = windowStart + 3600000; own = 0; initial = 0;
    }
    while (attempts[0]?.at <= now() - 60000) attempts.shift();
    while (writes[0] <= now() - 3600000) writes.shift();
    const others = Math.floor(Math.max(0, now() - windowStart) * config.otherRequestsPerHour / 3600000);
    const used = Math.min(config.primaryLimit, initial + own + others);
    return { enabled: config.githubLimits, limit: config.primaryLimit, used, remaining: Math.max(0, config.primaryLimit - used), resetAt: reset,
      otherProjectRequests: Math.floor(Math.max(0, now() - started) * config.otherRequestsPerHour / 3600000),
      contentLastMinute: writes.filter(at => at > now() - 60000).length + background(config.otherWritesPerHour, 60000),
      contentLastHour: writes.length + background(config.otherWritesPerHour, 3600000), ...totals };
  }
  function headers() {
    const quota = state(); return { 'x-ratelimit-limit': String(quota.limit), 'x-ratelimit-remaining': String(quota.remaining), 'x-ratelimit-used': String(quota.used), 'x-ratelimit-reset': String(Math.ceil(quota.resetAt / 1000)), 'x-ratelimit-resource': 'core' };
  }
  function admit(method, endpoint, concurrent = 1) {
    if (!config.githubLimits) return null;
    const quota = state();
    if (!quota.remaining) {
      totals.primaryLimitHits++;
      return { status: 403, reason: 'primary', message: 'API rate limit exceeded for simulated shared account', headers: headers() };
    }
    own++;
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method), points = mutating ? 5 : 1;
    const endpointPoints = attempts.filter(item => item.endpoint === endpoint).reduce((sum, item) => sum + item.points, 0);
    const tooMuch = concurrent > 100 || endpointPoints + points > 900 || (mutating && (quota.contentLastMinute >= config.contentPerMinute || quota.contentLastHour >= config.contentPerHour));
    attempts.push({ at: now(), endpoint, points });
    if (tooMuch) {
      totals.secondaryLimitHits++;
      return { status: 429, reason: 'secondary', message: 'Secondary rate limit exceeded for simulated shared account', headers: { ...headers(), 'Retry-After': '60' } };
    }
    // Count accepted mutating attempts conservatively, including conflicts.
    if (mutating) writes.push(now());
    return null;
  }
  return { admit, headers, state };
}
