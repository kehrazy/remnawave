import type { Nodes, OpenVpnEndpoint, Prisma } from '@prisma/client';

import { randomUUID } from 'node:crypto';

import {
    BadGatewayException,
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
    OnApplicationBootstrap,
    OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AxiosService, type INodeConnectionOpts } from '@common/axios';
import { PrismaService } from '@common/database/prisma.service';
import { ManagedVpnService } from '@common/vpn/managed-vpn.service';

import {
    CreateOpenVpnEndpointSchema,
    OpenVpnUsageSchema,
    type OpenVpnEndpointInput,
    type OpenVpnProfile,
} from './openvpn.schemas';

type Endpoint = OpenVpnEndpoint & { node: Nodes };
type Account = Prisma.UsersGetPayload<{
    include: { traffic: true; activeInternalSquads: true; externalSquad: true };
}>;

@Injectable()
export class OpenVpnService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(OpenVpnService.name);
    private readonly health = new Map<string, { running: boolean; error: string | null }>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private reconciling: Promise<void> | null = null;
    private resyncRequested = false;
    private nodeReady: Promise<void> | null = null;

    constructor(
        private readonly prisma: PrismaService,
        private readonly axios: AxiosService,
        private readonly managedVpn: ManagedVpnService,
    ) {}

    onApplicationBootstrap(): void {
        this.timer = setInterval(() => {
            if (!this.reconciling) this.onChanged();
        }, 15_000);
        this.timer.unref();
        this.onChanged();
    }

    onModuleDestroy(): void {
        clearInterval(this.timer);
    }

    @OnEvent('user.*')
    @OnEvent('node.*')
    onChanged(): void {
        void this.sync().catch((error: unknown) =>
            this.logger.error(`OpenVPN reconciliation failed: ${String(error)}`),
        );
    }

    private async nodeRequest<T>(
        node: INodeConnectionOpts,
        path: string,
        data?: unknown,
        timeout = 30_000,
    ): Promise<T> {
        this.nodeReady ??= this.axios.setJwt().catch((error: unknown) => {
            this.nodeReady = null;
            throw error;
        });
        await this.nodeReady;
        const result = await this.axios.request<{ response: T }>({
            label: 'OPENVPN',
            opts: node,
            path: `/node/openvpn${path}`,
            method: data === undefined ? 'get' : 'post',
            data,
            timeout,
            logAxiosError: false,
        });
        if (!result.isOk)
            throw new BadGatewayException('OpenVPN node request failed; inspect node health');
        return result.response;
    }

    private endpointAllowed(endpoint: Endpoint, user: Account): boolean {
        return (
            !endpoint.isDisabled &&
            this.managedVpn.nodeAvailable(endpoint.node) &&
            (endpoint.internalSquadUuids.length === 0 ||
                user.activeInternalSquads.some((member) =>
                    endpoint.internalSquadUuids.includes(member.internalSquadUuid),
                ))
        );
    }

    private wireEndpoint(endpoint: Endpoint, endpoints: Endpoint[]) {
        const target = endpoint.relayTargetUuid
            ? endpoints.find((item) => item.uuid === endpoint.relayTargetUuid)
            : null;
        if (
            endpoint.relayTargetUuid &&
            (!target || target.relayTargetUuid || target.protocol !== endpoint.protocol)
        ) {
            throw new BadRequestException(
                'A relay must target an OpenVPN server using the same transport',
            );
        }
        return {
            uuid: endpoint.uuid,
            name: endpoint.name,
            address: endpoint.address,
            port: endpoint.port,
            protocol: endpoint.protocol,
            controlChannel: endpoint.controlChannel,
            udpMask: endpoint.udpMask,
            network: endpoint.network,
            dnsServers: endpoint.dnsServers,
            egressAddress: endpoint.egressAddress,
            mode: target ? 'relay' : 'server',
            targetAddress: target?.address ?? null,
            targetPort: target?.port ?? null,
            isDisabled:
                endpoint.isDisabled ||
                !this.managedVpn.nodeAvailable(endpoint.node) ||
                Boolean(target && (target.isDisabled || !this.managedVpn.nodeAvailable(target.node))),
        };
    }

    async list() {
        const endpoints = await this.prisma.openVpnEndpoint.findMany({
            include: { node: { select: { uuid: true, name: true } } },
            orderBy: { createdAt: 'asc' },
        });
        return endpoints.map((endpoint) => ({
            ...endpoint,
            health: this.health.get(endpoint.uuid) ?? {
                running: false,
                error: 'Not reconciled yet',
            },
        }));
    }

    async create(input: OpenVpnEndpointInput) {
        return this.managedVpn.withConfigurationLock(async () => {
            const data = CreateOpenVpnEndpointSchema.parse(input);
            if (data.relayTargetUuid && data.internalSquadUuids.length)
                throw new BadRequestException('Relays inherit the exit server internal squads');
            if (data.udpMask !== 'none' && (data.protocol !== 'udp' || data.relayTargetUuid))
                throw new BadRequestException('UDP masking requires a UDP server endpoint');
            const node = await this.prisma.nodes.findUnique({ where: { uuid: data.nodeUuid } });
            if (!node) throw new NotFoundException('Node not found');
            const endpoints = await this.prisma.openVpnEndpoint.findMany({
                include: { node: true },
            });
            if (data.relayTargetUuid) {
                const target = endpoints.find((endpoint) => endpoint.uuid === data.relayTargetUuid);
                if (
                    !target ||
                    target.relayTargetUuid ||
                    target.nodeUuid === data.nodeUuid ||
                    target.protocol !== data.protocol
                ) {
                    throw new BadRequestException(
                        'Relay target must be a server on another node with the same transport',
                    );
                }
                data.controlChannel =
                    target.controlChannel as OpenVpnEndpointInput['controlChannel'];
            }
            const endpoint = {
                ...data,
                uuid: randomUUID(),
                createdAt: new Date(),
                updatedAt: new Date(),
                node,
            };
            await this.nodeRequest(node, '/endpoints', this.wireEndpoint(endpoint, endpoints));
            let saved: OpenVpnEndpoint;
            try {
                saved = await this.prisma.openVpnEndpoint.create({
                    data: { ...data, uuid: endpoint.uuid },
                });
            } catch (error) {
                await this.nodeRequest(node, `/endpoints/${endpoint.uuid}/remove`, {}).catch(
                    () => undefined,
                );
                throw error;
            }
            this.onChanged();
            return saved;
        });
    }

    async update(uuid: string, patch: Partial<OpenVpnEndpointInput>) {
        return this.managedVpn.withConfigurationLock(async () => {
            const current = await this.prisma.openVpnEndpoint.findUnique({
                where: { uuid },
                include: { node: true },
            });
            if (!current) throw new NotFoundException('OpenVPN endpoint not found');
            const data = CreateOpenVpnEndpointSchema.parse({ ...current, ...patch });
            if (data.relayTargetUuid && data.internalSquadUuids.length)
                throw new BadRequestException('Relays inherit the exit server internal squads');
            if (data.udpMask !== 'none' && (data.protocol !== 'udp' || data.relayTargetUuid))
                throw new BadRequestException('UDP masking requires a UDP server endpoint');
            if (
                data.nodeUuid !== current.nodeUuid ||
                data.controlChannel !== current.controlChannel ||
                data.relayTargetUuid !== current.relayTargetUuid
            ) {
                throw new BadRequestException(
                    'Create another endpoint to change its node or credential source',
                );
            }
            if (
                data.protocol !== current.protocol &&
                (await this.prisma.openVpnEndpoint.count({ where: { relayTargetUuid: uuid } }))
            ) {
                throw new BadRequestException(
                    'Update or remove relays before changing server transport',
                );
            }
            const endpoints = await this.prisma.openVpnEndpoint.findMany({
                include: { node: true },
            });
            const next = { ...current, ...data };
            await this.nodeRequest(current.node, '/endpoints', this.wireEndpoint(next, endpoints));
            let saved: OpenVpnEndpoint;
            try {
                saved = await this.prisma.openVpnEndpoint.update({ where: { uuid }, data });
            } catch (error) {
                await this.nodeRequest(
                    current.node,
                    '/endpoints',
                    this.wireEndpoint(current, endpoints),
                ).catch(() => undefined);
                throw error;
            }
            this.onChanged();
            return saved;
        });
    }

    async remove(uuid: string): Promise<void> {
        return this.managedVpn.withConfigurationLock(async () => {
            const endpoint = await this.prisma.openVpnEndpoint.findUnique({
                where: { uuid },
                include: { node: true },
            });
            if (!endpoint) throw new NotFoundException('OpenVPN endpoint not found');
            if (await this.prisma.openVpnEndpoint.count({ where: { relayTargetUuid: uuid } })) {
                throw new BadRequestException('Remove the relays using this server first');
            }
            await this.nodeRequest(endpoint.node, `/endpoints/${uuid}/remove`, {});
            await this.prisma.openVpnEndpoint.delete({ where: { uuid } });
            this.health.delete(uuid);
        });
    }

    async profiles(shortUuid: string): Promise<OpenVpnProfile[]> {
        const user = await this.prisma.users.findUnique({
            where: { shortUuid },
            include: { traffic: true, activeInternalSquads: true, externalSquad: true },
        });
        const settings = await this.prisma.subscriptionSettings.findFirst({
            select: { hwidSettings: true },
        });
        const hwid = Boolean((settings?.hwidSettings as { enabled?: boolean } | null)?.enabled);
        if (!user || !this.managedVpn.accountAllowed(user, hwid)) return [];
        const endpoints = await this.prisma.openVpnEndpoint.findMany({
            include: { node: true },
            orderBy: { createdAt: 'asc' },
        });
        return endpoints
            .filter((endpoint) => {
                if (!this.endpointAllowed(endpoint, user)) return false;
                const target = endpoint.relayTargetUuid
                    ? endpoints.find((item) => item.uuid === endpoint.relayTargetUuid)
                    : null;
                return (
                    !endpoint.relayTargetUuid ||
                    Boolean(target && this.endpointAllowed(target, user))
                );
            })
            .map((endpoint) => ({
                uuid: endpoint.uuid,
                name: endpoint.name,
                protocol: endpoint.protocol as 'udp' | 'tcp',
                controlChannel: endpoint.controlChannel as OpenVpnProfile['controlChannel'],
                url: `/api/openvpn/subscriptions/${encodeURIComponent(shortUuid)}/${endpoint.uuid}.ovpn`,
            }));
    }

    async profile(shortUuid: string, uuid: string): Promise<string> {
        const allowed = await this.profiles(shortUuid);
        if (!allowed.some((profile) => profile.uuid === uuid))
            throw new NotFoundException('OpenVPN profile unavailable');
        const endpoint = await this.prisma.openVpnEndpoint.findUniqueOrThrow({
            where: { uuid },
            include: { node: true, relayTarget: { include: { node: true } } },
        });
        const user = await this.prisma.users.findUniqueOrThrow({ where: { shortUuid } });
        await this.sync();
        const server = endpoint.relayTarget ?? endpoint;
        const result = await this.nodeRequest<{ profile: string }>(
            server.node,
            `/endpoints/${server.uuid}/profile`,
            {
                userId: user.id.toString(),
                address: endpoint.address,
                port: endpoint.port,
            },
        );
        return result.profile;
    }

    sync(): Promise<void> {
        this.resyncRequested = true;
        this.reconciling ??= this.reconcile().finally(() => {
            this.reconciling = null;
        });
        return this.reconciling;
    }

    private async reconcile(): Promise<void> {
        for (let pass = 0; pass < 2; pass++) {
            this.resyncRequested = false;
            await this.managedVpn.withConfigurationLock(async () => {
                const generation = Date.now();
                const endpoints = await this.prisma.openVpnEndpoint.findMany({
                    include: { node: true },
                });
                const accounts = await this.prisma.users.findMany({
                    include: { traffic: true, activeInternalSquads: true, externalSquad: true },
                });
                const settings = await this.prisma.subscriptionSettings.findFirst({
                    select: { hwidSettings: true },
                });
                const hwid = Boolean(
                    (settings?.hwidSettings as { enabled?: boolean } | null)?.enabled,
                );
                const nodes = await this.prisma.nodes.findMany();
                await Promise.all(
                    nodes.map(async (node) => {
                        const local = endpoints.filter(
                            (endpoint) => endpoint.nodeUuid === node.uuid,
                        );
                        try {
                            const state = await this.nodeRequest<{
                                enabled: boolean;
                                endpoints: { uuid: string }[];
                            }>(node, '', undefined, 5000);
                            if (!state.enabled) {
                                if (local.length)
                                    throw new Error('OpenVPN is disabled on this node');
                                return;
                            }
                            const users = accounts
                                .filter((user) => this.managedVpn.accountAllowed(user, hwid))
                                .map((user) => ({
                                    id: user.id.toString(),
                                    credentialId: user.vlessUuid,
                                    expiresAt: user.expireAt.toISOString(),
                                    endpointUuids: local
                                        .filter((endpoint) => this.endpointAllowed(endpoint, user))
                                        .map((endpoint) => endpoint.uuid),
                                }))
                                .filter((user) => user.endpointUuids.length > 0);
                            await this.nodeRequest(node, '/users', { generation, users });
                            for (const orphan of state.endpoints) {
                                if (!local.some((endpoint) => endpoint.uuid === orphan.uuid))
                                    await this.nodeRequest(
                                        node,
                                        `/endpoints/${orphan.uuid}/remove`,
                                        {},
                                    );
                            }
                            for (const endpoint of local) {
                                const status = await this.nodeRequest<{
                                    endpoints: {
                                        uuid: string;
                                        running: boolean;
                                        error: string | null;
                                    }[];
                                }>(node, '/endpoints', this.wireEndpoint(endpoint, endpoints));
                                for (const entry of status.endpoints)
                                    this.health.set(entry.uuid, {
                                        running: entry.running,
                                        error: entry.error,
                                    });
                            }
                            await this.managedVpn.accountUsage(
                                'openvpn', node,
                                OpenVpnUsageSchema.parse(await this.nodeRequest(node, '/usage')),
                            );
                        } catch (error) {
                            for (const endpoint of local)
                                this.health.set(endpoint.uuid, {
                                    running: false,
                                    error:
                                        error instanceof Error ? error.message : 'Node unavailable',
                                });
                        }
                    }),
                );
            });
            if (!this.resyncRequested) return;
        }
        setImmediate(() => this.onChanged());
    }


}
