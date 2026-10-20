import { JsonRpcClient } from './adapters/rpc.mjs';
import { resolveCli, subscriptionEnv } from './adapters/process.mjs';
import { CODEX_SERVER_ARGS } from './adapters/codex.mjs';
import { setTimeout as delay } from 'node:timers/promises';

export async function readComposerCatalog({ cwd, executable }, { Rpc = JsonRpcClient, resolve = resolveCli, wait = delay } = {}) {
  const cli = resolve('codex', { explicitPath: executable });
  if (!cli) throw new Error('未找到官方 Codex。');
  const rpc = new Rpc(cli, CODEX_SERVER_ARGS, { cwd, env: subscriptionEnv('codex') });
  rpc.on('request', message => rpc.reject(message.id, 'Read-only catalog'));
  try {
    await rpc.request('initialize', { clientInfo: { name: 'shared_workspace_catalog', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    const result = { skills: [], plugins: [], apps: [], errors: [] };
    // The first skills read initializes this CLI version's discovery cache;
    // even forceReload on that first read can omit installed plugin skills.
    // Refresh only after the initial read and plugin discovery have completed.
    const reads = await Promise.allSettled([
      rpc.request('skills/list', { cwds: [cwd] }),
      rpc.request('plugin/installed', { cwds: [cwd] }),
      rpc.request('app/installed', { forceRefresh: false }),
    ]);
    // Remote plugins are hydrated asynchronously. Check their declared skills
    // against the discovered list rather than assuming a fixed count is complete.
    const remotePlugins = reads[1].status === 'fulfilled' ? (reads[1].value.marketplaces || []).flatMap(market =>
      (market.plugins || []).filter(plugin => plugin.installed && plugin.enabled && plugin.source?.type === 'remote'
        // App-SDK entries use the app directory; plugin/read has no detail
        // endpoint for these synthetic IDs. skills/list remains authoritative.
        && !plugin.remotePluginId?.startsWith('plugin_asdk_app_')).map(plugin => ({ plugin, market }))) : [];
    const details = await Promise.allSettled(remotePlugins.map(({ plugin, market }) => rpc.request('plugin/read', {
      pluginName: plugin.name, ...(market.path ? { marketplacePath: market.path } : { remoteMarketplaceName: market.name }),
    })));
    const expected = [];
    details.forEach((entry, index) => {
      const { plugin } = remotePlugins[index];
      if (entry.status === 'rejected') result.errors.push(`${plugin.name} 技能清单核对失败：${entry.reason.message}`);
      else for (const skill of entry.value.plugin?.skills || []) if (skill.enabled) expected.push(`${plugin.name}:${skill.name}`);
    });
    for (const pause of [0, 500, 1500, 3000]) {
      if (pause) await wait(pause);
      [reads[0]] = await Promise.allSettled([rpc.request('skills/list', { cwds: [cwd], forceReload: true })]);
      if (reads[0].status !== 'fulfilled') break;
      // Disabled skills count as discovered; they are filtered before display.
      const found = new Set((reads[0].value.data || []).flatMap(entry => entry.skills || []).map(skill => skill.name));
      if (expected.every(name => found.has(name))) break;
      if (pause === 3000) result.errors.push(`部分插件技能仍在加载，请稍后重新打开目录：${[...new Set(expected.filter(name => !found.has(name)).map(name => name.split(':')[0]))].join('、')}`);
    }
    reads.forEach((entry, index) => { if (entry.status === 'rejected') result.errors.push(`${['技能', '插件', '应用'][index]}目录读取失败：${entry.reason.message}`); });
    if (reads[0].status === 'fulfilled') {
      const entries = reads[0].value.data || [];
      result.skills = entries.flatMap(entry => entry.skills || []).filter(item => item.enabled).map(item => ({ name: item.name, path: item.path, description: item.shortDescription || item.description, pluginId: item.pluginId }));
      for (const entry of entries) for (const error of entry.errors || []) result.errors.push(`技能读取失败：${error.message || error}`);
    }
    if (reads[1].status === 'fulfilled') result.plugins = (reads[1].value.marketplaces || []).flatMap(entry => entry.plugins || []).filter(item => item.installed).map(item => ({ id: item.id, name: item.interface?.displayName || item.name, enabled: item.enabled }));
    if (reads[2].status === 'fulfilled') result.apps = (reads[2].value.apps || []).filter(item => item.callable && item.enabled).map(item => ({ id: item.id, name: item.runtimeName || item.id }));
    return result;
  } finally { await rpc.close(); }
}
