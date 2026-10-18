import { freshData, mergeData, validateData } from './core.js?v=1.2.1';
export const DATA_REPO = 'liziyaaa/dashi-shuttle-data';
const FILE = 'ledger.json';
export function encodeData(data) { const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2)); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
export function decodeData(content) { return validateData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(content.replace(/\s/g, '')), c => c.charCodeAt(0))))); }
export function validateConnection(config) {
  const repo = config?.repo || DATA_REPO;
  const token = (config?.token || '').trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^github_pat_[A-Za-z0-9_]+$/.test(token)) throw new Error('请粘贴管理员提供的完整连接密钥（github_pat_ 开头）');
  return { repo, token };
}
export async function synchronize(config, getCurrent, accept, signal) {
  config = validateConnection(config);
  const url = `https://api.github.com/repos/${config.repo}/contents/${FILE}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const request = async (method, body, endpoint = url) => {
    const response = await fetch(endpoint, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal });
    if (!response.ok) {
      if (method === 'PUT' && response.status === 409) return { conflict: true };
      if (method === 'PUT' && response.status === 422) {
        const detail = await response.json().catch(() => ({}));
        if (/sha|already exists/i.test(detail.message || '')) return { conflict: true };
        throw new Error('云端拒绝保存记录（422），请联系管理员检查数据仓库');
      }
      if (response.status === 401) throw new Error('连接密钥无效或已过期，请重新设置');
      if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) throw new Error('同步请求过于频繁，请稍后重试，记录已保留在本机');
      if (response.status === 403) throw new Error('连接密钥权限不足，请联系管理员为数据仓库开启 Contents 读写权限');
      if (response.status === 404) throw new Error(endpoint === url ? '无法读取云端台账（ledger.json），请联系管理员检查文件及密钥的 Contents 读取权限' : '连接密钥无法访问私有数据仓库，请联系管理员授权 liziyaaa/dashi-shuttle-data');
      throw new Error(`同步未完成（${response.status}），记录已保留在本机`);
    }
    return response.json();
  };
  const repository = await request('GET', undefined, `https://api.github.com/repos/${config.repo}`);
  if (repository.private !== true) throw new Error('只允许同步到私有仓库，已停止上传，避免公开乘客信息');
  if (repository.default_branch !== 'main' || repository.archived) throw new Error('数据仓库必须可写，且默认分支为 main');
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await request('GET');
    if (remote.conflict || typeof remote.content !== 'string' || !remote.sha) throw new Error('云端数据文件无法读取');
    const cloud = decodeData(remote.content);
    const merged = mergeData(cloud, getCurrent());
    accept(merged);
    if (JSON.stringify(mergeData(freshData(), cloud)) === JSON.stringify(mergeData(freshData(), merged))) return;
    const result = await request('PUT', { message: 'Sync shuttle ledger', content: encodeData(merged), sha: remote.sha, branch: 'main' });
    if (!result.conflict) return;
  }
  throw new Error('其他司机正在更新，请稍后重试；本机记录已保留');
}
