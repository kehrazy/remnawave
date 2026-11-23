import { fromNanoToNumber } from '@common/utils/nano';
import { TNodeIps } from '@libs/contracts/models';
import type { NodeEngine } from '@libs/contracts/models/native-vpn.schema';

import { ConfigProfileInboundEntity } from '@modules/config-profiles/entities';
import { InfraProviderEntity } from '@modules/infra-billing/entities';

import { NodesEntity } from '../entities';
import { INodeHotCache, INodeSystem, INodeVersions } from '../interfaces';

export class NodeResponseModel {
    public engines: NodeEngine[];
    public uuid: string;
    public id: number;
    public name: string;
    public address: string;
    public port: null | number;
    public proxyUrl: string | null;
    public isConnected: boolean;
    public isConnecting: boolean;
    public isDisabled: boolean;
    public lastStatusChange: Date | null;
    public lastStatusMessage: null | string;
    public trafficResetDay: null | number;
    public consumptionMultiplier: number;
    public nodeConsumptionMultiplier: number;
    public isTrafficTrackingActive: boolean;
    public trafficLimitBytes: null | number;
    public trafficUsedBytes: null | number;
    public notifyPercent: null | number;
    public note: null | string;
    public viewPosition: number;
    public countryCode: string;
    public tags: string[];
    public integrationUuids: string[];
    public ips: TNodeIps;
    public createdAt: Date;
    public updatedAt: Date;

    public configProfile: {
        activeConfigProfileUuid: string | null;
        activeInbounds: ConfigProfileInboundEntity[];
    };
    public providerUuid: string | null;
    public provider: InfraProviderEntity | null;
    public activePluginUuid: string | null;

    public xrayUptime: number;
    public usersOnline: number;
    public system: INodeSystem | null;
    public versions: INodeVersions | null;

    constructor(data: NodesEntity, hotCache: INodeHotCache) {
        this.uuid = data.uuid;
        this.id = Number(data.id);
        this.name = data.name;
        this.address = data.address;
        this.port = data.port;
        this.proxyUrl = data.proxyUrl;
        this.isConnected = data.isConnected;
        this.isConnecting = data.isConnecting;
        this.isDisabled = data.isDisabled;
        this.lastStatusChange = data.lastStatusChange;
        this.lastStatusMessage = data.lastStatusMessage;
        this.isTrafficTrackingActive = data.isTrafficTrackingActive;
        this.trafficResetDay = data.trafficResetDay;
        this.trafficLimitBytes = Number(data.trafficLimitBytes);
        this.trafficUsedBytes = Number(data.trafficUsedBytes);
        this.notifyPercent = data.notifyPercent;
        this.note = data.note;
        this.consumptionMultiplier = fromNanoToNumber(data.consumptionMultiplier);
        this.nodeConsumptionMultiplier = fromNanoToNumber(data.nodeConsumptionMultiplier);
        this.tags = data.tags;
        this.integrationUuids = data.integrationUuids;
        this.ips = data.ips;
        this.createdAt = data.createdAt;
        this.updatedAt = data.updatedAt;

        this.viewPosition = data.viewPosition;
        this.countryCode = data.countryCode;

        this.configProfile = {
            activeConfigProfileUuid: data.activeConfigProfileUuid,
            activeInbounds: data.activeInbounds,
        };

        this.providerUuid = data.providerUuid;
        this.provider = data.provider;
        this.activePluginUuid = data.activePluginUuid;

        this.system = hotCache.system;
        this.usersOnline = hotCache.totalOnlineUsers ?? hotCache.onlineUsers;
        this.versions = hotCache.versions;
        this.xrayUptime = hotCache.xrayUptime;
        this.engines = [...(hotCache.engines ?? [])];
        if (data.activeConfigProfileUuid)
            this.engines.unshift({
                type: 'xray',
                version: hotCache.versions?.xray ?? null,
                enabled: !data.isDisabled,
                running: data.xrayConnected && hotCache.xrayUptime > 0,
                uptime: hotCache.xrayUptime,
                usersOnline: hotCache.onlineUsers,
                profiles: [
                    {
                        uuid: data.activeConfigProfileUuid,
                        name: data.activeConfigProfileName ?? 'Xray',
                        inbounds: data.activeInbounds.map((inbound) => ({
                            uuid: inbound.uuid,
                            runtimeUuid: inbound.uuid,
                            tag: inbound.tag,
                            port: inbound.port,
                            transport: inbound.network,
                            mode: 'server',
                            assigned: true,
                            enabled: !data.isDisabled,
                            running: data.xrayConnected && hotCache.xrayUptime > 0,
                            error: data.xrayLastStatusMessage,
                            peers: 0,
                            hosts: [],
                        })),
                    },
                ],
            });
        if (hotCache.agentConnected !== undefined) {
            this.isConnected = !data.isDisabled && hotCache.agentConnected;
            if (this.isConnected) this.isConnecting = false;
        } else if (!data.activeConfigProfileUuid && !data.isDisabled) {
            this.isConnected = this.engines.some((engine) => engine.running);
            this.isConnecting = !this.isConnected && data.isConnecting;
        }
    }
}
