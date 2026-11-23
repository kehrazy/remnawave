import { RestartNodeCommand, RestartNodeEngineCommand } from '@contract/commands';
import { createZodDto } from 'nestjs-zod';

export class RestartNodeParamDto extends createZodDto(RestartNodeCommand.RequestParamSchema) {}
export class RestartNodeBodyDto extends createZodDto(RestartNodeCommand.RequestBodySchema) {}

export class RestartNodeEngineParamDto extends createZodDto(
    RestartNodeEngineCommand.RequestParamSchema,
) {}
