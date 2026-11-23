import 'reflect-metadata';
import type { AxiosService } from '../src/common/axios';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ManagedVpnService } from '../src/common/vpn/managed-vpn.service';
import { PrismaService } from '../src/common/database/prisma.service';
import { UpdateOpenVpnEndpointSchema } from '../src/modules/openvpn/openvpn.schemas';
import { OpenVpnService } from '../src/modules/openvpn/openvpn.service';

test('partial endpoint edits preserve omitted credential and transport fields', () => {
    assert.deepEqual(UpdateOpenVpnEndpointSchema.parse({ isDisabled: true }), { isDisabled: true });
    assert.deepEqual(UpdateOpenVpnEndpointSchema.parse({ name: 'Renamed' }), { name: 'Renamed' });
    assert.deepEqual(UpdateOpenVpnEndpointSchema.parse({ udpMask: 'none' }), { udpMask: 'none' });
    assert.deepEqual(UpdateOpenVpnEndpointSchema.parse({ relayTargetUuid: null }), { relayTargetUuid: null });
});

test(
    'subscriptions enforce account policy and charge cumulative node counters exactly once',
    {
        skip: process.env.OPENVPN_DATABASE_TEST !== 'true',
    },
    async (t) => {
        const prisma = new PrismaService();
        await prisma.$connect();
        t.after(() => prisma.$disconnect());
        const node = await prisma.nodes.create({
            data: {
                name: `openvpn-${randomUUID()}`,
                address: randomUUID(),
                consumptionMultiplier: 1_500_000_000n,
            },
        });
        const user = await prisma.users.create({
            data: {
                shortUuid: randomUUID(),
                username: `ovpn-${randomUUID()}`,
                vlessUuid: randomUUID(),
                trojanPassword: randomUUID(),
                ssPassword: randomUUID(),
                expireAt: new Date(Date.now() + 60_000),
            },
        });
        const squad = await prisma.internalSquads.create({ data: { name: randomUUID() } });
        t.after(async () => {
            await prisma.nodes.delete({ where: { uuid: node.uuid } });
            await prisma.users.delete({ where: { id: user.id } });
            await prisma.internalSquads.delete({ where: { uuid: squad.uuid } });
        });
        const endpoint = await prisma.openVpnEndpoint.create({
            data: {
                nodeUuid: node.uuid,
                name: 'Test',
                address: '192.0.2.1',
                port: 443,
                protocol: 'udp',
                controlChannel: 'tls-crypt-v2',
                network: '10.88.0.0/24',
                dnsServers: ['1.1.1.1'],
            },
        });
        await assert.rejects(
            prisma.nodes.delete({ where: { uuid: node.uuid } }),
            /openvpn_endpoints_node_uuid_fkey/,
        );
        let usage = {
            epoch: randomUUID(),
            users: [{ id: user.id.toString(), uplink: 100, downlink: 300, online: true }],
        };
        let synced: { id: string; credentialId: string; endpointUuids: string[] }[] = [];
        const running = new Set([endpoint.uuid]);
        let configureGate: (() => Promise<void>) | undefined;
        const transport = {
            setJwt: async () => {},
            request: async ({ path, data }: { path: string; data?: unknown }) => {
                if (path === '/node/openvpn/users')
                    synced = (data as { users: typeof synced }).users;
                if (path === '/node/openvpn/endpoints') {
                    await configureGate?.();
                    running.add((data as { uuid: string }).uuid);
                }
                if (path.endsWith('/remove')) running.delete(path.split('/')[4]);
                return {
                    isOk: true,
                    response:
                        path === '/node/openvpn/usage'
                            ? usage
                            : {
                                  enabled: true,
                                  endpoints: [...running].map((uuid) => ({
                                      uuid,
                                      running: true,
                                      error: null,
                                  })),
                              },
                };
            },
        } as unknown as AxiosService;
        const service = new OpenVpnService(prisma, transport, new ManagedVpnService(prisma));
        assert.equal((await service.profiles(user.shortUuid)).length, 1);
        await service.sync();
        assert.equal(synced[0].credentialId, user.vlessUuid);
        await service.sync();
        let traffic = await prisma.userTraffic.findUniqueOrThrow({ where: { id: user.id } });
        assert.equal(traffic.usedTrafficBytes, 600n);
        usage.users[0].downlink = 500;
        await Promise.all([service.sync(), service.sync(), service.sync()]);
        traffic = await prisma.userTraffic.findUniqueOrThrow({ where: { id: user.id } });
        assert.equal(traffic.usedTrafficBytes, 900n);
        assert.equal(
            (await prisma.nodes.findUniqueOrThrow({ where: { uuid: node.uuid } })).trafficUsedBytes,
            600n,
        );
        usage = {
            epoch: randomUUID(),
            users: [{ id: user.id.toString(), uplink: 10, downlink: 30, online: false }],
        };
        await service.sync();
        assert.equal(
            (await prisma.userTraffic.findUniqueOrThrow({ where: { id: user.id } }))
                .usedTrafficBytes,
            960n,
        );
        await prisma.users.update({ where: { id: user.id }, data: { trafficLimitBytes: 900n } });
        assert.deepEqual(await service.profiles(user.shortUuid), []);
        await service.sync();
        assert.deepEqual(synced, []);
        await prisma.users.update({
            where: { id: user.id },
            data: { trafficLimitBytes: 0n, status: 'DISABLED' },
        });
        assert.deepEqual(await service.profiles(user.shortUuid), []);
        await prisma.users.update({
            where: { id: user.id },
            data: { status: 'ACTIVE', expireAt: new Date(0) },
        });
        assert.deepEqual(await service.profiles(user.shortUuid), []);
        await prisma.users.update({
            where: { id: user.id },
            data: { expireAt: new Date(Date.now() + 60_000) },
        });
        await prisma.openVpnEndpoint.update({
            where: { uuid: endpoint.uuid },
            data: { internalSquadUuids: [squad.uuid] },
        });
        assert.deepEqual(await service.profiles(user.shortUuid), []);
        await prisma.internalSquadMembers.create({
            data: { internalSquadUuid: squad.uuid, userId: user.id },
        });
        assert.equal((await service.profiles(user.shortUuid)).length, 1);
        const settings = await prisma.subscriptionSettings.create({
            data: { customRemarks: {}, hwidSettings: { enabled: true } as never },
        });
        t.after(() => prisma.subscriptionSettings.delete({ where: { uuid: settings.uuid } }));
        assert.deepEqual(await service.profiles(user.shortUuid), []);
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const started = new Promise<void>((resolve) => {
            entered = resolve;
        });
        configureGate = async () => {
            entered();
            await blocked;
        };
        const updating = service.update(endpoint.uuid, { name: 'Updated' });
        await started;
        const otherInstance = new OpenVpnService(prisma, transport, new ManagedVpnService(prisma));
        const deleting = otherInstance.remove(endpoint.uuid);
        await new Promise((resolve) => setTimeout(resolve, 100));
        release();
        await Promise.all([updating, deleting]);
        configureGate = undefined;
        await service.sync();
        assert.equal(running.size, 0);
        running.add(randomUUID());
        await service.sync();
        assert.equal(running.size, 0);
        assert.deepEqual(synced, []);
        const managed = new ManagedVpnService(prisma);
        const beforeAwg = (await prisma.userTraffic.findUniqueOrThrow({ where: { id: user.id } })).usedTrafficBytes;
        const awgUsage = {
            epoch: randomUUID(),
            users: [{ id: user.id.toString(), uplink: 100, downlink: 200, online: false }],
        };
        await managed.accountUsage('amneziawg', node, awgUsage);
        await managed.accountUsage('amneziawg', node, awgUsage);
        await managed.accountUsage('openvpn', node, usage);
        assert.equal(
            (await prisma.userTraffic.findUniqueOrThrow({ where: { id: user.id } })).usedTrafficBytes,
            beforeAwg + 450n,
        );
    },
);
