import 'reflect-metadata';
import type { DB } from '../prisma/generated/types';
import type { AxiosService } from '../src/common/axios';

import {
    DummyDriver,
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
} from 'kysely';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { EventEmitter2 } from '@nestjs/event-emitter';

import {
    parseNativeVpnConfig,
    NativeVpnConfigSchema,
} from '../libs/contract/models/native-vpn.schema';
import { CustomCamelCasePlugin, JSON_COLUMNS } from '../src/common/database/camel-case.plugin';
import { PrismaService } from '../src/common/database/prisma.service';
import { TxKyselyService } from '../src/common/database/tx-kysely.service';
import { ManagedVpnService } from '../src/common/vpn/managed-vpn.service';
import { NativeVpnService } from '../src/common/vpn/native-vpn.service';
import { HostsConverter } from '../src/modules/hosts/hosts.converter';
import { HostsRepository } from '../src/modules/hosts/repositories/hosts.repository';
import { NodesEntity } from '../src/modules/nodes/entities/nodes.entity';
import { NodeResponseModel } from '../src/modules/nodes/models/node.response.model';

test('native relay profiles contain only forwarding settings and reject recursive server fields', () => {
    const relay = {
        type: 'amneziawg',
        mode: 'relay',
        tag: 'relay',
        port: 5443,
        relayTargetUuid: randomUUID(),
    };
    assert.deepEqual(parseNativeVpnConfig('amneziawg', { inbounds: [relay] }).inbounds, [relay]);
    assert.equal(
        NativeVpnConfigSchema.safeParse({ inbounds: [{ ...relay, network: '10.99.0.0/24' }] })
            .success,
        false,
    );
    assert.throws(() => parseNativeVpnConfig('openvpn', { inbounds: [relay] }));
    assert.throws(() =>
        parseNativeVpnConfig('amneziawg', {
            inbounds: [
                {
                    type: 'amneziawg',
                    mode: 'server',
                    tag: 'bad',
                    port: 5443,
                    network: '10.99.0.0/24',
                    generation: '2.0',
                    parameters: { RandomTrailers: false },
                },
            ],
        }),
    );
});

