import type { NodeEngine } from '@libs/contracts/models/native-vpn.schema';

import { INodeSystem } from './node-host-info.interface';

export interface INodeVersions {
    xray: string;
    node: string;
}

export interface INodeHotCache {
    engines?: NodeEngine[];
    agentConnected?: boolean;
    totalOnlineUsers?: number;
    system: INodeSystem | null;
    versions: INodeVersions | null;
    xrayUptime: number;
    onlineUsers: number;
}
