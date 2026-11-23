import { z } from 'zod';

export function parseAwgRange(value: string): [number, number] {
    const parts = value.split('-').map(Number);
    return [parts[0], parts[1] ?? parts[0]];
}

const RangeSchema = z
    .string()
    .regex(/^\d{1,10}(?:-\d{1,10})?$/)
    .refine((value) => {
        const [low, high] = parseAwgRange(value);
        return low <= high && high <= 0xffffffff;
    });
const KeySchema = z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .refine((value) => !/^A{42}[A-D]=$/.test(value));

export function validAwgSignature(value: string): boolean {
    let size = 0;
    let remaining = value;
    while (remaining.length) {
        const tag = /^(?:\s*)(<(?:b\s+0x[0-9a-fA-F]+|r[cd]?\s+\d{1,4}|t)>)(?:\s*)/.exec(remaining);
        if (!tag) return false;
        const body = tag[1].slice(1, -1).split(/\s+/);
        if (body[0] === 'b') {
            if ((body[1].length - 2) % 2) return false;
            size += (body[1].length - 2) / 2;
        } else size += body[0] === 't' ? 4 : Number(body[1]);
        if (size > 1280) return false;
        remaining = remaining.slice(tag[0].length);
    }
    return true;
}

const SignatureSchema = z.string().max(8192).refine(validAwgSignature);
export const AmneziaWgParameterOverridesSchema = z
    .object({
        Jc: z.number().int().min(0).max(128),
        Jmin: z.number().int().min(1).max(1280),
        Jmax: z.number().int().min(1).max(1280),
        S1: z.number().int().min(0).max(1132),
        S2: z.number().int().min(0).max(1188),
        S3: z.number().int().min(0).max(64),
        S4: z.number().int().min(0).max(32),
        H1: RangeSchema,
        H2: RangeSchema,
        H3: RangeSchema,
        H4: RangeSchema,
        HeaderProtectionKey: KeySchema.optional(),
        ContentPaddingAddition: RangeSchema.optional(),
        RandomTrailers: z.boolean().optional(),
        DisableCookies: z.boolean().optional(),
        I1: SignatureSchema.optional(),
        I2: SignatureSchema.optional(),
        I3: SignatureSchema.optional(),
        I4: SignatureSchema.optional(),
        I5: SignatureSchema.optional(),
    })
    .strict();
export const AmneziaWgParametersSchema = AmneziaWgParameterOverridesSchema.refine((parameters) => {
    if (parameters.Jmin > parameters.Jmax) return false;
    const ranges = [parameters.H1, parameters.H2, parameters.H3, parameters.H4].map(parseAwgRange);
    for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
            if (ranges[i][0] <= ranges[j][1] && ranges[j][0] <= ranges[i][1]) return false;
        }
    }
    const paddings = [parameters.S1, parameters.S2, parameters.S3, parameters.S4];
    if (parameters.HeaderProtectionKey && paddings.some((padding) => padding < 12)) return false;
    if (parameters.RandomTrailers && paddings.some((padding) => padding !== paddings[0]))
        return false;
    if (parameters.S1 + 56 === parameters.S2 || parameters.S3 === parameters.S2 + 28) return false;
    if (
        parameters.ContentPaddingAddition &&
        parseAwgRange(parameters.ContentPaddingAddition)[1] > 128
    )
        return false;
    return true;
}, 'Incompatible AmneziaWG obfuscation parameters');

export const VpnEngineSchema = z.enum(['xray', 'openvpn', 'amneziawg']);
export const NativeVpnEngineSchema = VpnEngineSchema.exclude(['xray']);

