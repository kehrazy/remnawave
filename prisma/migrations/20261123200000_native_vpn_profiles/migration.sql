BEGIN;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS xray_connected BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS xray_connecting BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS xray_last_status_message TEXT;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS xray_last_status_change TIMESTAMP(3);
UPDATE nodes SET xray_connected=is_connected, xray_connecting=is_connecting,
    xray_last_status_message=last_status_message, xray_last_status_change=last_status_change;

ALTER TABLE config_profiles ADD COLUMN IF NOT EXISTS engine VARCHAR(16) NOT NULL DEFAULT 'xray';
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='config_profiles_engine_check') THEN
ALTER TABLE config_profiles ADD CONSTRAINT config_profiles_engine_check CHECK (engine IN ('xray','openvpn','amneziawg'));
END IF; END $$;
ALTER TABLE config_profile_inbounds_to_nodes ADD COLUMN IF NOT EXISTS runtime_uuid UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE config_profile_inbounds_to_nodes ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS config_profile_inbounds_to_nodes_runtime_uuid_key ON config_profile_inbounds_to_nodes(runtime_uuid);

ALTER TABLE config_profile_inbounds ADD COLUMN IF NOT EXISTS relay_target_host_uuid UUID;
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='config_profile_inbounds_relay_target_host_uuid_fkey') THEN
ALTER TABLE config_profile_inbounds ADD CONSTRAINT config_profile_inbounds_relay_target_host_uuid_fkey FOREIGN KEY(relay_target_host_uuid) REFERENCES hosts(uuid) ON DELETE RESTRICT ON UPDATE CASCADE;
END IF; END $$;

ALTER TABLE openvpn_endpoints DROP CONSTRAINT openvpn_endpoints_node_uuid_fkey;
ALTER TABLE openvpn_endpoints ADD CONSTRAINT openvpn_endpoints_node_uuid_fkey FOREIGN KEY(node_uuid) REFERENCES nodes(uuid) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE openvpn_endpoints DROP CONSTRAINT openvpn_endpoints_relay_target_uuid_fkey;
ALTER TABLE openvpn_endpoints ADD CONSTRAINT openvpn_endpoints_relay_target_uuid_fkey FOREIGN KEY(relay_target_uuid) REFERENCES openvpn_endpoints(uuid) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE amneziawg_endpoints DROP CONSTRAINT amneziawg_endpoints_node_uuid_fkey;
ALTER TABLE amneziawg_endpoints ADD CONSTRAINT amneziawg_endpoints_node_uuid_fkey FOREIGN KEY(node_uuid) REFERENCES nodes(uuid) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE amneziawg_endpoints DROP CONSTRAINT amneziawg_endpoints_relay_target_uuid_fkey;
ALTER TABLE amneziawg_endpoints ADD CONSTRAINT amneziawg_endpoints_relay_target_uuid_fkey FOREIGN KEY(relay_target_uuid) REFERENCES amneziawg_endpoints(uuid) ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
DECLARE
    service TEXT;
    machine RECORD;
    endpoint RECORD;
    source JSONB;
    listener JSONB;
    profile_id UUID;
    profile_name TEXT;
    listeners JSONB;
    access_squads UUID[];
    compatibility_squad UUID;
