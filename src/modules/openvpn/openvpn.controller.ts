import type { Response } from 'express';

import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Res,
    UseFilters,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { Roles } from '@common/decorators/roles/roles';
import { ApiScopeResource } from '@common/decorators/scopes';
import { HttpExceptionFilter } from '@common/exception/http-exception.filter';
import { JwtDefaultGuard } from '@common/guards/jwt-guards/def-jwt-guard';
import { RolesGuard } from '@common/guards/roles';
import { ScopesGuard } from '@common/guards/scopes';
import { ROLE } from '@libs/contracts/constants';

import { CreateOpenVpnEndpointDto, UpdateOpenVpnEndpointDto } from './openvpn.schemas';
import { OpenVpnService } from './openvpn.service';

@ApiTags('OpenVPN')
@ApiBearerAuth('Authorization')
@ApiScopeResource('openvpn')
@Roles(ROLE.ADMIN, ROLE.API)
@UseGuards(JwtDefaultGuard, RolesGuard, ScopesGuard)
@UseFilters(HttpExceptionFilter)
@Controller('openvpn/endpoints')
export class OpenVpnController {
    constructor(private readonly openVpn: OpenVpnService) {}

    @Get()
    async list() {
        return { response: await this.openVpn.list() };
    }

    @Post()
    async create(@Body() body: CreateOpenVpnEndpointDto) {
        return { response: await this.openVpn.create(body) };
    }

    @Patch(':uuid')
    async update(
        @Param('uuid', ParseUUIDPipe) uuid: string,
        @Body() body: UpdateOpenVpnEndpointDto,
    ) {
        return { response: await this.openVpn.update(uuid, body) };
    }

    @Delete(':uuid')
    async remove(@Param('uuid', ParseUUIDPipe) uuid: string) {
        await this.openVpn.remove(uuid);
        return { response: { success: true } };
    }

    @Post('sync')
    async sync() {
        await this.openVpn.sync();
        return { response: await this.openVpn.list() };
    }
}

@ApiTags('OpenVPN subscriptions')
@UseFilters(HttpExceptionFilter)
@Controller('openvpn/subscriptions')
export class OpenVpnSubscriptionController {
    constructor(private readonly openVpn: OpenVpnService) {}

    @Get(':shortUuid')
    async profiles(@Param('shortUuid') shortUuid: string, @Res() response: Response) {
        return response
            .set('Cache-Control', 'no-store')
            .json({ response: await this.openVpn.profiles(shortUuid) });
    }

    @Get(':shortUuid/:uuid.ovpn')
    async profile(
        @Param('shortUuid') shortUuid: string,
        @Param('uuid', ParseUUIDPipe) uuid: string,
        @Res() response: Response,
    ) {
        const profile = await this.openVpn.profile(shortUuid, uuid);
        return response
            .set({
                'Cache-Control': 'no-store',
                'Content-Type': 'application/x-openvpn-profile',
                'Content-Disposition': `attachment; filename="openvpn-${uuid}.ovpn"`,
            })
            .send(profile);
    }
}
