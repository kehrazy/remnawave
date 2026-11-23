import type { Response } from 'express';

import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseUUIDPipe,
    Post,
    Query,
    Res,
    UseFilters,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { HttpExceptionFilter } from '@common/exception/http-exception.filter';
import { NativeVpnService } from '@common/vpn/native-vpn.service';

import { CreateAmneziaWgDeviceDto, AmneziaWgDeviceIdSchema } from './amneziawg.schemas';

@ApiTags('AmneziaWG subscriptions')
@UseFilters(HttpExceptionFilter)
@Controller('amneziawg/subscriptions')
export class AmneziaWgSubscriptionController {
    constructor(private readonly vpn: NativeVpnService) {}

    @Get(':shortUuid')
    async profiles(@Param('shortUuid') shortUuid: string, @Res() response: Response) {
        return response
            .set('Cache-Control', 'no-store')
            .json({ response: await this.vpn.profiles('amneziawg', shortUuid) });
    }

    @Get(':shortUuid/devices')
    async devices(@Param('shortUuid') shortUuid: string, @Res() response: Response) {
        return response
            .set('Cache-Control', 'no-store')
            .json({ response: await this.vpn.devices(shortUuid) });
    }

    @Post(':shortUuid/devices')
    async addDevice(
        @Param('shortUuid') shortUuid: string,
        @Body() body: CreateAmneziaWgDeviceDto,
        @Res() response: Response,
    ) {
        return response
            .set('Cache-Control', 'no-store')
            .json({ response: await this.vpn.addDevice(shortUuid, body.name) });
    }

    @Delete(':shortUuid/devices/:uuid')
    async removeDevice(
        @Param('shortUuid') shortUuid: string,
        @Param('uuid', ParseUUIDPipe) uuid: string,
        @Res() response: Response,
    ) {
        await this.vpn.removeDevice(shortUuid, uuid);
        return response.set('Cache-Control', 'no-store').json({ response: { success: true } });
    }

    @Get(':shortUuid/:uuid.conf')
    async profile(
        @Param('shortUuid') shortUuid: string,
        @Param('uuid', ParseUUIDPipe) uuid: string,
        @Res() response: Response,
        @Query('device') device?: string,
    ) {
        const profile = await this.vpn.profile(
            'amneziawg',
            shortUuid,
            uuid,
            AmneziaWgDeviceIdSchema.parse(device ?? 'default'),
        );
        return response
            .set({
                'Cache-Control': 'no-store',
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="amneziawg-${uuid}.conf"`,
            })
            .send(profile);
    }
}
