import { z } from 'zod';

export const ManagedVpnUsageSchema = z.object({
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
