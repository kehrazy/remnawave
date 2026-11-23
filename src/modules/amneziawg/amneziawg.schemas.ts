import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const AmneziaWgDeviceIdSchema = z.union([z.literal('default'), z.uuid()]);
export class CreateAmneziaWgDeviceDto extends createZodDto(
    z.object({ name: z.string().trim().min(1).max(64) }),
) {}
