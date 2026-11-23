import type { Response } from 'express';

import { Controller, Get, Param, ParseUUIDPipe, Res, UseFilters } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { HttpExceptionFilter } from '@common/exception/http-exception.filter';
import { NativeVpnService } from '@common/vpn/native-vpn.service';

@ApiTags('OpenVPN subscriptions')
@UseFilters(HttpExceptionFilter)
@Controller('openvpn/subscriptions')
export class OpenVpnSubscriptionController {
    constructor(private readonly vpn: NativeVpnService) {}

    @Get(':shortUuid')
    async profiles(@Param('shortUuid') shortUuid: string, @Res() response: Response) {
        return response
            .set('Cache-Control', 'no-store')
            .json({ response: await this.vpn.profiles('openvpn', shortUuid) });
    }

    @Get(':shortUuid/:uuid.ovpn')
    async profile(
        @Param('shortUuid') shortUuid: string,
        @Param('uuid', ParseUUIDPipe) uuid: string,
        @Res() response: Response,
    ) {
        const profile = await this.vpn.profile('openvpn', shortUuid, uuid);
        return response
            .set({
                'Cache-Control': 'no-store',
                'Content-Type': 'application/x-openvpn-profile',
                'Content-Disposition': `attachment; filename="openvpn-${uuid}.ovpn"`,
            })
            .send(profile);
    }
}
