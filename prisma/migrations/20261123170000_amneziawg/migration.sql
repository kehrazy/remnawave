CREATE TABLE "amneziawg_endpoints" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "node_uuid" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "address" VARCHAR(253) NOT NULL,
    "port" INTEGER NOT NULL CHECK ("port" BETWEEN 1 AND 65535),
    "generation" VARCHAR(3) NOT NULL DEFAULT '3.1' CHECK ("generation" IN ('3.1', '2.0')),
    "preset" VARCHAR(16) NOT NULL DEFAULT 'default' CHECK ("preset" IN ('default', 'mobile')),
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "network" VARCHAR(18) NOT NULL,
    "dns_servers" TEXT[] NOT NULL,
    "egress_address" VARCHAR(15),
    "relay_target_uuid" UUID,
    "internal_squad_uuids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "is_disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amneziawg_endpoints_pkey" PRIMARY KEY ("uuid")
);

CREATE TABLE "amneziawg_devices" (
    "uuid" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" BIGINT NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amneziawg_devices_pkey" PRIMARY KEY ("uuid")
);

CREATE TABLE "amneziawg_user_usage" (
    "node_uuid" UUID NOT NULL,
    "user_id" BIGINT NOT NULL,
    "epoch" UUID NOT NULL,
    "uplink" BIGINT NOT NULL DEFAULT 0,
    "downlink" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "amneziawg_user_usage_pkey" PRIMARY KEY ("node_uuid","user_id")
);

CREATE INDEX "amneziawg_endpoints_relay_target_uuid_idx" ON "amneziawg_endpoints"("relay_target_uuid");

CREATE UNIQUE INDEX "amneziawg_endpoints_node_uuid_port_key" ON "amneziawg_endpoints"("node_uuid", "port");

CREATE UNIQUE INDEX "amneziawg_devices_user_id_name_key" ON "amneziawg_devices"("user_id", "name");

ALTER TABLE "amneziawg_endpoints" ADD CONSTRAINT "amneziawg_endpoints_node_uuid_fkey" FOREIGN KEY ("node_uuid") REFERENCES "nodes"("uuid") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "amneziawg_endpoints" ADD CONSTRAINT "amneziawg_endpoints_relay_target_uuid_fkey" FOREIGN KEY ("relay_target_uuid") REFERENCES "amneziawg_endpoints"("uuid") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "amneziawg_devices" ADD CONSTRAINT "amneziawg_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "amneziawg_user_usage" ADD CONSTRAINT "amneziawg_user_usage_node_uuid_fkey" FOREIGN KEY ("node_uuid") REFERENCES "nodes"("uuid") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "amneziawg_user_usage" ADD CONSTRAINT "amneziawg_user_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

