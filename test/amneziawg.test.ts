import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { AxiosService } from '../src/common/axios';
import { PrismaService } from '../src/common/database/prisma.service';
import { ManagedVpnService } from '../src/common/vpn/managed-vpn.service';
import { AmneziaWgService } from '../src/modules/amneziawg/amneziawg.service';
import { CreateAmneziaWgEndpointSchema, UpdateAmneziaWgEndpointSchema } from '../src/modules/amneziawg/amneziawg.schemas';

test('AmneziaWG PATCH preserves omitted fields and validates obfuscation inputs', () => {
    assert.deepEqual(UpdateAmneziaWgEndpointSchema.parse({ isDisabled: true }), { isDisabled: true });
    assert.equal(CreateAmneziaWgEndpointSchema.safeParse({ nodeUuid: randomUUID(), name: 'Test', address: '192.0.2.1', port: 5443, network: '10.93.0.0/24', parameters: { I1: '<r -1>' } }).success, false);
});

test('AmneziaWG relays inherit access, device ownership and limits survive concurrent changes', {
    skip: process.env.OPENVPN_DATABASE_TEST !== 'true', timeout: 120_000,
}, async (t) => {
    const prisma = new PrismaService();
    await prisma.$connect();
    const nodes = await Promise.all([0, 1].map(() => prisma.nodes.create({ data: { name: randomUUID(), address: randomUUID() } })));
    const accounts = await Promise.all([0, 1].map(() => prisma.users.create({ data: {
        username: 'awg-' + randomUUID(), shortUuid: randomUUID(), vlessUuid: randomUUID(), trojanPassword: randomUUID(), ssPassword: randomUUID(),
        expireAt: new Date(Date.now() + 300_000),
    } })));
    const squad = await prisma.internalSquads.create({ data: { name: randomUUID() } });
    const synced = new Map<string, { id: string; credentialId: string; endpointUuids: string[]; devices: { uuid: string }[] }[]>();
    const configured = new Map<string, Set<string>>();
    const transport = {
        setJwt: async () => {},
        request: async ({ opts, path, data }: { opts: { uuid: string }; path: string; data?: any }) => {
            const running = configured.get(opts.uuid) ?? new Set<string>();
            configured.set(opts.uuid, running);
            if (path.endsWith('/users')) synced.set(opts.uuid, data.users);
            if (path.endsWith('/endpoints')) running.add(data.uuid);
            if (path.endsWith('/remove')) running.delete(path.split('/')[4]);
            return { isOk: true, response: path.endsWith('/usage') ? { epoch: opts.uuid, users: [] }
                : path.endsWith('/profile') ? { profile: 'PRIVATE PROFILE' }
                : { enabled: true, endpoints: [...running].map((uuid) => ({ uuid, running: true, error: null })) } };
        },
    } as unknown as AxiosService;
    const service = new AmneziaWgService(prisma, transport, new ManagedVpnService(prisma));
    t.after(async () => {
        service.onModuleDestroy();
        await service.sync();
        await prisma.amneziaWgEndpoint.deleteMany({ where: { nodeUuid: { in: nodes.map((node) => node.uuid) }, relayTargetUuid: { not: null } } });
        await prisma.amneziaWgEndpoint.deleteMany({ where: { nodeUuid: { in: nodes.map((node) => node.uuid) } } });
        await prisma.users.deleteMany({ where: { id: { in: accounts.map((user) => user.id) } } });
        await prisma.nodes.deleteMany({ where: { uuid: { in: nodes.map((node) => node.uuid) } } });
        await prisma.internalSquads.delete({ where: { uuid: squad.uuid } });
        await prisma.$disconnect();
    });
    const server = await service.create(CreateAmneziaWgEndpointSchema.parse({
        nodeUuid: nodes[0].uuid, name: 'Exit', address: '192.0.2.1', port: 5443,
        network: '10.93.0.0/24', internalSquadUuids: [squad.uuid],
    }));
    const relay = await service.create(CreateAmneziaWgEndpointSchema.parse({
        nodeUuid: nodes[1].uuid, name: 'Relay', address: '192.0.2.2', port: 5443,
        network: '10.94.0.0/24', relayTargetUuid: server.uuid,
    }));
    assert.deepEqual(await service.profiles(accounts[0].shortUuid), []);
    await prisma.users.update({ where: { id: accounts[0].id }, data: { activeInternalSquads: { create: { internalSquadUuid: squad.uuid } } } });
    assert.deepEqual(new Set((await service.profiles(accounts[0].shortUuid)).map((profile) => profile.uuid)), new Set([server.uuid, relay.uuid]));
    await assert.rejects(service.remove(server.uuid), /relays/);
    await assert.rejects(prisma.nodes.delete({ where: { uuid: nodes[0].uuid } }), /amneziawg_endpoints_node_uuid_fkey/);
    await assert.rejects(service.create(CreateAmneziaWgEndpointSchema.parse({ ...server, port: 5443 })), /already assigned/);
    await assert.rejects(service.update(server.uuid, { network: '10.99.0.0/24' }), /another endpoint/);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => service.addDevice(accounts[0].shortUuid, `Device ${i}`)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 4);
    const devices = await service.devices(accounts[0].shortUuid);
    assert.equal(devices.length, 5);
    assert.equal(devices[0].uuid, 'default');
    assert.equal((await service.profile(accounts[0].shortUuid, relay.uuid, devices[1].uuid)), 'PRIVATE PROFILE');
    await assert.rejects(service.profile(accounts[0].shortUuid, server.uuid, randomUUID()), /Device not found/);
    await assert.rejects(service.removeDevice(accounts[1].shortUuid, devices[1].uuid), /Device not found/);
    await service.removeDevice(accounts[0].shortUuid, devices[1].uuid);
    assert.equal((await service.devices(accounts[0].shortUuid)).length, 4);
    const credentials = randomUUID();
    await prisma.users.update({ where: { id: accounts[0].id }, data: { vlessUuid: credentials, status: 'DISABLED' } });
    await service.sync();
    const disabled = synced.get(nodes[0].uuid)!.find((user) => user.id === accounts[0].id.toString())!;
    assert.equal(disabled.credentialId, credentials);
    assert.deepEqual(disabled.endpointUuids, []);
    assert.equal(disabled.devices.length, 4);
    assert.deepEqual(await service.profiles(accounts[0].shortUuid), []);
    await prisma.users.update({ where: { id: accounts[0].id }, data: { status: 'ACTIVE', expireAt: new Date(0) } });
    assert.deepEqual(await service.profiles(accounts[0].shortUuid), []);
    await service.update(server.uuid, { isDisabled: true });
    await service.sync();
    assert.ok(synced.get(nodes[0].uuid)!.every((user) => !user.endpointUuids.includes(server.uuid)));
});
