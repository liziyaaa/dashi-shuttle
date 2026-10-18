import { freshData, mergeData, validateData } from './core.js';
const FILE = 'ledger.json';
export function encodeData(data) { const bytes = new TextEncoder().encode(JSON.stringify(data, null, 2)); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
export function decodeData(content) { return validateData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(content.replace(/\s/g, '')), c => c.charCodeAt(0))))); }
export function validateConnection(config) {
  if (!config || !/^[\w.-]+\/[\w.-]+$/.test(config.repo) || !/^github_pat_[A-Za-z0-9_]+$/.test(config.token || '')) throw new Error('请填写 owner/仓库名 和 github_pat_ 开头的细粒度令牌，不接受广泛权限令牌');
  return { repo: config.repo, token: config.token };
}
export async function synchronize(config, getCurrent, accept, signal) {
  validateConnection(config);
  const url = `https://api.github.com/repos/${config.repo}/contents/${FILE}`;
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${config.token}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const request = async (method, body, endpoint = url) => {
    const response = await fetch(endpoint, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal });
    if (!response.ok) {
      if (response.status === 409 || response.status === 422) return { conflict: true };
      if (response.status === 401) throw new Error('连接密钥无效或已过期，请重新设置');
      if (response.status === 403) throw new Error('无写入权限或请求过于频繁，请检查密钥权限');
      if (response.status === 404) throw new Error('无法读取私有数据仓库，请检查仓库名及密钥的访问范围');
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
