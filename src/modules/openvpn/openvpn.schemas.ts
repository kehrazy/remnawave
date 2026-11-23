import { createZodDto } from 'nestjs-zod';
import { isIP } from 'node:net';
import { z } from 'zod';

export const CreateOpenVpnEndpointSchema = z.object({
    nodeUuid: z.uuid(),
    name: z.string().min(1).max(128),
    address: z.string().regex(/^[a-zA-Z0-9.-]{1,253}$/),
    port: z.number().int().min(1).max(65535),
    protocol: z.enum(['udp', 'tcp']).default('udp'),
    controlChannel: z
        .enum(['none', 'tls-auth', 'tls-crypt', 'tls-crypt-v2'])
        .default('tls-crypt-v2'),
    udpMask: z.enum(['none', 'random', 'strong', 'error-free']).default('none'),
    network: z
        .string()
        .regex(/^10\.(\d{1,3})\.(\d{1,3})\.0\/24$/)
        .refine((value) => isIP(value.split('/')[0]) === 4),
    dnsServers: z
        .array(z.string().refine((value) => isIP(value) === 4))
        .min(1)
        .max(4)
        .default(['1.1.1.1', '8.8.8.8']),
    egressAddress: z
        .string()
        .refine((value) => isIP(value) === 4)
        .nullable()
        .default(null),
    relayTargetUuid: z.uuid().nullable().default(null),
    internalSquadUuids: z.array(z.uuid()).default([]),
    isDisabled: z.boolean().default(false),
});

export const UpdateOpenVpnEndpointSchema = z.object({
    ...CreateOpenVpnEndpointSchema.shape,
    protocol: CreateOpenVpnEndpointSchema.shape.protocol.removeDefault(),
    controlChannel: CreateOpenVpnEndpointSchema.shape.controlChannel.removeDefault(),
    udpMask: CreateOpenVpnEndpointSchema.shape.udpMask.removeDefault(),
    dnsServers: CreateOpenVpnEndpointSchema.shape.dnsServers.removeDefault(),
    egressAddress: CreateOpenVpnEndpointSchema.shape.egressAddress.removeDefault(),
    relayTargetUuid: CreateOpenVpnEndpointSchema.shape.relayTargetUuid.removeDefault(),
    internalSquadUuids: CreateOpenVpnEndpointSchema.shape.internalSquadUuids.removeDefault(),
    isDisabled: CreateOpenVpnEndpointSchema.shape.isDisabled.removeDefault(),
}).partial();
export type OpenVpnEndpointInput = z.infer<typeof CreateOpenVpnEndpointSchema>;
export class CreateOpenVpnEndpointDto extends createZodDto(CreateOpenVpnEndpointSchema) {}
export class UpdateOpenVpnEndpointDto extends createZodDto(UpdateOpenVpnEndpointSchema) {}

export const OpenVpnProfileSchema = z.object({
    uuid: z.uuid(),
    name: z.string(),
    protocol: z.enum(['udp', 'tcp']),
    controlChannel: z.enum(['none', 'tls-auth', 'tls-crypt', 'tls-crypt-v2']),
    url: z.string(),
});
export type OpenVpnProfile = z.infer<typeof OpenVpnProfileSchema>;

export const OpenVpnUsageSchema = z.object({
    epoch: z.uuid(),
    users: z.array(
        z.object({
            id: z.string().regex(/^[1-9][0-9]{0,19}$/),
            uplink: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            downlink: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            online: z.boolean(),
        }),
    ),
});
