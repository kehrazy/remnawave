import { TResetPeriods, TUsersStatus } from '@libs/contracts/constants';
import { ConnectionProfile } from '@libs/contracts/models/subscription-info.schema';

export class SubscriptionRawResponse {
    public isFound: boolean;
    public user: {
        daysLeft: number;
        expiresAt: Date;
        isActive: boolean;
        shortUuid: string;
        trafficLimit: string;
        trafficUsed: string;
        lifetimeTrafficUsed: string;
        trafficLimitBytes: string;
        trafficUsedBytes: string;
        lifetimeTrafficUsedBytes: string;
        username: string;
        userStatus: TUsersStatus;
        trafficLimitStrategy: TResetPeriods;
    };
    public links: string[];
    public connectionProfiles: ConnectionProfile[];
    public ssConfLinks: Record<string, string>;
    public subscriptionUrl: string;
    public openVpnProfiles?: {
        uuid: string;
        name: string;
        protocol: 'udp' | 'tcp';
        controlChannel: 'none' | 'tls-auth' | 'tls-crypt' | 'tls-crypt-v2';
        url: string;
    }[];

    public amneziaWgProfiles?: { uuid: string; name: string; generation: string; url: string }[];

    constructor(
        data: Omit<SubscriptionRawResponse, 'connectionProfiles'> & {
            connectionProfiles?: ConnectionProfile[];
        },
    ) {
        this.isFound = data.isFound;
        this.user = data.user;
        this.links = data.links || [];
        this.connectionProfiles = data.connectionProfiles ?? [];
        this.ssConfLinks = data.ssConfLinks || {};
        this.subscriptionUrl = data.subscriptionUrl;
        this.openVpnProfiles = data.openVpnProfiles ?? [];
        this.amneziaWgProfiles = data.amneziaWgProfiles ?? [];
    }
}