BEGIN
    IF EXISTS (SELECT 1 FROM users u WHERE NOT EXISTS (SELECT 1 FROM internal_squad_members m WHERE m.user_id=u.id)) THEN
        compatibility_squad := gen_random_uuid();
        INSERT INTO internal_squads(uuid, name, updated_at) VALUES (compatibility_squad, 'Imported VPN access ' || left(compatibility_squad::text,8), now());
        INSERT INTO internal_squad_members(internal_squad_uuid, user_id)
        SELECT compatibility_squad, u.id FROM users u WHERE NOT EXISTS (SELECT 1 FROM internal_squad_members m WHERE m.user_id=u.id);
    END IF;
    FOREACH service IN ARRAY ARRAY['openvpn', 'amneziawg'] LOOP
        FOR machine IN EXECUTE format('SELECT DISTINCT n.uuid,n.name FROM nodes n JOIN %I e ON e.node_uuid=n.uuid', service || '_endpoints') LOOP
            profile_id := gen_random_uuid();
            profile_name := left(machine.name,19) || '-' || upper(service);
            IF EXISTS (SELECT 1 FROM config_profiles WHERE name=profile_name) THEN profile_name := upper(service) || '-' || left(machine.uuid::text,8); END IF;
            listeners := '[]'::jsonb;
            INSERT INTO config_profiles(uuid,name,engine,config,updated_at) VALUES (profile_id,profile_name,service,'{}'::jsonb,now());
            FOR endpoint IN EXECUTE format('SELECT * FROM %I WHERE node_uuid=$1 ORDER BY created_at,uuid',service || '_endpoints') USING machine.uuid LOOP
                source := to_jsonb(endpoint);
                listener := jsonb_build_object('type',service,'tag',service || '_' || replace(endpoint.uuid::text,'-',''),
                    'port',endpoint.port,'mode',CASE WHEN endpoint.relay_target_uuid IS NULL THEN 'server' ELSE 'relay' END,
                    'relayTargetUuid',endpoint.relay_target_uuid,'network',endpoint.network,'dnsServers',endpoint.dns_servers,'egressAddress',endpoint.egress_address);
                IF service='openvpn' THEN
                    listener := listener || jsonb_build_object('transport',source->'protocol','controlChannel',source->'control_channel','udpMask',source->'udp_mask');
                ELSE
                    listener := listener || jsonb_build_object('generation',source->'generation','preset',source->'preset','parameters',source->'parameters');
                END IF;
                IF endpoint.relay_target_uuid IS NOT NULL THEN
                    listener := jsonb_build_object('type',service,'tag',listener->>'tag','port',endpoint.port,'mode','relay','relayTargetUuid',endpoint.relay_target_uuid);
                ELSE
                    listener := listener - 'relayTargetUuid';
                END IF;
                listeners := listeners || jsonb_build_array(listener);
                INSERT INTO config_profile_inbounds(uuid,profile_uuid,tag,type,network,security,port,raw_inbound)
                    VALUES(endpoint.uuid,profile_id,listener->>'tag',service,CASE WHEN service='openvpn' THEN source->>'protocol' ELSE 'udp' END,
                        CASE WHEN service='openvpn' THEN 'tls' ELSE 'wireguard' END,endpoint.port,listener);
                INSERT INTO config_profile_inbounds_to_nodes(config_profile_inbound_uuid,node_uuid,runtime_uuid,is_disabled)
                    VALUES(endpoint.uuid,machine.uuid,endpoint.uuid,endpoint.is_disabled);
                INSERT INTO hosts(uuid,remark,address,port,is_disabled,config_profile_uuid,config_profile_inbound_uuid)
                    VALUES(endpoint.uuid,endpoint.name,endpoint.address,endpoint.port,endpoint.is_disabled,profile_id,endpoint.uuid);
                INSERT INTO hosts_to_nodes(host_uuid,node_uuid) VALUES(endpoint.uuid,machine.uuid);
                access_squads := endpoint.internal_squad_uuids;
                IF endpoint.relay_target_uuid IS NOT NULL THEN
                    EXECUTE format('SELECT internal_squad_uuids FROM %I WHERE uuid=$1',service || '_endpoints') INTO access_squads USING endpoint.relay_target_uuid;
                END IF;
                INSERT INTO internal_squad_inbounds(internal_squad_uuid,inbound_uuid)
                    SELECT uuid,endpoint.uuid FROM internal_squads WHERE cardinality(access_squads)=0 OR uuid=ANY(access_squads);
            END LOOP;
            UPDATE config_profiles SET config=jsonb_build_object('inbounds',listeners) WHERE uuid=profile_id;
        END LOOP;
    END LOOP;
END $$;

UPDATE config_profile_inbounds SET relay_target_host_uuid=(raw_inbound->>'relayTargetUuid')::uuid WHERE type IN ('openvpn','amneziawg') AND raw_inbound->>'mode'='relay';
COMMIT;