const ListenerSchema = z.object({
    tag: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    port: z.int().min(1).max(65535),
});
const ServerInboundSchema = ListenerSchema.extend({
    mode: z.literal('server'),
    network: z
        .string()
        .regex(/^10\.(\d{1,3})\.(\d{1,3})\.0\/24$/)
        .refine((value) =>
            value
                .split('/')[0]
                .split('.')
                .every((part) => Number(part) <= 255),
        ),
    dnsServers: z.array(z.ipv4()).min(1).max(4).default(['1.1.1.1', '8.8.8.8']),
    egressAddress: z.ipv4().nullable().default(null),
});
const RelayInboundSchema = ListenerSchema.extend({
    mode: z.literal('relay'),
    relayTargetUuid: z.uuid(),
});
const OpenVpnServerInboundSchema = ServerInboundSchema.extend({
    type: z.literal('openvpn'),
    transport: z.enum(['udp', 'tcp']).default('udp'),
    controlChannel: z
        .enum(['none', 'tls-auth', 'tls-crypt', 'tls-crypt-v2'])
        .default('tls-crypt-v2'),
    udpMask: z.enum(['none', 'random', 'strong', 'error-free']).default('none'),
}).strict();
const AmneziaWgServerInboundSchema = ServerInboundSchema.extend({
    type: z.literal('amneziawg'),
    generation: z.enum(['3.1', '2.0']).default('3.1'),
    preset: z.enum(['default', 'mobile']).default('default'),
    parameters: AmneziaWgParameterOverridesSchema.partial().default({}),
})
    .strict()
    .refine(
        (inbound) =>
            inbound.generation !== '2.0' ||
            ![
                'HeaderProtectionKey',
                'ContentPaddingAddition',
                'RandomTrailers',
                'DisableCookies',
            ].some((key) => key in inbound.parameters),
        'AmneziaWG 3.1 parameters require generation 3.1',
    );
export const OpenVpnInboundSchema = z.discriminatedUnion('mode', [
    OpenVpnServerInboundSchema,
    RelayInboundSchema.extend({ type: z.literal('openvpn') }).strict(),
]);
export const AmneziaWgInboundSchema = z.discriminatedUnion('mode', [
    AmneziaWgServerInboundSchema,
    RelayInboundSchema.extend({ type: z.literal('amneziawg') }).strict(),
]);

export const NativeVpnConfigSchema = z
    .object({
        inbounds: z.array(z.union([OpenVpnInboundSchema, AmneziaWgInboundSchema])).min(1),
    })
    .strict()
    .refine(
        (config) =>
            new Set(config.inbounds.map((inbound) => inbound.tag)).size === config.inbounds.length,
        'Listener tags must be unique',
    );

export const NodeEngineSchema = z.object({
    type: VpnEngineSchema,
    version: z.string().nullable(),
    enabled: z.boolean(),
    running: z.boolean(),
    uptime: z.number().nonnegative(),
    usersOnline: z.number().int().nonnegative(),
    profiles: z.array(
        z.object({
            uuid: z.uuid(),
            name: z.string(),
            inbounds: z.array(
                z.object({
                    uuid: z.uuid(),
                    runtimeUuid: z.uuid(),
                    tag: z.string(),
                    port: z.number().nullable(),
                    transport: z.string().nullable(),
                    mode: z.enum(['server', 'relay']),
                    assigned: z.boolean(),
                    enabled: z.boolean(),
                    running: z.boolean(),
                    error: z.string().nullable(),
                    peers: z.number().int().nonnegative(),
                    hosts: z.array(
                        z.object({
                            uuid: z.uuid(),
                            remark: z.string(),
                            address: z.string(),
                            port: z.number(),
                        }),
                    ),
                }),
            ),
        }),
    ),
});

export type VpnEngine = z.infer<typeof VpnEngineSchema>;
export type NativeVpnEngine = z.infer<typeof NativeVpnEngineSchema>;
export type NativeVpnConfig = z.infer<typeof NativeVpnConfigSchema>;
export type NativeVpnInbound = NativeVpnConfig['inbounds'][number];
export type NodeEngine = z.infer<typeof NodeEngineSchema>;

export function parseNativeVpnConfig(engine: NativeVpnEngine, config: unknown): NativeVpnConfig {
    const parsed = NativeVpnConfigSchema.parse(config);
    if (parsed.inbounds.some((inbound) => inbound.type !== engine)) {
        throw new Error('Every listener must use the profile engine');
    }
    return parsed;
}
