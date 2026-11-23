import type { Prisma } from '@prisma/client';

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
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';

import { AxiosService, type INodeConnectionOpts } from '@common/axios';
import { PrismaService } from '@common/database/prisma.service';
import { EVENTS } from '@libs/contracts/constants';
import {
    NativeVpnEngineSchema,
    parseNativeVpnConfig,
    type NativeVpnEngine,
    type NativeVpnInbound,
    type NodeEngine,
} from '@libs/contracts/models/native-vpn.schema';

import { NodeEvent } from '@integration-modules/notifications/interfaces';

import { HostsRepository } from '@modules/hosts/repositories/hosts.repository';
import { NodesEntity } from '@modules/nodes/entities/nodes.entity';
import type { INodeSystem } from '@modules/nodes/interfaces/node-host-info.interface';

import { ManagedVpnService } from './managed-vpn.service';
import { ManagedVpnUsageSchema } from './usage.schema';

const bindingRelations = {
    node: true,
    configProfileInbounds: {
        include: {
            profile: true,
            internalSquadInbounds: true,
            hosts: { include: { nodes: true, internalSquads: true } },
        },
    },
} as const;
type Binding = Prisma.ConfigProfileInboundsToNodesGetPayload<{
    include: typeof bindingRelations;
}> & { definition: NativeVpnInbound };
type ServerBinding = Omit<Binding, 'definition'> & {
    definition: Extract<NativeVpnInbound, { mode: 'server' }>;
};
type Account = Prisma.UsersGetPayload<{
    include: {
        traffic: true;
        activeInternalSquads: true;
        externalSquad: true;
        amneziaWgDevices: true;
    };
}>;
type Route = {
    host: Binding['configProfileInbounds']['hosts'][number];
    binding: Binding;
    server: ServerBinding;
};
type AgentRuntime = {
    agent: { version: string; uptime: number };
    system: INodeSystem | null;
    xray: { xrayVersion: string | null } | null;
    engines: Record<NativeVpnEngine, RuntimeStatus>;
};
type RuntimeStatus = {
    enabled: boolean;
    error?: string | null;
    version?: string | null;
    endpoints: {
        uuid: string;
        running: boolean;
        error: string | null;
        peers?: number;
        uptime?: number;
        protocol?: string;
    }[];
};

