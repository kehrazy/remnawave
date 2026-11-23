import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CreateOpenVpnEndpointSchema, OpenVpnUsageSchema } from '../openvpn/openvpn.schemas';

export function parseAwgRange(value: string): [number, number] {
    const parts = value.split('-').map(Number);
    return [parts[0], parts[1] ?? parts[0]];
}

const RangeSchema = z.string().regex(/^\d{1,10}(?:-\d{1,10})?$/).refine((value) => {
    const [low, high] = parseAwgRange(value);
    return low <= high && high <= 0xffffffff;
});
const KeySchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
    .refine((value) => !Buffer.from(value, 'base64').every((byte) => byte === 0));

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
const ParameterFieldsSchema = z.object({
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
}).strict();
export const AmneziaWgParametersSchema = ParameterFieldsSchema.refine((parameters) => {
    if (parameters.Jmin > parameters.Jmax) return false;
    const ranges = [parameters.H1, parameters.H2, parameters.H3, parameters.H4].map(parseAwgRange);
    for (let i = 0; i < ranges.length; i++) {
        for (let j = i + 1; j < ranges.length; j++) {
            if (ranges[i][0] <= ranges[j][1] && ranges[j][0] <= ranges[i][1]) return false;
        }
    }
    const paddings = [parameters.S1, parameters.S2, parameters.S3, parameters.S4];
    if (parameters.HeaderProtectionKey && paddings.some((padding) => padding < 12)) return false;
    if (parameters.RandomTrailers && paddings.some((padding) => padding !== paddings[0])) return false;
    if (parameters.S1 + 56 === parameters.S2 || parameters.S3 === parameters.S2 + 28) return false;
    if (parameters.ContentPaddingAddition && parseAwgRange(parameters.ContentPaddingAddition)[1] > 128) return false;
    return true;
}, 'Incompatible AmneziaWG obfuscation parameters');

export const CreateAmneziaWgEndpointSchema = CreateOpenVpnEndpointSchema.omit({
    protocol: true, controlChannel: true, udpMask: true,
}).extend({
    generation: z.enum(['3.1', '2.0']).default('3.1'),
    preset: z.enum(['default', 'mobile']).default('default'),
    parameters: ParameterFieldsSchema.partial().default({}),
});
export const UpdateAmneziaWgEndpointSchema = z.object({
    ...CreateAmneziaWgEndpointSchema.shape,
    generation: CreateAmneziaWgEndpointSchema.shape.generation.removeDefault(),
    preset: CreateAmneziaWgEndpointSchema.shape.preset.removeDefault(),
    parameters: CreateAmneziaWgEndpointSchema.shape.parameters.removeDefault(),
    dnsServers: CreateAmneziaWgEndpointSchema.shape.dnsServers.removeDefault(),
    egressAddress: CreateAmneziaWgEndpointSchema.shape.egressAddress.removeDefault(),
    relayTargetUuid: CreateAmneziaWgEndpointSchema.shape.relayTargetUuid.removeDefault(),
    internalSquadUuids: CreateAmneziaWgEndpointSchema.shape.internalSquadUuids.removeDefault(),
    isDisabled: CreateAmneziaWgEndpointSchema.shape.isDisabled.removeDefault(),
}).partial();
export type AmneziaWgEndpointInput = z.infer<typeof CreateAmneziaWgEndpointSchema>;
export class CreateAmneziaWgEndpointDto extends createZodDto(CreateAmneziaWgEndpointSchema) {}
export class UpdateAmneziaWgEndpointDto extends createZodDto(UpdateAmneziaWgEndpointSchema) {}
export const AmneziaWgDeviceIdSchema = z.union([z.literal('default'), z.uuid()]);
export class CreateAmneziaWgDeviceDto extends createZodDto(z.object({ name: z.string().trim().min(1).max(64) })) {}
export const AmneziaWgUsageSchema = OpenVpnUsageSchema;
export type AmneziaWgProfile = { uuid: string; name: string; generation: string; url: string };
