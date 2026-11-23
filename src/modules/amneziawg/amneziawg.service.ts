import type { Nodes, AmneziaWgEndpoint, Prisma } from '@prisma/client';

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

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
    CreateAmneziaWgEndpointSchema,
    AmneziaWgUsageSchema,
    type AmneziaWgEndpointInput,
    type AmneziaWgProfile,
} from './amneziawg.schemas';

type Endpoint = AmneziaWgEndpoint & { node: Nodes };
type Account = Prisma.UsersGetPayload<{
    include: { traffic: true; activeInternalSquads: true; externalSquad: true };
}>;

@Injectable()
export class AmneziaWgService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(AmneziaWgService.name);
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
            this.logger.error(`AmneziaWG reconciliation failed: ${String(error)}`),
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
            path: `/node/amneziawg${path}`,
            method: data === undefined ? 'get' : 'post',
            data,
            timeout,
            logAxiosError: false,
        });
        if (!result.isOk)
            throw new BadGatewayException('AmneziaWG node request failed; inspect node health');
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
            (!target || target.relayTargetUuid)
        ) {
            throw new BadRequestException(
                'A relay must target an AmneziaWG server using the same transport',
            );
        }
        return {
            uuid: endpoint.uuid,
            name: endpoint.name,
            address: endpoint.address,
            port: endpoint.port,
            generation: endpoint.generation,
            preset: endpoint.preset,
            parameters: endpoint.parameters,
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
        const endpoints = await this.prisma.amneziaWgEndpoint.findMany({
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

    async create(input: AmneziaWgEndpointInput) {
        return this.managedVpn.withConfigurationLock(async () => {
            const data = CreateAmneziaWgEndpointSchema.parse(input);
            if (data.relayTargetUuid && data.internalSquadUuids.length)
                throw new BadRequestException('Relays inherit the exit server internal squads');

            const node = await this.prisma.nodes.findUnique({ where: { uuid: data.nodeUuid } });
            if (!node) throw new NotFoundException('Node not found');
            const endpoints = await this.prisma.amneziaWgEndpoint.findMany({
                include: { node: true },
            });
            if (data.relayTargetUuid) {
                const target = endpoints.find((endpoint) => endpoint.uuid === data.relayTargetUuid);
                if (
                    !target ||
                    target.relayTargetUuid ||
                    target.nodeUuid === data.nodeUuid
                ) {
                    throw new BadRequestException(
                        'Relay target must be a server on another node with the same transport',
                    );
                }
                data.generation = target.generation as '3.1' | '2.0';
                data.preset = target.preset as 'default' | 'mobile';
                data.parameters = {};
            }
            await this.checkAllocation(data);
            const endpoint = {
                ...data,
                uuid: randomUUID(),
                createdAt: new Date(),
                updatedAt: new Date(),
                node,
            };
            await this.nodeRequest(node, '/endpoints', this.wireEndpoint(endpoint, endpoints));
            let saved: AmneziaWgEndpoint;
            try {
                saved = await this.prisma.amneziaWgEndpoint.create({
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

    async update(uuid: string, patch: Partial<AmneziaWgEndpointInput>) {
        return this.managedVpn.withConfigurationLock(async () => {
            const current = await this.prisma.amneziaWgEndpoint.findUnique({
                where: { uuid },
                include: { node: true },
            });
            if (!current) throw new NotFoundException('AmneziaWG endpoint not found');
            const data = CreateAmneziaWgEndpointSchema.parse({ ...current, ...patch });
            if (data.relayTargetUuid && data.internalSquadUuids.length)
                throw new BadRequestException('Relays inherit the exit server internal squads');

            if (
                data.nodeUuid !== current.nodeUuid ||
                data.generation !== current.generation || data.preset !== current.preset ||
                !isDeepStrictEqual(data.parameters, current.parameters) || data.network !== current.network ||
                data.relayTargetUuid !== current.relayTargetUuid
            ) {
                throw new BadRequestException(
                    'Create another endpoint to change its node or credential source',
                );
            }
            await this.checkAllocation(data, uuid);
            const endpoints = await this.prisma.amneziaWgEndpoint.findMany({
                include: { node: true },
            });
            const next = { ...current, ...data };
            await this.nodeRequest(current.node, '/endpoints', this.wireEndpoint(next, endpoints));
            let saved: AmneziaWgEndpoint;
            try {
                saved = await this.prisma.amneziaWgEndpoint.update({ where: { uuid }, data });
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
            const endpoint = await this.prisma.amneziaWgEndpoint.findUnique({
                where: { uuid },
                include: { node: true },
            });
            if (!endpoint) throw new NotFoundException('AmneziaWG endpoint not found');
            if (await this.prisma.amneziaWgEndpoint.count({ where: { relayTargetUuid: uuid } })) {
                throw new BadRequestException('Remove the relays using this server first');
            }
            await this.nodeRequest(endpoint.node, `/endpoints/${uuid}/remove`, {});
            await this.prisma.amneziaWgEndpoint.delete({ where: { uuid } });
            this.health.delete(uuid);
        });
    }

    private async checkAllocation(data: AmneziaWgEndpointInput, uuid?: string): Promise<void> {
        const [awg, ovpn] = await Promise.all([
            this.prisma.amneziaWgEndpoint.findMany({ where: { nodeUuid: data.nodeUuid, ...(uuid ? { uuid: { not: uuid } } : {}) } }),
            this.prisma.openVpnEndpoint.findMany({ where: { nodeUuid: data.nodeUuid } }),
        ]);
        if (awg.some((other) => other.port === data.port || (!data.relayTargetUuid && !other.relayTargetUuid && other.network === data.network)) ||
            ovpn.some((other) => (other.protocol === 'udp' && other.port === data.port) || (!data.relayTargetUuid && !other.relayTargetUuid && other.network === data.network)))
            throw new BadRequestException('VPN port or tunnel subnet is already assigned on this node');
    }

    async devices(shortUuid: string) {
        if (!(await this.profiles(shortUuid)).length) throw new NotFoundException('AmneziaWG unavailable');
        const user = await this.prisma.users.findUniqueOrThrow({ where: { shortUuid } });
        const devices = await this.prisma.amneziaWgDevice.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
        return [{ uuid: 'default', name: 'Default' }, ...devices.map((device) => ({ uuid: device.uuid, name: device.name }))];
    }

    async addDevice(shortUuid: string, name: string) {
        const device = await this.managedVpn.withConfigurationLock(async () => {
            await this.devices(shortUuid);
            const user = await this.prisma.users.findUniqueOrThrow({ where: { shortUuid } });
            if (await this.prisma.amneziaWgDevice.count({ where: { userId: user.id } }) >= 4)
                throw new BadRequestException('At most five AmneziaWG devices per account');
            if (await this.prisma.amneziaWgDevice.findFirst({ where: { userId: user.id, name } }))
                throw new BadRequestException('This device name is already used');
            return this.prisma.amneziaWgDevice.create({ data: { userId: user.id, name } });
        });
        await this.sync();
        return { uuid: device.uuid, name: device.name };
    }

    async removeDevice(shortUuid: string, uuid: string): Promise<void> {
        await this.managedVpn.withConfigurationLock(async () => {
            const user = await this.prisma.users.findUnique({ where: { shortUuid } });
            if (!user) throw new NotFoundException('Account not found');
            const device = await this.prisma.amneziaWgDevice.findFirst({ where: { uuid, userId: user.id } });
            if (!device) throw new NotFoundException('Device not found');
            await this.prisma.amneziaWgDevice.delete({ where: { uuid } });
        });
        await this.sync();
    }

    async profiles(shortUuid: string): Promise<AmneziaWgProfile[]> {
        const user = await this.prisma.users.findUnique({
            where: { shortUuid },
            include: { traffic: true, activeInternalSquads: true, externalSquad: true },
        });
        const settings = await this.prisma.subscriptionSettings.findFirst({
            select: { hwidSettings: true },
        });
        const hwid = Boolean((settings?.hwidSettings as { enabled?: boolean } | null)?.enabled);
        if (!user || !this.managedVpn.accountAllowed(user, hwid)) return [];
        const endpoints = await this.prisma.amneziaWgEndpoint.findMany({
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
                generation: endpoint.generation,
                url: `/api/amneziawg/subscriptions/${encodeURIComponent(shortUuid)}/${endpoint.uuid}.conf`,
            }));
    }

    async profile(shortUuid: string, uuid: string, deviceUuid = 'default'): Promise<string> {
        const allowed = await this.profiles(shortUuid);
        if (!(await this.devices(shortUuid)).some((device) => device.uuid === deviceUuid))
            throw new NotFoundException('Device not found');
        if (!allowed.some((profile) => profile.uuid === uuid))
            throw new NotFoundException('AmneziaWG profile unavailable');
        const endpoint = await this.prisma.amneziaWgEndpoint.findUniqueOrThrow({
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
                deviceUuid,
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
                const endpoints = await this.prisma.amneziaWgEndpoint.findMany({
                    include: { node: true },
                });
                const accounts = await this.prisma.users.findMany({
                    include: { traffic: true, activeInternalSquads: true, externalSquad: true, amneziaWgDevices: true },
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
                                    throw new Error('AmneziaWG is disabled on this node');
                                return;
                            }
                            const users = accounts
                                .map((user) => ({
                                    id: user.id.toString(),
                                    credentialId: user.vlessUuid,
                                    expiresAt: user.expireAt.toISOString(),
                                    devices: [{ uuid: 'default', name: 'Default' }, ...user.amneziaWgDevices.map((device) => ({ uuid: device.uuid, name: device.name }))],
                                    endpointUuids: local
                                        .filter((endpoint) => this.managedVpn.accountAllowed(user, hwid) && this.endpointAllowed(endpoint, user))
                                        .map((endpoint) => endpoint.uuid),
                                }));
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
                                'amneziawg', node,
                                AmneziaWgUsageSchema.parse(await this.nodeRequest(node, '/usage')),
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
