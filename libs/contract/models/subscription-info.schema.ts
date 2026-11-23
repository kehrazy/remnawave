import { z } from 'zod';

import { RESET_PERIODS, USERS_STATUS } from '../constants';

export const SubscriptionInfoSchema = z.object({
    isFound: z.boolean(),
    user: z.object({
        shortUuid: z.string(),
        daysLeft: z.number(),
        trafficUsed: z.string(),
        trafficLimit: z.string(),
        lifetimeTrafficUsed: z.string(),
        trafficUsedBytes: z.string(),
        trafficLimitBytes: z.string(),
        lifetimeTrafficUsedBytes: z.string(),
        username: z.string(),
        expiresAt: z.iso.datetime().transform((str) => new Date(str)),
        isActive: z.boolean(),
        userStatus: z.enum(USERS_STATUS),
        trafficLimitStrategy: z.enum(RESET_PERIODS),
    }),
    links: z.array(z.string()),
    ssConfLinks: z.record(z.string(), z.string()),
    subscriptionUrl: z.string(),
    amneziaWgProfiles: z.array(z.object({ uuid: z.uuid(), name: z.string(), generation: z.string(), url: z.string() })).optional(),
    openVpnProfiles: z
        .array(
            z.object({
                uuid: z.uuid(),
                name: z.string(),
                protocol: z.enum(['udp', 'tcp']),
                controlChannel: z.enum(['none', 'tls-auth', 'tls-crypt', 'tls-crypt-v2']),
                url: z.string(),
            }),
        )
        .optional(),
});
