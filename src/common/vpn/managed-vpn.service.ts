import type { Nodes, Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@common/database/prisma.service';

export type ManagedVpnAccount = Prisma.UsersGetPayload<{
    include: { traffic: true; activeInternalSquads: true; externalSquad: true };
}>;
export type ManagedVpnUsage = {
    epoch: string;
    users: { id: string; uplink: number; downlink: number; online: boolean }[];
};

type CounterKey = { nodeUuid: string; userId: bigint };
type CounterValues = { epoch: string; uplink: bigint; downlink: bigint };
interface UsageCounters {
    findUnique(args: { where: { nodeUuid_userId: CounterKey } }): Promise<CounterValues | null>;
    upsert(args: {
        where: { nodeUuid_userId: CounterKey };
        create: CounterKey & CounterValues;
        update: CounterValues;
    }): Promise<unknown>;
}

@Injectable()
export class ManagedVpnService {
    private configuring: Promise<unknown> = Promise.resolve();
    constructor(private readonly prisma: PrismaService) {}

    withConfigurationLock<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.configuring.then(() =>
            this.prisma.$transaction(
                async (tx) => {
                    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('remnawave:vpn:configuration'))`;
                    // The transaction owns the lock while node RPCs and independently committed writes complete.
                    return operation();
                },
                { timeout: 120_000, maxWait: 10_000 },
            ),
        );
        this.configuring = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    accountAllowed(user: ManagedVpnAccount, hwidEnabled: boolean): boolean {
        const hwidOverride = user.externalSquad?.hwidSettings as
            | { enabled?: boolean }
            | null
            | undefined;
        return (
            user.status === 'ACTIVE' &&
            user.expireAt.getTime() > Date.now() &&
            !(hwidOverride?.enabled ?? hwidEnabled) &&
            (user.trafficLimitBytes === 0n ||
                (user.traffic?.usedTrafficBytes ?? 0n) < user.trafficLimitBytes)
        );
    }

    nodeAvailable(node: Nodes): boolean {
        return (
            !node.isDisabled &&
            (!node.isTrafficTrackingActive ||
                !node.trafficLimitBytes ||
                (node.trafficUsedBytes ?? 0n) < node.trafficLimitBytes)
        );
    }

    async accountUsage(
        protocol: 'openvpn' | 'amneziawg',
        node: Nodes,
        usage: ManagedVpnUsage,
    ): Promise<void> {
        await this.prisma.$transaction(
            async (tx) => {
                await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`managed-vpn-usage:${node.uuid}`}))`;
                const counters: UsageCounters = protocol === 'openvpn' ? tx.openVpnUserUsage : tx.amneziaWgUserUsage;
                const now = new Date();
                const day = new Date(now.toISOString().slice(0, 10));
                const hour = new Date(now);
                hour.setUTCMinutes(0, 0, 0);
                for (const entry of [...usage.users].sort((left, right) => BigInt(left.id) < BigInt(right.id) ? -1 : BigInt(left.id) > BigInt(right.id) ? 1 : 0)) {
                    const userId = BigInt(entry.id);
                    const user = await tx.users.findUnique({
                        where: { id: userId },
                        include: { traffic: true },
                    });
                    if (!user) continue;
                    const key = { nodeUuid: node.uuid, userId };
                    const previous = await counters.findUnique({
                        where: { nodeUuid_userId: key },
                    });
                    const uplink = BigInt(entry.uplink);
                    const downlink = BigInt(entry.downlink);
                    const sameEpoch = previous?.epoch === usage.epoch;
                    if (
                        sameEpoch &&
                        previous &&
                        (uplink < previous.uplink || downlink < previous.downlink)
                    ) {
                        throw new Error(
                            'Managed VPN cumulative counters decreased without an epoch change',
                        );
                    }
                    const up = uplink - (sameEpoch ? previous!.uplink : 0n);
                    const down = downlink - (sameEpoch ? previous!.downlink : 0n);
                    const total = up + down;
                    await counters.upsert({
                        where: { nodeUuid_userId: key },
                        create: { ...key, epoch: usage.epoch, uplink, downlink },
                        update: { epoch: usage.epoch, uplink, downlink },
                    });
                    if (total === 0n && !entry.online) continue;
                    const charged = (total * node.consumptionMultiplier) / 1_000_000_000n;
                    await tx.userTraffic.upsert({
                        where: { id: userId },
                        create: {
                            id: userId,
                            usedTrafficBytes: charged,
                            lifetimeUsedTrafficBytes: charged,
                            onlineAt: now,
                            firstConnectedAt: now,
                            lastConnectedNodeUuid: node.uuid,
                        },
                        update: {
                            usedTrafficBytes: { increment: charged },
                            lifetimeUsedTrafficBytes: { increment: charged },
                            onlineAt: now,
                            firstConnectedAt: user.traffic?.firstConnectedAt ?? now,
                            lastConnectedNodeUuid: node.uuid,
                        },
                    });
                    await tx.nodesUserUsageHistory.upsert({
                        where: {
                            nodeId_createdAt_userId: { nodeId: node.id, createdAt: day, userId },
                        },
                        create: { nodeId: node.id, createdAt: day, userId, totalBytes: total },
                        update: { totalBytes: { increment: total } },
                    });
                    await tx.nodesUsageHistory.upsert({
                        where: { nodeUuid_createdAt: { nodeUuid: node.uuid, createdAt: hour } },
                        create: {
                            nodeUuid: node.uuid,
                            createdAt: hour,
                            uploadBytes: up,
                            downloadBytes: down,
                            totalBytes: total,
                        },
                        update: {
                            uploadBytes: { increment: up },
                            downloadBytes: { increment: down },
                            totalBytes: { increment: total },
                        },
                    });
                    await tx.nodes.update({
                        where: { uuid: node.uuid },
                        data: {
                            trafficUsedBytes: {
                                increment:
                                    (total * node.nodeConsumptionMultiplier) / 1_000_000_000n,
                            },
                        },
                    });
                }
            },
            { timeout: 30_000 },
        );
    }
}
