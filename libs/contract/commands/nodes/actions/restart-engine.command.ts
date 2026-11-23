import { z } from 'zod';

import { NODES_ROUTES, REST_API } from '../../../api';
import { getEndpointDetails } from '../../../constants';
import { VpnEngineSchema } from '../../../models/native-vpn.schema';
import { NodeResponseSchema } from '../node.response';

export namespace RestartNodeEngineCommand {
    export const url = REST_API.NODES.ACTIONS.RESTART_ENGINE;
    export const TSQ_url = url(':uuid', ':engine');
    export const endpointDetails = getEndpointDetails(
        NODES_ROUTES.ACTIONS.RESTART_ENGINE(':uuid', ':engine'),
        'post',
        'Restart a VPN engine',
        { scope: 'restart', kind: 'write' },
    );
    export const RequestParamSchema = z.object({ uuid: z.uuid(), engine: VpnEngineSchema });
    export const ResponseSchema = NodeResponseSchema;
    export type RequestParam = z.infer<typeof RequestParamSchema>;
    export type Response = z.infer<typeof ResponseSchema>;
}