@Injectable()
export class NativeVpnService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(NativeVpnService.name);
    private readonly states = new Map<string, NodeEngine[]>();
    private readonly agents = new Map<string, AgentRuntime & { connected: boolean }>();
    private timer: ReturnType<typeof setInterval> | undefined;
    private reconciling: Promise<void> | null = null;
    private requested = false;
    private revision = 0;
    private appliedRevision = 0;
    private nodeReady: Promise<void> | null = null;

    constructor(
        private readonly prisma: PrismaService,
        private readonly axios: AxiosService,
        private readonly policy: ManagedVpnService,
        private readonly hosts: HostsRepository,
        private readonly events: EventEmitter2,
    ) {}

    onApplicationBootstrap(): void {
        this.timer = setInterval(() => this.changed(), 15_000);
        this.timer.unref();
        this.changed();
    }

    onModuleDestroy(): void {
        clearInterval(this.timer);
    }

    @OnEvent('user.*')
    @OnEvent('node.*')
    @OnEvent('host.*')
    @OnEvent('internal-squad.*')
    changed(): void {
        void this.sync().catch((error: unknown) => this.logger.error(String(error)));
    }

    private async request<T>(
        node: INodeConnectionOpts,
        engine: NativeVpnEngine | 'runtime',
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
            label: engine.toUpperCase(),
            opts: node,
            path: '/node/' + engine + path,
            method: data === undefined ? 'get' : 'post',
            data,
            timeout,
            logAxiosError: false,
        });
        if (!result.isOk) throw new BadGatewayException('VPN agent request failed');
        return result.response;
    }

    private async bindings(): Promise<Binding[]> {
        const rows = await this.prisma.configProfileInboundsToNodes.findMany({
            where: {
                configProfileInbounds: { profile: { engine: { in: ['openvpn', 'amneziawg'] } } },
            },
            include: bindingRelations,
        });
        return rows.map((row) => ({
            ...row,
            definition: parseNativeVpnConfig(
                NativeVpnEngineSchema.parse(row.configProfileInbounds.profile.engine),
                { inbounds: [row.configProfileInbounds.rawInbound] },
            ).inbounds[0],
        }));
    }

    private inboundAllowed(binding: Binding, user: Account): boolean {
        return (
            !binding.isDisabled &&
            this.policy.nodeAvailable(binding.node) &&
            binding.configProfileInbounds.internalSquadInbounds.some((access) =>
                user.activeInternalSquads.some(
                    (member) => member.internalSquadUuid === access.internalSquadUuid,
                ),
            )
        );
    }

    private server(binding: Binding, bindings: Binding[]): ServerBinding {
        if (binding.definition.mode === 'server') return binding as ServerBinding;
        const targetUuid = binding.definition.relayTargetUuid;
        const candidates = bindings.filter((entry) =>
            entry.configProfileInbounds.hosts.some(
                (host) =>
                    host.uuid === targetUuid &&
                    host.nodes.some((node) => node.nodeUuid === entry.nodeUuid),
            ),
        );
        const target = candidates.length === 1 ? candidates[0] : null;
        if (
            !target ||
            target.definition.mode !== 'server' ||
            target.definition.type !== binding.definition.type ||
            target.nodeUuid === binding.nodeUuid
        ) {
            throw new BadRequestException(
                'Relay target must be a server of the same engine on another node',
            );
        }
        return target as ServerBinding;
    }

    private wire(binding: Binding, bindings: Binding[]) {
        const definition = binding.definition;
        const target = this.server(binding, bindings);
        const targetHost =
            definition.mode === 'relay'
                ? target.configProfileInbounds.hosts.find(
                      (host) => host.uuid === definition.relayTargetUuid,
                  )
                : undefined;
        const native = definition.mode === 'server' ? definition : target.definition;
        return {
            ...native,
            mode: definition.mode,
            port: definition.port,
            uuid: binding.runtimeUuid,
            name:
                binding.configProfileInbounds.hosts.find((host) =>
                    host.nodes.some((entry) => entry.nodeUuid === binding.nodeUuid),
                )?.remark ?? binding.configProfileInbounds.tag,
            address:
                binding.configProfileInbounds.hosts.find((host) =>
                    host.nodes.some((entry) => entry.nodeUuid === binding.nodeUuid),
                )?.address ?? binding.node.address,
            ...(native.type === 'openvpn'
                ? {
                      protocol: native.transport,
                      udpMask: definition.mode === 'relay' ? 'none' : native.udpMask,
                  }
                : {}),
            targetAddress: targetHost?.address ?? null,
            targetPort: targetHost?.port ?? null,
            isDisabled:
                binding.isDisabled ||
                !this.policy.nodeAvailable(binding.node) ||
                target.isDisabled ||
                !this.policy.nodeAvailable(target.node),
        };
    }

    private async account(shortUuid: string): Promise<Account | null> {
        const [user, settings] = await Promise.all([
            this.prisma.users.findUnique({
                where: { shortUuid },
                include: {
                    traffic: true,
                    activeInternalSquads: true,
                    externalSquad: true,
                    amneziaWgDevices: true,
                },
            }),
            this.prisma.subscriptionSettings.findFirst({ select: { hwidSettings: true } }),
        ]);
        const hwid = Boolean((settings?.hwidSettings as { enabled?: boolean } | null)?.enabled);
        return user && this.policy.accountAllowed(user, hwid) ? user : null;
    }

    private async routes(
        engine: NativeVpnEngine,
        shortUuid: string,
    ): Promise<{ user: Account | null; routes: Route[] }> {
        const user = await this.account(shortUuid);
        if (!user) return { user, routes: [] };
        const [bindings, accessible] = await Promise.all([
            this.bindings(),
            this.hosts.findActiveHostsByUserId(user.id),
        ]);
        const allowed = new Set(accessible.map((host) => host.uuid));
        const routes: Route[] = [];
        for (const binding of bindings) {
            if (binding.definition.type !== engine || !this.inboundAllowed(binding, user)) continue;
            let server: ServerBinding;
            try {
                server = this.server(binding, bindings);
            } catch {
                continue;
            }
            if (!this.inboundAllowed(server, user)) continue;
            for (const host of binding.configProfileInbounds.hosts) {
                if (
                    host.isDisabled ||
                    host.isHidden ||
                    !host.nodes.some((node) => node.nodeUuid === binding.nodeUuid)
                )
                    continue;
                if (!allowed.has(host.uuid)) continue;
                routes.push({ host, binding, server });
            }
        }
        return {
            user,
            routes: routes.sort((left, right) => left.host.viewPosition - right.host.viewPosition),
        };
    }

    async profiles(engine: NativeVpnEngine, shortUuid: string) {
        const { routes } = await this.routes(engine, shortUuid);
        return routes.map(({ host, server }) => ({
            uuid: host.uuid,
            name: host.remark,
            protocol:
                server.definition.type === 'openvpn'
                    ? server.definition.transport
                    : ('udp' as const),
            controlChannel:
                server.definition.type === 'openvpn' ? server.definition.controlChannel : undefined,
            generation:
                server.definition.type === 'amneziawg' ? server.definition.generation : undefined,
            url:
                '/api/' +
                engine +
                '/subscriptions/' +
                encodeURIComponent(shortUuid) +
                '/' +
                host.uuid +
                (engine === 'openvpn' ? '.ovpn' : '.conf'),
        }));
    }

    async profile(
        engine: NativeVpnEngine,
        shortUuid: string,
        hostUuid: string,
        deviceUuid = 'default',
    ): Promise<string> {
        const { user, routes } = await this.routes(engine, shortUuid);
        const route = routes.find((entry) => entry.host.uuid === hostUuid);
        if (!user || !route) throw new NotFoundException('VPN profile unavailable');
        if (
            engine === 'amneziawg' &&
            deviceUuid !== 'default' &&
            !user.amneziaWgDevices.some((device) => device.uuid === deviceUuid)
        )
            throw new NotFoundException('Device not found');
        await this.sync();
        const result = await this.request<{ profile: string }>(
            route.server.node,
            engine,
            '/endpoints/' + route.server.runtimeUuid + '/profile',
            {
                userId: user.id.toString(),
                address: route.host.address,
                port: route.host.port,
                ...(engine === 'amneziawg' ? { deviceUuid } : {}),
            },
        );
        return result.profile;
    }

    async devices(shortUuid: string) {
        const user = await this.account(shortUuid);
        if (!user) throw new NotFoundException('Account unavailable');
        return [
            { uuid: 'default', name: 'Default' },
            ...user.amneziaWgDevices.map((device) => ({ uuid: device.uuid, name: device.name })),
        ];
    }

    async addDevice(shortUuid: string, name: string) {
        const device = await this.policy.withConfigurationLock(async () => {
            const user = await this.account(shortUuid);
            if (!user) throw new NotFoundException('Account unavailable');
            if (user.amneziaWgDevices.length >= 4)
                throw new BadRequestException('This account already has five devices');
            if (user.amneziaWgDevices.some((device) => device.name === name))
                throw new BadRequestException('Device name already exists');
            return this.prisma.amneziaWgDevice.create({
                data: { userId: user.id, name },
                select: { uuid: true, name: true },
            });
        });
        await this.sync();
        return device;
    }

    async removeDevice(shortUuid: string, uuid: string): Promise<void> {
        await this.policy.withConfigurationLock(async () => {
            const user = await this.account(shortUuid);
            if (!user || !user.amneziaWgDevices.some((device) => device.uuid === uuid))
                throw new NotFoundException('Device not found');
            await this.prisma.amneziaWgDevice.delete({ where: { uuid } });
        });
        await this.sync();
    }

    private async validateAllocation(bindings: Binding[]): Promise<void> {
        const sockets = new Set<string>();
        const networks = new Set<string>();
        const xray = await this.prisma.configProfileInboundsToNodes.findMany({
            where: { isDisabled: false, configProfileInbounds: { profile: { engine: 'xray' } } },
            include: { configProfileInbounds: true },
        });
        for (const binding of xray) {
            const inbound = binding.configProfileInbounds;
            const transport = ['quic', 'kcp', 'hysteria', 'hysteria2'].includes(
                inbound.network ?? '',
            )
                ? 'udp'
                : 'tcp';
            if (inbound.port) sockets.add(binding.nodeUuid + ':' + transport + ':' + inbound.port);
        }
        for (const binding of bindings.filter((entry) => !entry.isDisabled)) {
            const server = this.server(binding, bindings);
            const transport =
                server.definition.type === 'openvpn' ? server.definition.transport : 'udp';
            const socket = binding.nodeUuid + ':' + transport + ':' + binding.definition.port;
            if (sockets.has(socket))
                throw new BadRequestException(
                    'Another listener already uses this node, transport and port',
                );
            sockets.add(socket);
            if (binding.definition.mode === 'server') {
                const network = binding.nodeUuid + ':' + binding.definition.network;
                if (networks.has(network))
                    throw new BadRequestException('VPN server pools on one node must be distinct');
                networks.add(network);
            }
        }
    }

    async validateProfile(
        uuid: string | null,
        config: { inbounds: NativeVpnInbound[] },
    ): Promise<void> {
        const conflictingTag = await this.prisma.configProfileInbounds.findFirst({
            where: {
                tag: { in: config.inbounds.map((inbound) => inbound.tag) },
                ...(uuid ? { profileUuid: { not: uuid } } : {}),
            },
        });
        if (conflictingTag)
            throw new BadRequestException('Listener tags must be unique across all profiles');
        const bindings = await this.bindings();
        for (const inbound of config.inbounds) {
            if (inbound.mode !== 'relay') continue;
            const target = bindings.filter((binding) =>
                binding.configProfileInbounds.hosts.some(
                    (host) =>
                        host.uuid === inbound.relayTargetUuid &&
                        host.nodes.some((node) => node.nodeUuid === binding.nodeUuid),
                ),
            );
            if (
                target.length !== 1 ||
                target[0].definition.mode !== 'server' ||
                target[0].definition.type !== inbound.type
            )
                throw new BadRequestException(
                    'Choose a server Host of the same engine as the relay exit',
                );
        }
        const next: Binding[] = [];
        for (const binding of bindings) {
            if (binding.configProfileInbounds.profileUuid !== uuid) {
                next.push(binding);
                continue;
            }
            const definition = config.inbounds.find(
                (inbound) => inbound.tag === binding.definition.tag,
            );
            if (!definition) {
                const hosts = binding.configProfileInbounds.hosts.map((host) => host.uuid);
                if (
                    bindings.some(
                        (entry) =>
                            entry.configProfileInbounds.profileUuid !== uuid &&
                            entry.definition.mode === 'relay' &&
                            hosts.includes(entry.definition.relayTargetUuid),
                    )
                )
                    throw new BadRequestException(
                        'A relay uses this listener; change its target before removing the server',
                    );
                continue;
            }
            if (definition.mode !== binding.definition.mode)
                throw new BadRequestException('Create another listener to change its role');
            if (definition.mode === 'server') {
                for (const field of [
                    'network',
                    'controlChannel',
                    'generation',
                    'preset',
                    'parameters',
                ] as const) {
                    if (
                        !isDeepStrictEqual(
                            binding.definition[field as keyof typeof binding.definition],
                            definition[field as keyof typeof definition],
                        )
                    )
                        throw new BadRequestException(
                            'Create another listener to change its pool or cryptographic identity',
                        );
                }
            }
            next.push({ ...binding, definition });
        }
        await this.validateAllocation(next);
    }

    async validateAssignment(nodeUuid: string, inboundUuids: string[]) {
        const node = await this.prisma.nodes.findUnique({ where: { uuid: nodeUuid } });
        if (!node) throw new NotFoundException('Node not found');
        const inbounds = await this.prisma.configProfileInbounds.findMany({
            where: {
                uuid: { in: inboundUuids },
                profile: { engine: { in: ['openvpn', 'amneziawg'] } },
            },
            include: bindingRelations.configProfileInbounds.include,
        });
        if (new Set(inboundUuids).size !== inbounds.length)
            throw new BadRequestException('Select existing native VPN listeners');
        const current = await this.bindings();
        const next = current
            .filter(
                (binding) =>
                    binding.nodeUuid !== nodeUuid ||
                    !inboundUuids.includes(binding.configProfileInboundUuid),
            )
            .map((binding) =>
                binding.nodeUuid === nodeUuid ? { ...binding, isDisabled: true } : binding,
            );
        for (const inbound of inbounds)
            next.push({
                node,
                nodeUuid,
                configProfileInboundUuid: inbound.uuid,
                configProfileInbounds: inbound,
                runtimeUuid:
                    current.find(
                        (binding) =>
                            binding.nodeUuid === nodeUuid &&
                            binding.configProfileInboundUuid === inbound.uuid,
                    )?.runtimeUuid ?? randomUUID(),
                isDisabled: false,
                definition: parseNativeVpnConfig(
                    NativeVpnEngineSchema.parse(inbound.profile.engine),
                    { inbounds: [inbound.rawInbound] },
                ).inbounds[0],
            });
        await this.validateAllocation(next);
        return inbounds;
    }

    async assignInbounds(nodeUuid: string, inboundUuids: string[]): Promise<void> {
        await this.policy.withConfigurationLock(async () => {
            const inbounds = await this.validateAssignment(nodeUuid, inboundUuids);
            await this.prisma.$transaction(async (tx) => {
                await tx.configProfileInboundsToNodes.updateMany({
                    where: {
                        nodeUuid,
                        configProfileInbounds: {
                            profile: { engine: { in: ['openvpn', 'amneziawg'] } },
                        },
                    },
                    data: { isDisabled: true },
                });
                for (const inbound of inbounds)
                    await tx.configProfileInboundsToNodes.upsert({
                        where: {
                            configProfileInboundUuid_nodeUuid: {
                                configProfileInboundUuid: inbound.uuid,
                                nodeUuid,
                            },
                        },
                        create: {
                            configProfileInboundUuid: inbound.uuid,
                            nodeUuid,
                            runtimeUuid: randomUUID(),
                        },
                        update: { isDisabled: false },
                    });
            });
        });
        await this.sync();
    }

    async restart(nodeUuid: string, engine?: NativeVpnEngine): Promise<void> {
        const node = await this.prisma.nodes.findUnique({ where: { uuid: nodeUuid } });
        if (!node) throw new NotFoundException('Node not found');
        for (const type of engine ? [engine] : (['openvpn', 'amneziawg'] as const)) {
            if (
                !this.states
                    .get(nodeUuid)
                    ?.some((state) => state.type === type && state.profiles.length)
            )
                continue;
            await this.request(node, 'runtime', '/' + type + '/restart', {});
        }
        await this.sync();
    }

    async nodeStates(nodeUuids: string[]) {
        const counts = await this.prisma.userTraffic.groupBy({
            by: ['lastConnectedNodeUuid'],
            where: {
                lastConnectedNodeUuid: { in: nodeUuids },
                onlineAt: { gt: new Date(Date.now() - 90_000) },
                user: { status: 'ACTIVE', expireAt: { gt: new Date() } },
            },
            _count: { id: true },
        });
        return new Map(
            nodeUuids.map((uuid) => [
                uuid,
                {
                    engines: this.states.get(uuid) ?? [],
                    agent: this.agents.get(uuid),
                    usersOnline:
                        counts.find((count) => count.lastConnectedNodeUuid === uuid)?._count.id ??
                        0,
                },
            ]),
        );
    }

    sync(): Promise<void> {
        const revision = ++this.revision;
        this.requested = true;
        this.reconciling ??= this.reconcile().finally(() => {
            this.reconciling = null;
        });
        return this.reconciling.then(() =>
            this.appliedRevision >= revision ? undefined : this.sync(),
        );
    }

    private async reconcile(): Promise<void> {
        for (let pass = 0; pass < 2; pass++) {
            this.requested = false;
            const revision = this.revision;
            await this.policy.withConfigurationLock(async () => {
                const [bindings, nodes, users, settings] = await Promise.all([
                    this.bindings(),
                    this.prisma.nodes.findMany(),
                    this.prisma.users.findMany({
                        include: {
                            traffic: true,
                            activeInternalSquads: true,
                            externalSquad: true,
                            amneziaWgDevices: true,
                        },
                    }),
                    this.prisma.subscriptionSettings.findFirst({ select: { hwidSettings: true } }),
                ]);
                const hwid = Boolean(
                    (settings?.hwidSettings as { enabled?: boolean } | null)?.enabled,
                );
                const generation = Date.now();
                await Promise.all(
                    nodes.map(async (node) => {
                        const engines: NodeEngine[] = [];
                        let runtime: AgentRuntime | null = null;
                        try {
                            runtime = await this.request<AgentRuntime>(
                                node,
                                'runtime',
                                '',
                                undefined,
                                5000,
                            );
                            this.agents.set(node.uuid, { ...runtime, connected: true });
                        } catch {
                            const health = await this.axios.getNodeHealth(node);
                            const previous = this.agents.get(node.uuid);
                            this.agents.set(node.uuid, {
                                agent: {
                                    version: health.isOk
                                        ? health.response.nodeVersion
                                        : (previous?.agent.version ?? ''),
                                    uptime: 0,
                                },
                                system: previous?.system ?? null,
                                xray: {
                                    xrayVersion: health.isOk
                                        ? health.response.xrayVersion
                                        : (previous?.xray?.xrayVersion ?? null),
                                },
                                engines: {
                                    openvpn: { enabled: false, endpoints: [] },
                                    amneziawg: { enabled: false, endpoints: [] },
                                },
                                connected: health.isOk && health.response.isAlive,
                            });
                        }
                        for (const engine of ['openvpn', 'amneziawg'] as const) {
                            const local = bindings
                                .filter(
                                    (binding) =>
                                        binding.nodeUuid === node.uuid &&
                                        binding.definition.type === engine,
                                )
                                .sort(
                                    (left, right) =>
                                        Number(right.isDisabled) - Number(left.isDisabled),
                                );
                            let status: RuntimeStatus = { enabled: false, endpoints: [] };
                            let error: string | null = null;
                            let usersOnline = 0;
                            const listenerErrors = new Map<string, string>();
                            const disabled = new Set<string>();
                            try {
                                status =
                                    runtime?.engines[engine] ??
                                    (await this.request(node, engine, '', undefined, 5000));
                                if (!status.enabled)
                                    throw new Error(engine + ' is disabled on the agent');
                                const accounts = users.map((user) => ({
                                    id: user.id.toString(),
                                    credentialId: user.vlessUuid,
                                    expiresAt: user.expireAt.toISOString(),
                                    endpointUuids: local
                                        .filter(
                                            (binding) =>
                                                this.policy.accountAllowed(user, hwid) &&
                                                this.inboundAllowed(binding, user),
                                        )
                                        .map((binding) => binding.runtimeUuid),
                                    ...(engine === 'amneziawg'
                                        ? {
                                              devices: [
                                                  { uuid: 'default', name: 'Default' },
                                                  ...user.amneziaWgDevices.map((device) => ({
                                                      uuid: device.uuid,
                                                      name: device.name,
                                                  })),
                                              ],
                                          }
                                        : {}),
                                }));
                                await this.request(node, engine, '/users', {
                                    generation,
                                    users: accounts,
                                });
                                for (const orphan of status.endpoints)
                                    if (
                                        !local.some(
                                            (binding) => binding.runtimeUuid === orphan.uuid,
                                        )
                                    )
                                        await this.request(
                                            node,
                                            engine,
                                            '/endpoints/' + orphan.uuid + '/remove',
                                            {},
                                        );
                                for (const binding of local) {
                                    try {
                                        const desired = this.wire(binding, bindings);
                                        if (desired.isDisabled) disabled.add(binding.runtimeUuid);
                                        status = await this.request(
                                            node,
                                            engine,
                                            '/endpoints',
                                            desired,
                                        );
                                    } catch (failure) {
                                        listenerErrors.set(
                                            binding.runtimeUuid,
                                            failure instanceof Error
                                                ? failure.message
                                                : 'Listener configuration failed',
                                        );
                                    }
                                }
                                const usage = ManagedVpnUsageSchema.parse(
                                    await this.request(node, engine, '/usage'),
                                );
                                usersOnline = usage.users.filter((user) => user.online).length;
                                await this.policy.accountUsage(engine, node, usage);
                            } catch (failure) {
                                if (!local.length) continue;
                                error =
                                    failure instanceof Error
                                        ? failure.message
                                        : 'VPN agent unavailable';
                            }
                            const profiles: NodeEngine['profiles'] = [];
                            for (const binding of local) {
                                const runtime = status.endpoints.find(
                                    (entry) => entry.uuid === binding.runtimeUuid,
                                );
                                const inbound = binding.configProfileInbounds;
                                let profile = profiles.find(
                                    (entry) => entry.uuid === inbound.profileUuid,
                                );
                                if (!profile) {
                                    profile = {
                                        uuid: inbound.profileUuid,
                                        name: inbound.profile.name,
                                        inbounds: [],
                                    };
                                    profiles.push(profile);
                                }
                                profile.inbounds.push({
                                    uuid: inbound.uuid,
                                    runtimeUuid: binding.runtimeUuid,
                                    tag: inbound.tag,
                                    port: inbound.port,
                                    transport:
                                        binding.definition.type === 'openvpn'
                                            ? binding.definition.mode === 'server'
                                                ? binding.definition.transport
                                                : (runtime?.protocol ?? null)
                                            : 'udp',
                                    mode: binding.definition.mode,
                                    assigned: !binding.isDisabled,
                                    enabled:
                                        !disabled.has(binding.runtimeUuid) &&
                                        !binding.isDisabled &&
                                        !node.isDisabled,
                                    running: !error && Boolean(runtime?.running),
                                    error:
                                        error ??
                                        listenerErrors.get(binding.runtimeUuid) ??
                                        runtime?.error ??
                                        null,
                                    peers: runtime?.peers ?? 0,
                                    hosts: inbound.hosts
                                        .filter((host) =>
                                            host.nodes.some(
                                                (entry) => entry.nodeUuid === node.uuid,
                                            ),
                                        )
                                        .map((host) => ({
                                            uuid: host.uuid,
                                            remark: host.remark,
                                            address: host.address,
                                            port: host.port,
                                        })),
                                });
                            }
                            engines.push({
                                type: engine,
                                enabled: status.enabled && !node.isDisabled,
                                version: status.version ?? null,
                                running:
                                    !error && status.endpoints.some((endpoint) => endpoint.running),
                                uptime: Math.max(
                                    0,
                                    ...status.endpoints.map((endpoint) => endpoint.uptime ?? 0),
                                ),
                                usersOnline,
                                profiles,
                            });
                        }
                        this.states.set(node.uuid, engines);
                        const connected =
                            !node.isDisabled && Boolean(this.agents.get(node.uuid)?.connected);
                        if (node.isConnected !== connected || node.isConnecting) {
                            const updated = await this.prisma.nodes.update({
                                where: { uuid: node.uuid },
                                data: {
                                    isConnected: connected,
                                    isConnecting: false,
                                    lastStatusChange: new Date(),
                                    lastStatusMessage:
                                        connected || node.isDisabled
                                            ? null
                                            : 'Agent connection failed',
                                },
                            });
                            if (!node.isDisabled && node.isConnected !== connected) {
                                const event = connected
                                    ? EVENTS.NODE.CONNECTION_RESTORED
                                    : EVENTS.NODE.CONNECTION_LOST;
                                this.events.emit(
                                    event,
                                    new NodeEvent(new NodesEntity(updated), event),
                                );
                            }
                        }
                    }),
                );
            });
            this.appliedRevision = revision;
            if (!this.requested) return;
        }
    }
}