for (const engine of ['openvpn', 'amneziawg'] as const)
    test(
        `${engine}: shared profiles, Hosts and squads enforce routes, lifecycle, identities and account limits`,
        {
            skip: process.env.OPENVPN_DATABASE_TEST !== 'true',
            timeout: 120_000,
        },
        async (t) => {
            const prisma = new PrismaService();
            await prisma.$connect();
            const nodes = await Promise.all(
                [0, 1].map(() =>
                    prisma.nodes.create({
                        data: {
                            name: randomUUID(),
                            address: randomUUID(),
                            consumptionMultiplier: 1_500_000_000n,
                        },
                    }),
                ),
            );
            const users = await Promise.all(
                [0, 1].map(() =>
                    prisma.users.create({
                        data: {
                            username: randomUUID(),
                            shortUuid: randomUUID(),
                            vlessUuid: randomUUID(),
                            trojanPassword: randomUUID(),
                            ssPassword: randomUUID(),
                            expireAt: new Date(Date.now() + 300_000),
                        },
                    }),
                ),
            );
            const squad = await prisma.internalSquads.create({ data: { name: randomUUID() } });
            const definitions = [
                parseNativeVpnConfig(engine, {
                    inbounds: [
                        {
                            type: engine,
                            mode: 'server',
                            tag: 'server',
                            port: 5443,
                            network: '10.87.0.0/24',
                        },
                    ],
                }).inbounds[0],
            ];
            const profiles: string[] = [];
            const hosts: string[] = [];
            const inbounds: string[] = [];
            for (let i = 0; i < 2; i++) {
                const definition =
                    i === 0
                        ? definitions[0]
                        : {
                              type: engine,
                              mode: 'relay',
                              tag: 'relay',
                              port: 5443,
                              relayTargetUuid: hosts[0],
                          };
                const profile = await prisma.configProfiles.create({
                    data: { name: randomUUID(), engine, config: { inbounds: [definition] } },
                });
                profiles.push(profile.uuid);
                const inbound = await prisma.configProfileInbounds.create({
                    data: {
                        profileUuid: profile.uuid,
                        tag: definition.tag,
                        type: engine,
                        port: 5443,
                        rawInbound: definition,
                        relayTargetHostUuid: i === 1 ? hosts[0] : null,
                    },
                });
                inbounds.push(inbound.uuid);
                await prisma.configProfileInboundsToNodes.create({
                    data: {
                        nodeUuid: nodes[i].uuid,
                        configProfileInboundUuid: inbound.uuid,
                        runtimeUuid: inbound.uuid,
                    },
                });
                const host = await prisma.hosts.create({
                    data: {
                        remark: 'Route ' + i,
                        address: '192.0.2.' + (i + 1),
                        port: 5443,
                        configProfileUuid: profile.uuid,
                        configProfileInboundUuid: inbound.uuid,
                        nodes: { create: { nodeUuid: nodes[i].uuid } },
                    },
                });
                hosts.push(host.uuid);
                await prisma.internalSquadInbounds.create({
                    data: { internalSquadUuid: squad.uuid, inboundUuid: inbound.uuid },
                });
            }
            const connection = {
                executeQuery: async (query: { sql: string; parameters: readonly unknown[] }) => ({
                    rows: (await prisma.$queryRawUnsafe(query.sql, ...query.parameters)) as Record<
                        string,
                        unknown
                    >[],
                }),
            };
            const driver = new DummyDriver();
            driver.acquireConnection = async () => connection as never;
            const kysely = new Kysely<DB>({
                dialect: {
                    createDriver: () => driver,
                    createAdapter: () => new PostgresAdapter(),
                    createQueryCompiler: () => new PostgresQueryCompiler(),
                    createIntrospector: (db) => new PostgresIntrospector(db),
                },
                plugins: [new CustomCamelCasePlugin({ excludeColumns: JSON_COLUMNS })],
            });
            const repository = new HostsRepository(
                { tx: prisma } as never,
                new TxKyselyService(kysely),
                new HostsConverter(),
            );
            const configured = new Map<
                string,
                Map<string, { uuid: string; isDisabled: boolean; protocol?: string }>
            >();
            const synced = new Map<
                string,
                {
                    id: string;
                    credentialId: string;
                    endpointUuids: string[];
                    devices?: { uuid: string }[];
                }[]
            >();
            let usage = {
                epoch: randomUUID(),
                users: [{ id: users[0].id.toString(), uplink: 100, downlink: 300, online: true }],
            };
            const calls: string[] = [];
            const status = (key: string) => ({
                enabled: true,
                version: 'test',
                endpoints: [...(configured.get(key)?.values() ?? [])].map((endpoint) => ({
                    uuid: endpoint.uuid,
                    running: !endpoint.isDisabled,
                    error: null,
                    uptime: 30,
                    protocol: endpoint.protocol,
                })),
            });
            const axios = {
                setJwt: async () => {},
                request: async ({
                    opts,
                    path,
                    data,
                }: {
                    opts: { uuid: string };
                    path: string;
                    data?: any;
                }) => {
                    calls.push(path);
                    if (path === '/node/runtime')
                        return {
                            isOk: true,
                            response: {
                                agent: { version: 'test', uptime: 60 },
                                system: null,
                                xray: null,
                                engines: {
                                    openvpn: status(opts.uuid + ':openvpn'),
                                    amneziawg: status(opts.uuid + ':amneziawg'),
                                },
                            },
                        };
                    const kind = path.split('/')[2];
                    const key = opts.uuid + ':' + kind;
                    const listeners = configured.get(key) ?? new Map();
                    configured.set(key, listeners);
                    if (path.endsWith('/users')) synced.set(key, data.users);
                    if (path.endsWith('/endpoints')) listeners.set(data.uuid, data);
                    if (path.endsWith('/remove')) listeners.delete(path.split('/')[4]);
                    return {
                        isOk: true,
                        response: path.endsWith('/usage')
                            ? opts.uuid === nodes[0].uuid && kind === engine
                                ? usage
                                : { epoch: opts.uuid, users: [] }
                            : path.endsWith('/profile')
                              ? { profile: 'PRIVATE PROFILE' }
                              : status(key),
                    };
                },
            } as unknown as AxiosService;
            const policy = new ManagedVpnService(prisma);
            const service = new NativeVpnService(
                prisma,
                axios,
                policy,
                repository,
                new EventEmitter2(),
            );
            t.after(async () => {
                service.onModuleDestroy();
                await prisma.configProfileInbounds.updateMany({
                    where: { uuid: { in: inbounds } },
                    data: { relayTargetHostUuid: null },
                });
                await prisma.hosts.deleteMany({ where: { uuid: { in: hosts } } });
                await prisma.configProfiles.deleteMany({ where: { uuid: { in: profiles } } });
                await prisma.users.deleteMany({
                    where: { id: { in: users.map((user) => user.id) } },
                });
                await prisma.nodes.deleteMany({
                    where: { uuid: { in: nodes.map((node) => node.uuid) } },
                });
                await prisma.internalSquads.delete({ where: { uuid: squad.uuid } });
                await kysely.destroy();
                await prisma.$disconnect();
            });
            assert.deepEqual(await service.profiles(engine, users[0].shortUuid), []);
            await prisma.internalSquadMembers.create({
                data: { userId: users[0].id, internalSquadUuid: squad.uuid },
            });
            assert.deepEqual(
                new Set(
                    (await service.profiles(engine, users[0].shortUuid)).map(
                        (profile) => profile.uuid,
                    ),
                ),
                new Set(hosts),
            );
            await prisma.internalSquadHostLinks.create({
                data: { hostUuid: hosts[1], squadUuid: squad.uuid },
            });
            assert.equal((await service.profiles(engine, users[0].shortUuid)).length, 1);
            await prisma.hosts.update({
                where: { uuid: hosts[1] },
                data: { internalSquadsMode: 'ALLOW_ONLY' },
            });
            assert.equal((await service.profiles(engine, users[0].shortUuid)).length, 2);
            await assert.rejects(
                prisma.hosts.delete({ where: { uuid: hosts[0] } }),
                /relay_target/,
            );
            await assert.rejects(
                service.validateProfile(profiles[0], { inbounds: [] }),
                /relay uses/,
            );
            const changed = parseNativeVpnConfig(engine, {
                inbounds: [{ ...definitions[0], network: '10.86.0.0/24' }],
            });
            await assert.rejects(service.validateProfile(profiles[0], changed), /identity/);
            await assert.rejects(
                service.validateAssignment(nodes[0].uuid, [inbounds[0], inbounds[1]]),
                /another node/,
            );
            const collidingProfile = await prisma.configProfiles.create({
                data: { name: randomUUID(), engine, config: { inbounds: [definitions[0]] } },
            });
            profiles.push(collidingProfile.uuid);
            const collision = await prisma.configProfileInbounds.create({
                data: {
                    profileUuid: collidingProfile.uuid,
                    tag: 'collision_' + randomUUID().replaceAll('-', ''),
                    type: engine,
                    port: 5443,
                    rawInbound: { ...definitions[0], network: '10.86.0.0/24' },
                },
            });
            await assert.rejects(
                service.assignInbounds(nodes[0].uuid, [inbounds[0], collision.uuid]),
                /Another listener/,
            );
            assert.equal(
                await prisma.configProfileInboundsToNodes.count({
                    where: { configProfileInboundUuid: collision.uuid },
                }),
                0,
            );
            await service.sync();
            assert.equal(
                synced
                    .get(nodes[0].uuid + ':' + engine)!
                    .find((user) => user.id === users[0].id.toString())?.credentialId,
                users[0].vlessUuid,
            );
            assert.equal(
                (await prisma.userTraffic.findUniqueOrThrow({ where: { id: users[0].id } }))
                    .usedTrafficBytes,
                600n,
            );
            await Promise.all([service.sync(), service.sync(), service.sync()]);
            assert.equal(
                (await prisma.userTraffic.findUniqueOrThrow({ where: { id: users[0].id } }))
                    .usedTrafficBytes,
                600n,
            );
            usage.users[0].downlink = 500;
            await service.sync();
            assert.equal(
                (await prisma.userTraffic.findUniqueOrThrow({ where: { id: users[0].id } }))
                    .usedTrafficBytes,
                900n,
            );
            const states = await service.nodeStates(nodes.map((node) => node.uuid));
            const hot = states.get(nodes[0].uuid)!;
            const node = new NodeResponseModel(
                new NodesEntity(
                    await prisma.nodes.findUniqueOrThrow({ where: { uuid: nodes[0].uuid } }),
                ),
                {
                    system: null,
                    versions: null,
                    onlineUsers: 0,
                    xrayUptime: 0,
                    engines: hot.engines,
                    agentConnected: hot.agent?.connected,
                    totalOnlineUsers: hot.usersOnline,
                },
            );
            assert.equal(node.isConnected, true);
            assert.equal(node.engines.find((entry) => entry.type === engine)?.running, true);
            assert.equal(node.configProfile.activeConfigProfileUuid, null);
            await service.restart(nodes[0].uuid, engine);
            assert.ok(calls.includes('/node/runtime/' + engine + '/restart'));
            const runtimeUuid = (
                await prisma.configProfileInboundsToNodes.findUniqueOrThrow({
                    where: {
                        configProfileInboundUuid_nodeUuid: {
                            configProfileInboundUuid: inbounds[0],
                            nodeUuid: nodes[0].uuid,
                        },
                    },
                })
            ).runtimeUuid;
            await service.assignInbounds(nodes[0].uuid, []);
            assert.deepEqual(await service.profiles(engine, users[0].shortUuid), []);
            await service.assignInbounds(nodes[0].uuid, [inbounds[0]]);
            assert.equal(
                (
                    await prisma.configProfileInboundsToNodes.findUniqueOrThrow({
                        where: {
                            configProfileInboundUuid_nodeUuid: {
                                configProfileInboundUuid: inbounds[0],
                                nodeUuid: nodes[0].uuid,
                            },
                        },
                    })
                ).runtimeUuid,
                runtimeUuid,
            );
            if (engine === 'amneziawg') {
                const results = await Promise.allSettled(
                    Array.from({ length: 6 }, (_, index) =>
                        service.addDevice(users[0].shortUuid, 'Device ' + index),
                    ),
                );
                assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
                const devices = await service.devices(users[0].shortUuid);
                assert.equal(devices.length, 5);
                assert.equal(
                    await service.profile(engine, users[0].shortUuid, hosts[1], devices[1].uuid),
                    'PRIVATE PROFILE',
                );
                await assert.rejects(
                    service.profile(engine, users[0].shortUuid, hosts[0], randomUUID()),
                    /Device not found/,
                );
                await assert.rejects(
                    service.removeDevice(users[1].shortUuid, devices[1].uuid),
                    /Device not found/,
                );
                await service.removeDevice(users[0].shortUuid, devices[1].uuid);
                assert.equal((await service.devices(users[0].shortUuid)).length, 4);
            }
            await prisma.users.update({
                where: { id: users[0].id },
                data: { trafficLimitBytes: 800n },
            });
            assert.deepEqual(await service.profiles(engine, users[0].shortUuid), []);
            await service.sync();
            assert.deepEqual(
                synced
                    .get(nodes[0].uuid + ':' + engine)!
                    .find((user) => user.id === users[0].id.toString())?.endpointUuids,
                [],
            );
            await prisma.users.update({
                where: { id: users[0].id },
                data: { trafficLimitBytes: 0n, expireAt: new Date(0) },
            });
            assert.deepEqual(await service.profiles(engine, users[0].shortUuid), []);
            await prisma.users.update({
                where: { id: users[0].id },
                data: { expireAt: new Date(Date.now() + 300_000), status: 'DISABLED' },
            });
            assert.deepEqual(await service.profiles(engine, users[0].shortUuid), []);
            const inactive = await prisma.users.findUniqueOrThrow({
                where: { id: users[0].id },
                include: { traffic: true, activeInternalSquads: true, externalSquad: true },
            });
            assert.equal(policy.accountAllowed({ ...inactive, status: 'ACTIVE' }, true), false);
            await assert.rejects(
                policy.accountUsage(engine, nodes[0], {
                    ...usage,
                    users: [{ ...usage.users[0], downlink: 1 }],
                }),
                /decreased/,
            );
            usage = {
                epoch: randomUUID(),
                users: [{ id: users[0].id.toString(), uplink: 10, downlink: 30, online: false }],
            };
            await policy.accountUsage(engine, nodes[0], usage);
            assert.equal(
                (await prisma.userTraffic.findUniqueOrThrow({ where: { id: users[0].id } }))
                    .usedTrafficBytes,
                960n,
            );
        },
    );
