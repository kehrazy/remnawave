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
    Query,
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

import { CreateAmneziaWgEndpointDto, UpdateAmneziaWgEndpointDto, CreateAmneziaWgDeviceDto, AmneziaWgDeviceIdSchema } from './amneziawg.schemas';
import { AmneziaWgService } from './amneziawg.service';

@ApiTags('AmneziaWG')
@ApiBearerAuth('Authorization')
@ApiScopeResource('amneziawg')
@Roles(ROLE.ADMIN, ROLE.API)
@UseGuards(JwtDefaultGuard, RolesGuard, ScopesGuard)
@UseFilters(HttpExceptionFilter)
@Controller('amneziawg/endpoints')
export class AmneziaWgController {
    constructor(private readonly amneziaWg: AmneziaWgService) {}

    @Get()
    async list() {
        return { response: await this.amneziaWg.list() };
    }

    @Post()
    async create(@Body() body: CreateAmneziaWgEndpointDto) {
        return { response: await this.amneziaWg.create(body) };
    }

    @Patch(':uuid')
    async update(
        @Param('uuid', ParseUUIDPipe) uuid: string,
        @Body() body: UpdateAmneziaWgEndpointDto,
    ) {
        return { response: await this.amneziaWg.update(uuid, body) };
    }

    @Delete(':uuid')
    async remove(@Param('uuid', ParseUUIDPipe) uuid: string) {
        await this.amneziaWg.remove(uuid);
        return { response: { success: true } };
    }

    @Post('sync')
    async sync() {
        await this.amneziaWg.sync();
        return { response: await this.amneziaWg.list() };
    }
}

@ApiTags('AmneziaWG subscriptions')
@UseFilters(HttpExceptionFilter)
@Controller('amneziawg/subscriptions')
export class AmneziaWgSubscriptionController {
    constructor(private readonly amneziaWg: AmneziaWgService) {}

    @Get(':shortUuid')
    async profiles(@Param('shortUuid') shortUuid: string, @Res() response: Response) {
        return response
            .set('Cache-Control', 'no-store')
            .json({ response: await this.amneziaWg.profiles(shortUuid) });
    }

    @Get(':shortUuid/devices')
    async devices(@Param('shortUuid') shortUuid: string, @Res() response: Response) {
        return response.set('Cache-Control', 'no-store').json({ response: await this.amneziaWg.devices(shortUuid) });
    }

    @Post(':shortUuid/devices')
    async addDevice(@Param('shortUuid') shortUuid: string, @Body() body: CreateAmneziaWgDeviceDto, @Res() response: Response) {
        return response.set('Cache-Control', 'no-store').json({ response: await this.amneziaWg.addDevice(shortUuid, body.name) });
    }

    @Delete(':shortUuid/devices/:uuid')
    async removeDevice(@Param('shortUuid') shortUuid: string, @Param('uuid', ParseUUIDPipe) uuid: string, @Res() response: Response) {
        await this.amneziaWg.removeDevice(shortUuid, uuid);
        return response.set('Cache-Control', 'no-store').json({ response: { success: true } });
    }

    @Get(':shortUuid/:uuid.conf')
    async profile(
        @Param('shortUuid') shortUuid: string,
        @Param('uuid', ParseUUIDPipe) uuid: string,
        @Res() response: Response,
        @Query('device') device?: string,
    ) {
        const profile = await this.amneziaWg.profile(shortUuid, uuid, AmneziaWgDeviceIdSchema.parse(device ?? 'default'));
        return response
            .set({
                'Cache-Control': 'no-store',
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Disposition': `attachment; filename="amneziawg-${uuid}.conf"`,
            })
            .send(profile);
    }
}
