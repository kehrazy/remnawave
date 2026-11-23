import { CACHE_KEYS } from '@contract/constants';

import { Injectable } from '@nestjs/common';

import { RawCacheService } from '@common/raw-cache';
import { NativeVpnService } from '@common/vpn/native-vpn.service';

import { INodeHotCache } from './interfaces';

@Injectable()
export class NodesSystemCacheService {
    constructor(
        private readonly rawCacheService: RawCacheService,
        private readonly nativeVpn: NativeVpnService,
    ) {}

    async getMany(nodes: { uuid: string }[]): Promise<Map<string, INodeHotCache>> {
        const pipe = this.rawCacheService.createPipeline();
        for (const node of nodes) {
            pipe.get(CACHE_KEYS.NODE_SYSTEM_INFO(node.uuid));
            pipe.get(CACHE_KEYS.NODE_SYSTEM_STATS(node.uuid));
            pipe.get(CACHE_KEYS.NODE_USERS_ONLINE(node.uuid));
            pipe.get(CACHE_KEYS.NODE_VERSIONS(node.uuid));
            pipe.get(CACHE_KEYS.NODE_XRAY_UPTIME(node.uuid));
        }

        const [results, native] = await Promise.all([
            pipe.exec(),
            this.nativeVpn.nodeStates(nodes.map((node) => node.uuid)),
        ]);
        const map = new Map<string, INodeHotCache>();

        const KEYS_PER_NODE = 5;

        if (!results) {
            for (const node of nodes) {
                map.set(node.uuid, {
                    system: null,
                    versions: null,
                    xrayUptime: 0,
                    onlineUsers: 0,
                    engines: native.get(node.uuid)?.engines ?? [],
                    totalOnlineUsers: native.get(node.uuid)?.usersOnline ?? 0,
                });
            }
            return map;
        }

        for (let i = 0; i < nodes.length; i++) {
            const base = i * KEYS_PER_NODE;
            const [infoErr, rawInfo] = results[base];
            const [statsErr, rawStats] = results[base + 1];
            const [onlineErr, rawOnline] = results[base + 2];
            const [versionsErr, rawVersions] = results[base + 3];
            const [uptimeErr, rawUptime] = results[base + 4];

            const system =
                !infoErr && !statsErr && rawInfo && rawStats
                    ? {
                          info: JSON.parse(rawInfo as string),
                          stats: JSON.parse(rawStats as string),
                      }
                    : null;

            const versions = !versionsErr && rawVersions ? JSON.parse(rawVersions as string) : null;
            const xrayUptime = !uptimeErr && rawUptime ? Number(rawUptime) : 0;
            const onlineUsers = !onlineErr && rawOnline ? Number(rawOnline) : 0;

            const extra = native.get(nodes[i].uuid);
            map.set(nodes[i].uuid, {
                system: system ?? extra?.agent?.system ?? null,
                versions:
                    versions ??
                    (extra?.agent
                        ? {
                              node: extra.agent.agent.version,
                              xray: extra.agent.xray?.xrayVersion ?? '',
                          }
                        : null),
                xrayUptime,
                onlineUsers,
                engines: extra?.engines ?? [],
                totalOnlineUsers: extra?.usersOnline ?? 0,
                agentConnected: extra?.agent?.connected,
            });
        }

        return map;
    }

    async getOne(uuid: string): Promise<INodeHotCache> {
        return (await this.getMany([{ uuid }])).get(uuid)!;
    }

    async delete(uuid: string): Promise<void> {
        await this.rawCacheService.delMany([
            CACHE_KEYS.NODE_SYSTEM_INFO(uuid),
            CACHE_KEYS.NODE_SYSTEM_STATS(uuid),
            CACHE_KEYS.NODE_USERS_ONLINE(uuid),
            CACHE_KEYS.NODE_VERSIONS(uuid),
            CACHE_KEYS.NODE_XRAY_UPTIME(uuid),
        ]);
    }

    async getTotalOnlineUsers(nodes: { uuid: string }[]): Promise<number> {
        const states = await this.nativeVpn.nodeStates(nodes.map((node) => node.uuid));
        return [...states.values()].reduce((total, state) => total + state.usersOnline, 0);
    }
}
