CREATE TABLE "openvpn_endpoints" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "node_uuid" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "address" VARCHAR(253) NOT NULL,
    "port" INTEGER NOT NULL CHECK ("port" BETWEEN 1 AND 65535),
    "protocol" VARCHAR(3) NOT NULL CHECK ("protocol" IN ('udp', 'tcp')),
    "control_channel" VARCHAR(16) NOT NULL CHECK ("control_channel" IN ('none', 'tls-auth', 'tls-crypt', 'tls-crypt-v2')),
    "udp_mask" VARCHAR(16) NOT NULL DEFAULT 'none' CHECK ("udp_mask" IN ('none', 'random', 'strong', 'error-free')),
    "network" VARCHAR(18) NOT NULL,
    "dns_servers" TEXT[] NOT NULL,
    "egress_address" VARCHAR(15),
    "relay_target_uuid" UUID,
    "internal_squad_uuids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "is_disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "openvpn_endpoints_pkey" PRIMARY KEY ("uuid"),
    CONSTRAINT "openvpn_endpoints_node_uuid_fkey" FOREIGN KEY ("node_uuid") REFERENCES "nodes"("uuid") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "openvpn_endpoints_relay_target_uuid_fkey" FOREIGN KEY ("relay_target_uuid") REFERENCES "openvpn_endpoints"("uuid") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "openvpn_endpoints_node_uuid_protocol_port_key" ON "openvpn_endpoints"("node_uuid", "protocol", "port");
CREATE INDEX "openvpn_endpoints_relay_target_uuid_idx" ON "openvpn_endpoints"("relay_target_uuid");
CREATE TABLE "openvpn_user_usage" (
    "node_uuid" UUID NOT NULL,
    "user_id" BIGINT NOT NULL,
    "epoch" UUID NOT NULL,
    "uplink" BIGINT NOT NULL DEFAULT 0,
    "downlink" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "openvpn_user_usage_pkey" PRIMARY KEY ("node_uuid", "user_id"),
    CONSTRAINT "openvpn_user_usage_node_uuid_fkey" FOREIGN KEY ("node_uuid") REFERENCES "nodes"("uuid") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "openvpn_user_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
